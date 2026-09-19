import {
  type Mode, type ModeConfig, isMode, WORD_LENGTH, roundConfig, ROUND_CONFIGS,
  evaluate, isSolved, normalize, type Tile,
  scoreRound, compareStandings, assertAttemptsDominate, type Standing,
  TICK_MS, tickMsFor, EXACT_RANK_LIMIT, CUT_RANKS, SPY_N,
  HEARTBEAT_MS, GUESS_COOLDOWN_MS, TOP_N, PAGE_MAX, PROTOCOL_VERSION,
  encodeTickShared, spliceMe,
  type ClientMessage, type ServerMessage, type Phase, type RoomSnapshot,
  type RowWire, type FeedWire,
} from '@arena/core';
import { isValidGuess, drawAnswers } from '@arena/core/dict';

// Loud at isolate start rather than silently mis-ranking a live room. Over
// ROUND_CONFIGS, not MODES: a MISTO rung governs real rounds and is not an
// entry of MODES, so checking MODES alone would leave four formats unproven.
for (const cfg of ROUND_CONFIGS) assertAttemptsDominate(cfg);

const COUNTDOWN_MS = 5_000;
const INTERMISSION_MS = 8_000;
/** With two or more players and an idle host, the room starts itself. */
const AUTOSTART_MS = 30_000;
const DEFAULT_ROUNDS = 5;
const MAX_NAME = 16;

/**
 * Per-player state, stored on the socket via serializeAttachment.
 *
 * This is the load-bearing decision of the whole file. WebSocket Hibernation
 * lets one room hold thousands of connections without paying for idle compute,
 * but hibernating DISCARDS the Durable Object's in-memory state while keeping
 * the sockets alive. Anything kept only in a Map is gone the moment the room
 * goes quiet between rounds. Attachments survive, so the socket carries its own
 * player, and the room rebuilds itself from `getWebSockets()` on wake.
 *
 * Tiles are deliberately absent: they are recomputed from `guesses` and the
 * round answers, which keeps every attachment far below the 2 KB ceiling even
 * in QUARTETO (9 guesses x 5 chars).
 */
interface Attached {
  id: string;
  name: string;
  /** Normalized guesses submitted this round. */
  guesses: string[];
  /** Which boards this player has cracked this round. */
  solved: boolean[];
  /** Cumulative match score. */
  score: number;
  /** Score earned in the current round only. */
  roundScore: number;
  /** Consecutive fully-solved rounds. */
  streak: number;
  /** Cumulative guesses across the match, used as the ranking tiebreak. */
  totalGuesses: number;
  /** ms from round start to last solve; round length when unsolved. */
  timeMs: number;
  /** Cumulative time, the final tiebreak. */
  totalTimeMs: number;
  /** Round index this attachment's round fields belong to. */
  round: number;
  lastGuessAt: number;
}

interface Persisted {
  code: string;
  seed: string;
  mode: Mode;
  phase: Phase;
  round: number;
  rounds: number;
  deadline: number;
  hostId: string | null;
  answers: string[];
  /** Set when 2+ players are present in lobby, drives auto-start. */
  quorumAt: number;
  /**
   * True only for a room somebody deliberately opened. See `fetch`: a Durable
   * Object exists for any code that gets addressed, so this flag — not the
   * object — is what tells a typist their room is not real.
   */
  created: boolean;
}

/** What actually comes back from storage: rooms predating `created` lack it. */
type StoredMeta = Omit<Persisted, 'created'> & { created?: boolean };

export class Room implements DurableObject {
  private readonly state: DurableObjectState;
  private meta!: Persisted;
  private loaded = false;

  /** Rebuilt from socket attachments; never the source of truth across hibernation. */
  private cache = new Map<WebSocket, Attached>();
  private dirty = true;
  private lastEmit = 0;
  private feed: FeedWire[] = [];
  private ranks = new Map<string, number>();
  private order: Standing[] = [];
  /** Who held rank 1 at the last recompute, so a change can be announced once. */
  private leaderId: string | null = null;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<StoredMeta>('meta');
      this.meta = stored
        // A stored room without the flag is grandfathered in. Erring permissive
        // is deliberate: telling someone their real room does not exist is a
        // worse failure than one legacy typo'd room still resolving.
        ? { ...stored, created: stored.created ?? true }
        : {
            code: 'SALA', seed: crypto.randomUUID(), mode: 'termo', phase: 'lobby',
            round: 0, rounds: DEFAULT_ROUNDS, deadline: 0, hostId: null, answers: [],
            quorumAt: 0, created: false,
          };
      this.rehydrate();
      this.loaded = true;
    });
  }

  /** Reconstructs the player table from the sockets that survived hibernation. */
  private rehydrate(): void {
    this.cache.clear();
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attached | null;
      if (a) this.cache.set(ws, a);
    }
    this.dirty = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put('meta', this.meta);
  }

  private attach(ws: WebSocket, a: Attached): void {
    ws.serializeAttachment(a);
    this.cache.set(ws, a);
  }

  /* ------------------------------------------------------------------ lifecycle */

  async fetch(req: Request): Promise<Response> {
    if (!this.loaded) return new Response('starting', { status: 503 });
    const url = new URL(req.url);

    // A Durable Object springs into existence the moment anyone addresses it,
    // so typing A7X9 for A7XQ used to hand the typist a pristine lobby that
    // looks exactly like the room they meant to join — same code in the header,
    // host badge and all, and their friends never arrive. Existence therefore
    // cannot answer "does this room exist"; a flag only the create path sets is.
    //
    // ?new=1 is that path. It is a query parameter because the worker forwards
    // the client's search string to us untouched, so this needs no change in
    // index.ts. Contract for apps/web: the client that just minted a code
    // connects with ?new=1; a client joining an existing code GETs /info first
    // and shows "sala não existe" when `created` is false, instead of
    // connecting and materialising the ghost.
    if (url.searchParams.get('new') === '1' && !this.meta.created) {
      this.meta.created = true;
      await this.save();
    }

    if (url.pathname.endsWith('/info')) {
      return Response.json({ ...this.snapshot(), created: this.meta.created, now: Date.now() });
    }
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const code = url.searchParams.get('code');
    if (code && this.meta.code !== code) {
      this.meta.code = code;
      await this.save();
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation-aware accept: the room can sleep with these still open.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.send(ws, { t: 'error', code: 'bad-json', message: 'mensagem ilegível' });
    }
    try {
      await this.handle(ws, msg);
    } catch (err) {
      this.send(ws, { t: 'error', code: 'internal', message: String((err as Error)?.message ?? err) });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const gone = this.cache.get(ws);
    this.cache.delete(ws);
    this.dirty = true;

    if (gone) {
      this.pushFeed(['out', gone.name, this.cache.size]);
      // Host was only ever reassigned on the next join, which a two-person
      // lobby does not get: the host drops, the survivor cannot start, and
      // autostart needs two players. The room just sits there.
      //
      // `hasPlayer` guards the reconnect race — the dropped socket's close can
      // land after the same player is already back on a new one, and demoting
      // them for their own reconnect would be wrong.
      if (this.meta.hostId === gone.id && !this.hasPlayer(gone.id)) {
        // Insertion order is the only ordering the room keeps, so the first
        // entry is the earliest socket still attached.
        const next = this.cache.values().next();
        this.meta.hostId = next.done ? null : next.value.id;
        await this.save();
        this.broadcastState();
      }
    }
    await this.maybeScheduleAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.cache.delete(ws);
    this.dirty = true;
  }

  /* ------------------------------------------------------------------ messages */

  private async handle(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case 'join':    return this.onJoin(ws, msg);
      case 'guess':   return this.onGuess(ws, msg);
      case 'config':  return this.onConfig(ws, msg);
      case 'start':   return this.onStart(ws);
      case 'page':    return this.onPage(ws, msg);
      case 'ping':    return this.send(ws, { t: 'pong', ts: msg.ts, now: Date.now() });
    }
  }

  private async onJoin(ws: WebSocket, msg: Extract<ClientMessage, { t: 'join' }>): Promise<void> {
    if (msg.v !== PROTOCOL_VERSION) {
      return this.send(ws, { t: 'error', code: 'version', message: 'recarregue a página — versão do protocolo mudou' });
    }
    const name = sanitizeName(msg.name);
    const id = typeof msg.clientId === 'string' && msg.clientId.length >= 8
      ? msg.clientId.slice(0, 40) : crypto.randomUUID();

    // A reconnect always arrives on a NEW WebSocket object, so the socket can
    // never be the key that finds the player again — only clientId can, and it
    // was being used for nothing but minting an id. The old lookup therefore
    // never matched: a three-second tunnel silently minted a fresh player with
    // guesses, score, streak and totalGuesses back to zero, and the `state`
    // frame sent below overwrote the board still on the player's screen.
    // net.ts promises the opposite — "costs you position but not progress" —
    // so this is the code catching up with the promise.
    const prior = this.evictById(id, ws);

    const cfg = this.roundCfg();
    const a: Attached = prior ?? {
      id, name, guesses: [], solved: new Array(cfg.boards).fill(false),
      score: 0, roundScore: 0, streak: 0, totalGuesses: 0,
      timeMs: 0, totalTimeMs: 0, round: this.meta.round, lastGuessAt: 0,
    };
    if (prior && prior.round !== this.meta.round) {
      // Back after a round boundary. Match totals — score, streak, totalGuesses,
      // totalTimeMs — are exactly what must survive; the per-round fields
      // describe a round that is over. `solved` is rebuilt rather than cleared
      // in place because in MISTO the round they left was not the same shape as
      // this one.
      a.guesses = [];
      a.solved = new Array(cfg.boards).fill(false);
      a.roundScore = 0;
      a.timeMs = 0;
      a.lastGuessAt = 0;
      a.round = this.meta.round;
    }
    a.name = name;
    this.attach(ws, a);

    if (!this.meta.hostId || !this.hasPlayer(this.meta.hostId)) {
      this.meta.hostId = a.id;
      await this.save();
    }
    if (this.meta.phase === 'lobby' && this.cache.size >= 2 && this.meta.quorumAt === 0) {
      this.meta.quorumAt = Date.now();
      await this.save();
    }

    // A reconnect is not an arrival. Announcing it would let one flaky
    // connection fill the feed with its own name.
    if (!prior) this.pushFeed(['join', a.name, this.cache.size]);
    this.send(ws, {
      t: 'welcome',
      you: { id: a.id, name: a.name, isHost: a.id === this.meta.hostId },
      room: this.snapshot(),
      now: Date.now(),
    });
    this.send(ws, { t: 'state', room: this.snapshot(), board: this.boardOf(a), now: Date.now() });
    this.dirty = true;
    await this.maybeScheduleAlarm();
  }

  private async onGuess(ws: WebSocket, msg: Extract<ClientMessage, { t: 'guess' }>): Promise<void> {
    const a = this.cache.get(ws);
    if (!a) return;
    const cfg = this.roundCfg();
    const seq = Number(msg.seq) || 0;

    if (this.meta.phase !== 'playing') {
      return this.send(ws, { t: 'result', seq, ok: false, reason: 'closed' });
    }
    const now = Date.now();
    if (now - a.lastGuessAt < GUESS_COOLDOWN_MS) {
      return this.send(ws, { t: 'result', seq, ok: false, reason: 'too-fast' });
    }
    if (this.isFinished(a, cfg)) {
      return this.send(ws, { t: 'result', seq, ok: false, reason: 'closed' });
    }

    const word = normalize(String(msg.word ?? ''));
    if (word.length !== WORD_LENGTH || !isValidGuess(word)) {
      a.lastGuessAt = now;
      this.attach(ws, a);
      return this.send(ws, { t: 'result', seq, ok: false, reason: 'unknown-word' });
    }
    if (a.guesses.includes(word)) {
      return this.send(ws, { t: 'result', seq, ok: false, reason: 'duplicate' });
    }

    a.lastGuessAt = now;
    a.guesses.push(word);
    a.totalGuesses += 1;

    const tiles: Tile[][] = [];
    for (let b = 0; b < cfg.boards; b++) {
      const answer = this.meta.answers[b] ?? '';
      const row = evaluate(word, answer);
      tiles.push(row);
      if (!a.solved[b] && isSolved(row)) {
        a.solved[b] = true;
        this.pushFeed(['solve', a.name, a.guesses.length]);
      }
    }

    const roundStart = this.meta.deadline - cfg.roundMs;
    const solvedCount = a.solved.filter(Boolean).length;
    const done = this.isFinished(a, cfg);
    if (done) {
      a.timeMs = Math.max(0, Math.min(cfg.roundMs, now - roundStart));
      const rs = scoreRound(
        { wordsSolved: solvedCount, guessesUsed: a.guesses.length, elapsedMs: a.timeMs, streakBefore: a.streak },
        cfg,
      );
      // Replace rather than add: a player only finishes a round once.
      a.score = a.score - a.roundScore + rs.total;
      a.roundScore = rs.total;
      a.totalTimeMs += a.timeMs;
      if (rs.fullSolve && rs.perfect > 0) this.pushFeed(['perfect', a.name, a.guesses.length]);
    }

    this.attach(ws, a);
    this.dirty = true;

    // Rank comes from the last tick, not from a fresh sort.
    //
    // Sorting here looks harmless and is not: at 3000 players and ~730 guesses
    // a second it is ~730 sorts of 3000 rows per second, and it was measured
    // moving guess p95 from 105 ms to 310 ms. The figure is at most one tick
    // stale, which is exactly how stale the table the player is looking at
    // already is — and the next tick corrects it either way.
    this.send(ws, {
      t: 'result', seq, ok: true, word, tiles, solved: [...a.solved],
      guessesUsed: a.guesses.length, finished: done, score: a.score,
      rank: this.ranks.get(a.id) ?? 0,
    });

    // Everyone done early ends the round instead of staring at a dead clock.
    if (this.everyoneFinished(cfg)) await this.endRound();
  }

  private async onConfig(ws: WebSocket, msg: Extract<ClientMessage, { t: 'config' }>): Promise<void> {
    const a = this.cache.get(ws);
    if (!a || a.id !== this.meta.hostId) {
      return this.send(ws, { t: 'error', code: 'not-host', message: 'só quem criou a sala muda a configuração' });
    }
    if (this.meta.phase !== 'lobby' && this.meta.phase !== 'finished') {
      return this.send(ws, { t: 'error', code: 'locked', message: 'a partida já começou' });
    }
    if (msg.mode && isMode(msg.mode)) this.meta.mode = msg.mode;
    if (typeof msg.rounds === 'number') this.meta.rounds = Math.max(1, Math.min(20, Math.round(msg.rounds)));
    await this.save();
    this.broadcastState();
  }

  private async onStart(ws: WebSocket): Promise<void> {
    const a = this.cache.get(ws);
    if (!a || a.id !== this.meta.hostId) {
      return this.send(ws, { t: 'error', code: 'not-host', message: 'só quem criou a sala pode começar' });
    }
    if (this.meta.phase === 'playing' || this.meta.phase === 'countdown') return;
    await this.beginMatch();
  }

  private onPage(ws: WebSocket, msg: Extract<ClientMessage, { t: 'page' }>): void {
    const from = Math.max(0, Math.min(10_000, Math.floor(msg.from) || 0));
    const to = Math.max(from + 1, Math.min(from + PAGE_MAX, Math.floor(msg.to) || from + 20));
    const me = this.cache.get(ws);
    this.recompute();
    this.send(ws, {
      t: 'page', from, total: this.order.length,
      rows: this.order.slice(from, to).map((s, i) => this.row(s, from + i + 1, me?.id)),
    });
  }

  /* ------------------------------------------------------------------ match flow */

  private async beginMatch(): Promise<void> {
    this.meta.round = 0;
    this.leaderId = null;
    for (const [ws, a] of this.cache) {
      a.score = 0; a.roundScore = 0; a.streak = 0; a.totalGuesses = 0; a.totalTimeMs = 0;
      this.attach(ws, a);
    }
    await this.startCountdown();
  }

  private async startCountdown(): Promise<void> {
    this.meta.phase = 'countdown';
    this.meta.deadline = Date.now() + COUNTDOWN_MS;
    this.meta.quorumAt = 0;
    await this.save();
    this.broadcastState();
    await this.state.storage.setAlarm(this.meta.deadline);
  }

  private async startRound(): Promise<void> {
    // The increment comes first: in MISTO the round number IS the format, so
    // reading the config before bumping it would deal round N the board count,
    // guess budget and clock of round N-1.
    this.meta.round += 1;
    const cfg = this.roundCfg();
    this.meta.phase = 'playing';
    this.meta.answers = drawAnswers(this.meta.seed, this.meta.round, cfg.boards);
    this.meta.deadline = Date.now() + cfg.roundMs;
    await this.save();

    for (const [ws, a] of this.cache) {
      a.guesses = [];
      a.solved = new Array(cfg.boards).fill(false);
      a.roundScore = 0;
      a.timeMs = 0;
      a.round = this.meta.round;
      this.attach(ws, a);
    }
    this.feed = [];
    this.dirty = true;

    const frame: ServerMessage = {
      t: 'roundStart', room: this.snapshot(), boards: cfg.boards, maxGuesses: cfg.maxGuesses, now: Date.now(),
    };
    this.broadcast(JSON.stringify(frame));
    await this.state.storage.setAlarm(Date.now() + TICK_MS);
    this.lastEmit = 0; // force a frame on the first tick of the round
  }

  private async endRound(): Promise<void> {
    const cfg = this.roundCfg();
    // Settle anyone the clock caught mid-round.
    for (const [ws, a] of this.cache) {
      if (a.round !== this.meta.round) continue;
      if (a.roundScore === 0 && !this.isFinished(a, cfg)) {
        const solvedCount = a.solved.filter(Boolean).length;
        a.timeMs = cfg.roundMs;
        const rs = scoreRound(
          { wordsSolved: solvedCount, guessesUsed: a.guesses.length, elapsedMs: a.timeMs, streakBefore: a.streak },
          cfg,
        );
        a.score += rs.total;
        a.roundScore = rs.total;
        a.totalTimeMs += a.timeMs;
      }
      a.streak = a.solved.length > 0 && a.solved.every(Boolean) ? a.streak + 1 : 0;
      this.attach(ws, a);
    }

    this.dirty = true;
    this.recompute();
    const last = this.meta.round >= this.meta.rounds;
    this.meta.phase = last ? 'finished' : 'intermission';
    this.meta.deadline = Date.now() + (last ? 0 : INTERMISSION_MS);
    await this.save();

    const podium = this.order.slice(0, 3).map((s, i) => this.row(s, i + 1));
    for (const [ws, a] of this.cache) {
      this.send(ws, {
        t: 'roundEnd', room: this.snapshot(), answers: [...this.meta.answers],
        you: {
          score: a.score, rank: this.ranks.get(a.id) ?? 0,
          solvedWords: a.solved.filter(Boolean).length, guesses: a.guesses.length, roundScore: a.roundScore,
        },
        podium,
      });
    }

    if (last) {
      const standings = this.order.slice(0, 50).map((s, i) => this.row(s, i + 1));
      for (const [ws, a] of this.cache) {
        this.send(ws, {
          // The words ride here as well as in `roundEnd` because the phase is
          // already 'finished' by now, and the client only reveals on
          // 'intermission' — so the last round of every match, the one people
          // actually talk about afterwards, never showed its answers.
          t: 'matchEnd', room: this.snapshot(), standings,
          answers: [...this.meta.answers],
          you: { rank: this.ranks.get(a.id) ?? 0, score: a.score },
        });
      }
      await this.state.storage.deleteAlarm();
    } else {
      await this.state.storage.setAlarm(this.meta.deadline);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    switch (this.meta.phase) {
      case 'countdown':
        if (now >= this.meta.deadline) return void (await this.startRound());
        return void (await this.state.storage.setAlarm(this.meta.deadline));
      case 'playing':
        if (now >= this.meta.deadline) return void (await this.endRound());
        this.emitTick();
        return void (await this.state.storage.setAlarm(now + tickMsFor(this.cache.size)));
      case 'intermission':
        if (now >= this.meta.deadline) return void (await this.startCountdown());
        return void (await this.state.storage.setAlarm(this.meta.deadline));
      case 'lobby':
        if (this.meta.quorumAt && now - this.meta.quorumAt >= AUTOSTART_MS && this.cache.size >= 2) {
          return void (await this.beginMatch());
        }
        return void (await this.maybeScheduleAlarm());
      default:
        return;
    }
  }

  private async maybeScheduleAlarm(): Promise<void> {
    if (this.meta.phase !== 'lobby') return;
    const pending = await this.state.storage.getAlarm();
    if (pending !== null) return;
    if (this.meta.quorumAt && this.cache.size >= 2) {
      await this.state.storage.setAlarm(this.meta.quorumAt + AUTOSTART_MS);
    }
  }

  /* ------------------------------------------------------------------ fan-out */

  /**
   * One frame per tick, serialized ONCE and given a per-socket personal suffix
   * by string splice.
   *
   * This is the difference between a room that holds a thousand players and one
   * that melts. Broadcasting on every guess would be ~66 inbound messages per
   * second times a thousand recipients — 66k sends/s. Instead mutations
   * accumulate and leave as at most two frames per second, and the frame is
   * kept near 700 bytes by shipping only the top rows plus aggregates. A
   * player's exact rank rides in the personal suffix, so nobody needs their own
   * JSON.stringify of the whole object.
   *
   * The frame is skipped entirely when nothing changed. Clients run their own
   * countdown from `deadline`, so a quiet room costs zero bandwidth instead of
   * a clock tick per player per second.
   */
  private emitTick(): void {
    const now = Date.now();
    const stale = now - this.lastEmit >= HEARTBEAT_MS;
    if (!this.dirty && !stale) return;
    this.recompute();

    const cfg = this.roundCfg();
    const hist = new Array(cfg.maxGuesses).fill(0) as number[];
    let solved = 0;
    for (const a of this.cache.values()) {
      if (a.round !== this.meta.round) continue;
      if (a.solved.length > 0 && a.solved.every(Boolean)) {
        solved++;
        const k = Math.min(cfg.maxGuesses, Math.max(1, a.guesses.length)) - 1;
        hist[k] = (hist[k] ?? 0) + 1;
      }
    }

    const big = this.cache.size > EXACT_RANK_LIMIT;
    const shared = encodeTickShared({
      t: 'tick', now, online: this.cache.size, solved, hist,
      top: this.order.slice(0, TOP_N).map((s, i) => this.row(s, i + 1)),
      feed: this.feed.slice(-3),
      spy: this.spyBoards(),
      // A big room drops the per-socket splice; everyone locates themselves
      // against the ladder instead. See EXACT_RANK_LIMIT.
      ...(big ? { cuts: this.cuts() } : {}),
    });

    if (big) {
      // One buffer, N sends: no per-player allocation at all.
      for (const [ws] of this.cache) {
        try { ws.send(shared); } catch { this.cache.delete(ws); }
      }
    } else {
      for (const [ws, a] of this.cache) {
        try {
          ws.send(spliceMe(shared, [this.ranks.get(a.id) ?? 0, a.score, a.guesses.length]));
        } catch {
          this.cache.delete(ws);
        }
      }
    }
    this.feed = [];
    this.dirty = false;
    this.lastEmit = now;
  }

  /**
   * Score at each sampled rank, so a client in a large room can place itself
   * without the room addressing it individually. Truncated to the ranks that
   * actually exist, which is also what keeps the field small in small rooms.
   */
  private cuts(): number[] {
    const out: number[] = [];
    for (const r of CUT_RANKS) {
      if (r > this.order.length) break;
      out.push(this.order[r - 1]!.score);
    }
    return out;
  }

  /**
   * The leaders' first board, as tile digits.
   *
   * Recomputed from stored guesses rather than kept around, which is the same
   * reason tiles never enter an attachment. Only board 1 travels: mirroring all
   * four in QUARTETO would quadruple the field for a strip nobody reads that
   * closely.
   */
  private spyBoards(): [string, string][] {
    if (this.meta.phase !== 'playing') return [];
    const answer = this.meta.answers[0];
    if (!answer) return [];
    const byId = new Map<string, Attached>();
    for (const a of this.cache.values()) byId.set(a.id, a);

    const out: [string, string][] = [];
    for (const s of this.order.slice(0, SPY_N)) {
      const a = byId.get(s.id);
      if (!a) continue;
      let packed = '';
      for (const g of a.guesses) packed += evaluate(g, answer).join('');
      out.push([s.id.slice(0, 8), packed]);
    }
    return out;
  }

  /** Re-sorts only when something actually moved. */
  private recompute(): void {
    if (!this.dirty && this.order.length === this.cache.size && this.order.length > 0) return;
    const rows: Standing[] = [];
    for (const a of this.cache.values()) {
      rows.push({
        id: a.id, name: a.name, score: a.score, guesses: a.totalGuesses,
        solvedWords: a.solved.filter(Boolean).length, timeMs: a.totalTimeMs, streak: a.streak,
      });
    }
    rows.sort(compareStandings);
    this.order = rows;
    this.ranks = new Map(rows.map((r, i) => [r.id, i + 1]));

    // 'lead' has been in the protocol since day one and was never emitted, even
    // though order[0] is computed right here every tick. Scoreless leaders are
    // skipped: at the first tick of a round the whole room is on zero and the
    // "leader" is whoever won the id tiebreak, which is not news.
    const lead = rows[0];
    if (this.meta.phase === 'playing' && lead && lead.score > 0 && lead.id !== this.leaderId) {
      this.leaderId = lead.id;
      this.pushFeed(['lead', lead.name, lead.score]);
    }
  }

  /**
   * `youId` is only ever passed on unicast replies. The tick frame is
   * serialized once for the whole room, so it CANNOT carry a per-recipient
   * "this row is you" flag — the client decides that by matching the id prefix
   * against its own. Setting the flag here for a broadcast would mark the same
   * row as "you" for a thousand people.
   */
  private row(s: Standing, rank: number, youId?: string): RowWire {
    // Only a prefix of the id travels: enough to key a row, useless to anyone
    // trying to impersonate a player.
    return [rank, s.id.slice(0, 8), s.name, s.score, s.guesses, s.solvedWords, s.id === youId ? 1 : 0];
  }

  private pushFeed(entry: FeedWire): void {
    this.feed.push(entry);
    if (this.feed.length > 8) this.feed.shift();
    this.dirty = true;
  }

  private broadcastState(): void {
    for (const [ws, a] of this.cache) {
      this.send(ws, { t: 'state', room: this.snapshot(), board: this.boardOf(a), now: Date.now() });
    }
  }

  private broadcast(payload: string): void {
    for (const [ws] of this.cache) {
      try { ws.send(payload); } catch { this.cache.delete(ws); }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { this.cache.delete(ws); }
  }

  /* ------------------------------------------------------------------ helpers */

  private snapshot(): RoomSnapshot {
    const cfg = this.roundCfg();
    return {
      code: this.meta.code, mode: this.meta.mode, phase: this.meta.phase,
      round: this.meta.round, rounds: this.meta.rounds,
      online: this.cache.size, deadline: this.meta.deadline, hostId: this.meta.hostId,
      cfg: { b: cfg.boards, g: cfg.maxGuesses, l: cfg.label },
    };
  }

  /**
   * The config governing the round in progress — the single place this file
   * asks what shape the game currently is.
   *
   * Board count, guess budget and clock all used to be read straight off
   * MODES[mode] at half a dozen call sites. In MISTO all three change between
   * rounds, so any site left reading the mode directly sizes a `solved` array,
   * a histogram or a finish check for the wrong format, silently and only in
   * that one mode. Route everything through here.
   */
  private roundCfg(): ModeConfig {
    return roundConfig(this.meta.mode, this.meta.round);
  }

  /**
   * Hands back the attachment already held for `id`, unregistering the socket
   * that held it.
   *
   * The eviction is the point, not housekeeping. Until the old socket's close
   * event lands the room holds the same player twice: `online` double-counts,
   * recompute emits two Standings under one id — two leaderboard rows sharing a
   * React key — and the player receives every frame twice.
   */
  private evictById(id: string, keep: WebSocket): Attached | undefined {
    for (const [ws, a] of this.cache) {
      if (a.id !== id) continue;
      this.cache.delete(ws);
      if (ws !== keep) {
        // 4001, not 1000. The evicted client has to be able to TELL this
        // apart from a network drop, because its reaction must be the
        // opposite: a dropped socket should reconnect, and a socket that was
        // taken over must not. Two tabs of the same browser share a clientId
        // through localStorage, so with an indistinguishable close they evict
        // each other roughly once a second, forever — measured in production
        // at 28 reconnects in 40 seconds, each one wiping the player's
        // half-typed word.
        try { ws.close(4001, 'takeover'); } catch { /* already gone */ }
      }
      return a;
    }
    return undefined;
  }

  /** Recomputes a player's grid from their guesses — tiles are never stored. */
  private boardOf(a: Attached) {
    const cfg = this.roundCfg();
    const reveal = this.meta.phase === 'playing' || this.meta.phase === 'intermission';
    const tiles: Tile[][][] = [];
    for (let b = 0; b < cfg.boards; b++) {
      const answer = reveal ? (this.meta.answers[b] ?? '') : '';
      tiles.push(a.guesses.map((g) => (answer ? evaluate(g, answer) : ([0, 0, 0, 0, 0] as Tile[]))));
    }
    return {
      guesses: [...a.guesses], tiles, solved: [...a.solved],
      finished: this.isFinished(a, cfg), score: a.score, streak: a.streak,
    };
  }

  private isFinished(a: Attached, cfg: { boards: number; maxGuesses: number }): boolean {
    if (a.guesses.length >= cfg.maxGuesses) return true;
    return a.solved.length === cfg.boards && a.solved.every(Boolean);
  }

  private everyoneFinished(cfg: { boards: number; maxGuesses: number }): boolean {
    if (this.cache.size === 0) return false;
    for (const a of this.cache.values()) if (!this.isFinished(a, cfg)) return false;
    return true;
  }

  private hasPlayer(id: string): boolean {
    for (const a of this.cache.values()) if (a.id === id) return true;
    return false;
  }
}

function sanitizeName(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return s.length >= 2 ? s : `anon${Math.floor(Math.random() * 9000 + 1000)}`;
}
