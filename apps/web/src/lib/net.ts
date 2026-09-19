import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@arena/core';

type Listener = (msg: ServerMessage) => void;
type StatusListener = (s: ConnStatus) => void;
export type ConnStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'taken';

/** The room closed us because the same player opened it somewhere else. */
export const TAKEOVER_CODE = 4001;

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

  /** serverNow ≈ Date.now() + offset */
  offset = 0;
  rttMs = 0;
  status: ConnStatus = 'idle';

  constructor(
    private readonly code: string,
    private readonly name: string,
    private readonly clientId: string,
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
    private readonly isNew = false,
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

  connect(): void {
    this.closedByUs = false;
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = this.isNew ? '?new=1' : '';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${encodeURIComponent(this.code)}/ws${q}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      this.send({ t: 'join', name: this.name, clientId: this.clientId, v: PROTOCOL_VERSION });
      // Drain after join, never before: the room has to know who we are first.
      const queued = this.pending;
      this.pending = [];
      for (const m of queued) this.send(m);
      this.send({ t: 'ping', ts: Date.now() });
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 15_000);
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data as string) as ServerMessage; } catch { return; }
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
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }

      // A takeover is not a failure to recover from — reconnecting is exactly
      // the wrong move. The other tab would then be evicted, reconnect in
      // turn, and the two would trade the room forever.
      if (ev.code === TAKEOVER_CODE) {
        this.closedByUs = true;
        this.setStatus('taken');
        return;
      }

      this.setStatus('closed');
      if (this.closedByUs) return;
      const wait = Math.min(8000, 400 * 2 ** this.attempt++) + Math.random() * 250;
      setTimeout(() => this.connect(), wait);
    };

    ws.onerror = () => ws.close();
  }

  /** Take the room back from whatever else claimed it. */
  reclaim(): void {
    this.closedByUs = false;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(msg)); return; }
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
