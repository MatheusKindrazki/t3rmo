import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@arena/core';

type Listener = (msg: ServerMessage) => void;
type StatusListener = (s: ConnStatus) => void;
export type ConnStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'taken';

/** The room closed us because the same player opened it somewhere else. */
export const TAKEOVER_CODE = 4001;
const roomTokens = new Map<string,string>();
export function saveRoomToken(code: string, token: string): void {
  roomTokens.set(code,token);
  try { sessionStorage.setItem(`arena.session.${code}`,token); } catch { /* in-memory fallback */ }
}
export function loadRoomToken(code:string): string | undefined {
  try { return sessionStorage.getItem(`arena.session.${code}`) ?? roomTokens.get(code); } catch { return roomTokens.get(code); }
}

/**
 * Room socket.
 *
 * Two things here exist because of the 1000-player target:
 *
 *  - The server sends no wall clock on most frames; it sends a `deadline`. The
 *    client estimates the offset between the two clocks from ping/pong and runs
 *    its own countdown. A per-second clock broadcast to a thousand sockets
 *    would be pure waste, and a local countdown is smoother anyway.
 *  - Reconnects are expected, not exceptional. A dropped socket rejoins with
 *    the same clientId and the room replays that player's board, so a subway
 *    tunnel costs you position but not progress.
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private attempt = 0;
  private closedByUs = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  /**
   * Messages queued before the socket opened.
   *
   * `send` is a silent no-op while the socket is CONNECTING, and the host's
   * chosen format used to be fired on a 250ms timer after connect. Over the
   * public internet to an edge that may be cold-starting a Durable Object,
   * 250ms is frequently not enough — so the room quietly stayed on the server
   * defaults and the host discovered it when round one dealt the wrong game.
   * Queueing removes the race instead of widening the timer.
   */
  private pending: ClientMessage[] = [];
  private ready = false;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** serverNow ≈ Date.now() + offset */
  offset = 0;
  rttMs = 0;
  status: ConnStatus = 'idle';

  constructor(
    private readonly code: string,
    private readonly name: string,
    _clientId: string,
    /**
     * True only for the socket that opens a freshly minted room.
     *
     * A Durable Object is materialised by name, so `idFromName('A7X9')`
     * happily creates a room for any code — which meant a typo dropped you
     * into a brand-new empty lobby that looked exactly like your friend's, and
     * you waited for people who were in a different room. The server marks a
     * room as real only when this flag arrives, and the join path checks
     * /info before connecting.
     */
    _isNew = false,
  ) {}

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: ConnStatus): void {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  async connect(): Promise<void> {
    if(this.retryTimer) {clearTimeout(this.retryTimer);this.retryTimer=null;}
    this.closedByUs = false;
    const generation=++this.generation;
    this.setStatus('connecting');
    try {
      const response=await fetch(`/api/rooms/${encodeURIComponent(this.code)}/info`,{signal:AbortSignal.timeout(8000),cache:'no-store'});
      if(this.closedByUs || generation !== this.generation) return;
      if(response.status>=500) {this.retry();return;}
      if(!response.ok) {
        const message=response.status===404?'Essa sala não existe ou expirou. Volte ao início para criar outra.':response.status===410?'Essa sala usa uma versão antiga. Crie uma nova sala.':response.status===429?'Muitas tentativas. Aguarde um minuto antes de tentar novamente.':response.status===503?'A sala está indisponível. Tente novamente em instantes.':'Não foi possível entrar. Volte ao início e tente novamente.';
        this.fail(message);return;
      }
      const info=await response.json() as {full?:boolean};
      if(this.closedByUs || generation !== this.generation) return;
      if(info.full){this.fail('A sala está cheia. Tente novamente em instantes.');return;}
    } catch {
      if(this.closedByUs || generation !== this.generation) return;
      this.retry();return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ready = false;
    const q = '';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${encodeURIComponent(this.code)}/ws${q}`);
    this.ws = ws;

    ws.onopen = () => {
      if(this.closedByUs || this.ws !== ws) return;
      this.setStatus('open');
      this.send({ t: 'join', name: this.name, token:loadRoomToken(this.code), v: PROTOCOL_VERSION });
      this.send({ t: 'ping', ts: Date.now() });
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 15_000);
    };

    ws.onmessage = (ev) => {
      if(this.closedByUs || this.ws !== ws) return;
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data as string) as ServerMessage; } catch { return; }
      if (msg.t === 'welcome') {
        this.attempt=0;
        if(msg.token) saveRoomToken(this.code,msg.token);
        this.ready=true;
        const queued=this.pending; this.pending=[];
        for(const m of queued) this.send(m);
      }
      if (msg.t === 'pong') {
        const now = Date.now();
        this.rttMs = now - msg.ts;
        // Assume a symmetric path: the server's clock sat at `now` half an RTT ago.
        this.offset = msg.now + this.rttMs / 2 - now;
        return;
      }
      for (const fn of this.listeners) fn(msg);
    };

    ws.onclose = (ev) => {
      if(this.ws !== ws)return;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }

      // A takeover is not a failure to recover from — reconnecting is exactly
      // the wrong move. The other tab would then be evicted, reconnect in
      // turn, and the two would trade the room forever.
      if (ev.code === TAKEOVER_CODE) {
        this.closedByUs = true;
        this.setStatus('taken');
        return;
      }

      this.ready=false;
      this.setStatus('closed');
      if(ev.code===4003 && ev.reason==='expired') {this.fail('Esta sala expirou. Volte ao início para criar outra.');return;}
      if (ev.code === 4002 || ev.code === 4003 || ev.code === 4008) this.closedByUs=true;
      if (this.closedByUs) return;
      this.retry();
    };

    ws.onerror = () => ws.close();
  }

  private retry(): void {
    if(this.closedByUs)return;
    this.setStatus('closed');
    if(this.attempt>=4){this.fail('Não foi possível reconectar. Confira sua rede e use Reconectar.');return;}
    const wait=Math.min(8000,400*2**this.attempt++)+Math.random()*250;
    if(this.retryTimer)clearTimeout(this.retryTimer);
    this.retryTimer=setTimeout(()=>{if(!this.closedByUs)this.connect();},wait);
  }

  private fail(message:string): void {
    this.closedByUs=true;this.ready=false;this.setStatus('closed');
    for(const fn of this.listeners)fn({t:'error',code:'connection',message});
  }

  /** Take the room back from whatever else claimed it. */
  reclaim(): void {
    if(this.retryTimer) {clearTimeout(this.retryTimer);this.retryTimer=null;}
    this.closedByUs = false;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    this.closedByUs = true;
    this.generation++;
    if(this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.listeners.clear(); this.statusListeners.clear();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN && (this.ready || msg.t === 'join' || msg.t === 'ping')) { this.ws.send(JSON.stringify(msg)); return; }
    // Anything that matters before the socket settles has to wait, not vanish.
    // `guess` is deliberately excluded by the caller: a guess replayed after a
    // reconnect would land in a round that has moved on.
    if (msg.t === 'config' || msg.t === 'start') this.pending.push(msg);
  }

  guess(word: string): number {
    const seq = ++this.seq;
    this.send({ t: 'guess', word, seq });
    return seq;
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }
}

export function loadClientId(): string {
  const KEY = 'arena.cid';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.length >= 8) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private browsing kills storage; a per-session id still plays fine, it
    // just cannot resume a previous socket's board.
    return crypto.randomUUID();
  }
}

export function loadName(): string {
  try { return localStorage.getItem('arena.name') ?? ''; } catch { return ''; }
}
export function saveName(n: string): void {
  try { localStorage.setItem('arena.name', n); } catch { /* ignore */ }
}
