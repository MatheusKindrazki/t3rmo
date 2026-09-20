import WebSocket from 'ws';
#!/usr/bin/env node
/**
 * One slice of the bot fleet, in its own process.
 *
 * Forked by `loadtest.mjs`; never run directly. The worker owns bots
 * [from, to) of a globally-numbered fleet, and every scheduling decision is
 * made from the GLOBAL index against a clock the coordinator handed down, so
 * the ramp is one smooth curve across the whole fleet instead of N overlapping
 * curves that all stampede at t=0.
 *
 * It reports counters upward on an interval and ships merged histograms once,
 * at the end. Shipping a million raw latencies over IPC every second would
 * make the harness the thing under load.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadPool, evaluate, sameTiles, Hist } from './loadtest-shared.mjs';

const POOL = loadPool();

/**
 * Bot skill. The default fleet solves in 2-4 like an expert, which is great for
 * a load test but reads as inhuman in a demo room. A level tunes four dials:
 *   mistake — chance a guess ignores the deduced candidates (a wild word), which
 *             both wastes an attempt and dents the solve rate, like a real player
 *             who stops reasoning;
 *   think   — how long before submitting (base + random), so weaker players are
 *             visibly slower on the clock;
 *   quit    — per-guess chance of walking away mid-round (AFK / rage-quit);
 *   optimal — chance of playing an information-maximising guess instead of a
 *             random consistent one, which closes faster (the "pro").
 */
const SKILLS = {
  iniciante: { mistake: 0.40, thinkBase: 1800, thinkRand: 3800, quit: 0.020, optimal: 0    },
  casual:    { mistake: 0.20, thinkBase: 1200, thinkRand: 3000, quit: 0.006, optimal: 0    },
  bom:       { mistake: 0.05, thinkBase: 800,  thinkRand: 2400, quit: 0,     optimal: 0    },
  pro:       { mistake: 0,    thinkBase: 450,  thinkRand: 1300, quit: 0,     optimal: 0.85 },
};

/** Pick a level for bot `i`. `mix` spreads a realistic crowd across the fleet. */
function skillFor(iq, i) {
  if (iq && iq !== 'mix') return SKILLS[iq] || SKILLS.bom;
  // A cheap deterministic hash so a mix is evenly interleaved, not clustered.
  const r = ((i * 2654435761) >>> 0) % 100;
  if (r < 15) return SKILLS.iniciante;
  if (r < 55) return SKILLS.casual;
  if (r < 88) return SKILLS.bom;
  return SKILLS.pro;
}

/**
 * The guess that splits the remaining candidates hardest: among a small sample
 * it maximises distinct feedback patterns, so it eliminates the most on average.
 * Sampled and capped because this runs per guess per bot across the whole fleet.
 */
function bestSplit(cands) {
  const guesses = cands.length > 24 ? sample(cands, 24) : cands;
  const answers = cands.length > 24 ? sample(cands, 24) : cands;
  let best = guesses[0], bestScore = -1;
  for (const g of guesses) {
    const seen = new Set();
    for (const ans of answers) seen.add(evaluate(g, ans).join(''));
    if (seen.size > bestScore) { bestScore = seen.size; best = g; }
  }
  return best;
}

function sample(arr, k) {
  const out = [];
  for (let j = 0; j < k; j++) out.push(arr[(Math.random() * arr.length) | 0]);
  return out;
}

/**
 * Event-loop lag, which is the whole point of splitting processes: it is the
 * number that says "the client is now inventing the latency it is reporting".
 * Resolution 10 has a ~10 ms floor on an idle loop (measured), which would
 * bury exactly the range we care about, so sample at 5 ms.
 */
const eld = monitorEventLoopDelay({ resolution: 5 });
eld.enable();

let cfg = null;
/** RSS before a single socket exists, so the report can quote the MARGINAL
 *  cost of a connection instead of a number dominated by Node's own baseline. */
let rss0 = process.memoryUsage().rss;
/** Set before we tear our own sockets down, so our exit is never counted as
 *  the server hanging up. A harness that scores its own shutdown as a server
 *  failure is worse than one that does not measure closes at all. */
let shuttingDown = false;
const bots = [];

const stats = {
  connected: 0, failed: 0, joined: 0, closed: 0,
  closeCodes: {},          // code -> n; a mass 1006 is the server hanging up
  errors: {},              // reason -> n
  guesses: 0, ok: 0, rejected: 0, solves: 0, roundsFinished: 0,
  frames: 0, frameBytes: 0, frameMax: 0,
  inboundBytes: 0, inboundMsgs: 0,
  roundStarts: 0, boardsSeen: {},   // boards -> rounds, so MISTO is visible
  pings: 0, pongs: 0,
  lat: new Hist(),        // guess -> result
  rtt: new Hist(),        // ping -> pong, the server-queue probe
  hand: new Hist(),       // connect -> open
  gap: new Hist(),        // spacing between consecutive ticks on one socket
};

const nowMs = () => Date.now();

class Bot {
  constructor(i) {
    this.i = i;
    this.seq = 0;
    this.pending = new Map();
    this.boards = 1;
    this.cands = null;
    this.done = [];
    this.playing = false;
    this.alive = false;
    this.lastTick = 0;
    // Spread the detailed samplers across the whole fleet rather than letting
    // worker 0 carry all of them: a per-worker stall is invisible if only one
    // worker is instrumented.
    this.sampled = cfg.sampleEvery > 0 && i % cfg.sampleEvery === 0;
    this.prober = cfg.probeEvery > 0 && i % cfg.probeEvery === 0;
    this.gapTracked = this.sampled;
    this.skill = skillFor(cfg.iq, i);
  }

  open() {
    const t0 = nowMs();
    let ws;
    try {
      ws = new WebSocket(`${cfg.wsScheme}://${cfg.host}/api/rooms/${cfg.code}/ws`, {origin:`${cfg.wsScheme === 'wss' ? 'https' : 'http'}://${cfg.host}`});
    } catch (e) {
      stats.failed++;
      bump(stats.errors, `construct:${e?.code || e?.message || 'erro'}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.alive = true;
      stats.connected++;
      stats.hand.record(nowMs() - t0);
      this.send({ t: 'join', name: `bot${String(this.i).padStart(5, '0')}`, token:this.i === 0 ? cfg.hostToken : undefined, v: 2 });
      if (this.prober) this.schedulePing();
    };
    ws.onerror = (e) => {
      stats.failed++;
      bump(stats.errors, String(e?.error?.code || e?.message || e?.type || 'erro'));
    };
    ws.onclose = (e) => {
      // Today's script never looked at this, so a room that hung up on every
      // socket still printed "conectados N/N (falhas 0)". Measured: that is
      // exactly what 6000 bots against local wrangler looks like.
      if (this.alive && !shuttingDown) { this.alive = false; stats.closed++; bump(stats.closeCodes, String(e?.code ?? 0)); }
      else this.alive = false;
      this.playing = false;
    };
    ws.onmessage = (ev) => this.onMsg(ev.data);
  }

  send(m) { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(m)); } catch { /* closing */ } } }

  schedulePing() {
    if (!this.alive) return;
    setTimeout(() => {
      if (!this.alive) return;
      const ts = nowMs();
      stats.pings++;
      this.send({ t: 'ping', ts });
      this.schedulePing();
    }, 3000 + Math.random() * 2000).unref?.();
  }

  onMsg(raw) {
    const len = typeof raw === 'string' ? raw.length : (raw?.byteLength ?? 0);
    stats.inboundMsgs++;
    stats.inboundBytes += len;
    let m; try { m = JSON.parse(raw); } catch { return; }

    switch (m.t) {
      case 'welcome':
        stats.joined++;
        if (this.i === 0) send({ t: 'host', you: m.you, room: m.room });
        return;

      case 'pong': {
        stats.pongs++;
        if (typeof m.ts === 'number') stats.rtt.record(Math.max(0, nowMs() - m.ts));
        return;
      }

      case 'tick': {
        if (!this.sampled) return;
        stats.frames++;
        stats.frameBytes += len;
        if (len > stats.frameMax) stats.frameMax = len;
        if (this.gapTracked) {
          const t = nowMs();
          if (this.lastTick) stats.gap.record(t - this.lastTick);
          this.lastTick = t;
        }
        return;
      }

      case 'roundStart': {
        // Board count comes off the FRAME, every round, never from --mode.
        // MISTO changes it between rounds; a bot that cached it from the mode
        // would parse a 3-board result against 1 board and stop solving.
        const boards = Number.isInteger(m.boards) && m.boards > 0 ? m.boards : this.boards;
        this.boards = boards;
        // Share the pool by reference and let the first filter copy it: an
        // eager slice() per board per bot is ~6 KB x boards x N of garbage
        // (250 MB at 10k bots in QUARTETO) to hold a list nobody has narrowed
        // yet.
        this.cands = new Array(boards).fill(POOL);
        this.done = new Array(boards).fill(false);
        this.playing = true;
        this.lastTick = 0;
        stats.roundStarts++;
        bump(stats.boardsSeen, String(boards));
        this.think();
        return;
      }

      case 'result': {
        const sent = this.pending.get(m.seq);
        if (sent !== undefined) { stats.lat.record(nowMs() - sent); this.pending.delete(m.seq); }
        if (!m.ok) {
          stats.rejected++;
          bump(stats.errors, `rejeitado:${m.reason || '?'}`);
          // 'closed' means the round is over for this bot; retrying is noise.
          if (m.reason === 'closed') { this.playing = false; return; }
          this.think(300);
          return;
        }
        stats.ok++;
        for (let b = 0; b < this.boards; b++) {
          if (this.done[b]) continue;
          const tiles = m.tiles?.[b];
          if (!tiles) continue;
          if (m.solved?.[b]) { this.done[b] = true; continue; }
          this.cands[b] = this.cands[b].filter((c) => c !== m.word && sameTiles(evaluate(m.word, c), tiles));
        }
        if (m.finished) {
          this.playing = false;
          stats.roundsFinished++;
          if (Array.isArray(m.solved) && m.solved.length > 0 && m.solved.every(Boolean)) stats.solves++;
          return;
        }
        this.think();
        return;
      }

      case 'roundEnd':
        this.playing = false;
        return;

      case 'matchEnd':
        this.playing = false;
        // One designated reporter, so the coordinator can stop on the real end
        // of the match instead of waiting out a worst-case clock.
        if (this.i === 0) send({ t: 'matchEnd' });
        return;

      case 'error':
        bump(stats.errors, `servidor:${m.code || '?'}`);
        return;
    }
  }

  /** Human-ish pacing, graded by skill: nobody submits five words in one second. */
  think(extra = 0) {
    if (!this.playing) return;
    const sk = this.skill;
    const wait = extra + sk.thinkBase + Math.random() * sk.thinkRand;
    setTimeout(() => {
      if (!this.playing || !this.alive) return;
      // Weaker players sometimes just leave mid-round.
      if (sk.quit && Math.random() < sk.quit) { this.playing = false; return; }
      const open = [];
      for (let b = 0; b < this.boards; b++) if (!this.done[b] && this.cands[b]?.length) open.push(this.cands[b]);
      const from = open.length ? open[0] : POOL;
      let word;
      if (sk.mistake && Math.random() < sk.mistake) {
        // A wild guess that ignores the deductions so far — wastes the attempt.
        word = POOL[(Math.random() * POOL.length) | 0];
      } else if (sk.optimal && from.length > 2 && from.length <= 60 && Math.random() < sk.optimal) {
        word = bestSplit(from);
      } else {
        word = from[(Math.random() * from.length) | 0];
      }
      const seq = ++this.seq;
      this.pending.set(seq, nowMs());
      stats.guesses++;
      this.send({ t: 'guess', word, seq });
    }, wait).unref?.();
  }
}

function bump(o, k) { o[k] = (o[k] || 0) + 1; }
function send(m) { if (process.send) process.send(m); }

/** Counters only while running; histograms ride along once, at the end. */
function snapshot(final) {
  const s = {
    t: final ? 'final' : 'tick',
    id: cfg.id,
    sockets: bots.reduce((n, b) => n + (b.alive ? 1 : 0), 0),
    connected: stats.connected, failed: stats.failed, joined: stats.joined,
    closed: stats.closed, closeCodes: stats.closeCodes, errors: stats.errors,
    guesses: stats.guesses, ok: stats.ok, rejected: stats.rejected,
    solves: stats.solves, roundsFinished: stats.roundsFinished,
    frames: stats.frames, frameBytes: stats.frameBytes, frameMax: stats.frameMax,
    inboundBytes: stats.inboundBytes, inboundMsgs: stats.inboundMsgs,
    roundStarts: stats.roundStarts, boardsSeen: stats.boardsSeen,
    pings: stats.pings, pongs: stats.pongs,
    rss: process.memoryUsage().rss, rss0,
    lagP50: eld.percentile(50) / 1e6, lagP99: eld.percentile(99) / 1e6, lagMax: eld.max / 1e6,
    latP95: stats.lat.percentile(95),
  };
  if (final) {
    s.lat = stats.lat.pack(); s.rtt = stats.rtt.pack();
    s.hand = stats.hand.pack(); s.gap = stats.gap.pack();
  }
  return s;
}

process.on('message', (m) => {
  if (m.t === 'init') {
    cfg = m.cfg;
    rss0 = process.memoryUsage().rss;
    const gap = cfg.rampMs / Math.max(1, cfg.total);
    for (let i = cfg.from; i < cfg.to; i++) {
      const bot = new Bot(i);
      bots.push(bot);
      // Absolute wall-clock target from the GLOBAL index. The old script did
      // `if (gap >= 1) await sleep(gap)`, which silently stops ramping the
      // moment N > rampMs — at --n 10000 --ramp 8000 that is every socket at
      // once, i.e. a handshake benchmark wearing a game's clothes.
      const at = cfg.rampStart + i * gap;
      const delay = at - nowMs();
      if (delay <= 0) bot.open();
      else setTimeout(() => bot.open(), delay).unref?.();
    }
    setInterval(() => send(snapshot(false)), cfg.reportMs).unref?.();
    send({ t: 'ready', id: cfg.id, bots: bots.length });
    return;
  }
  if (m.t === 'host-config') { bots[0]?.send({ t: 'config', mode: m.mode, rounds: m.rounds }); return; }
  if (m.t === 'host-start') { bots[0]?.send({ t: 'start' }); return; }
  if (m.t === 'final') {
    shuttingDown = true;
    eld.disable();
    send(snapshot(true));
    setTimeout(() => process.exit(0), 250);
    return;
  }
});

process.on('uncaughtException', (e) => {
  bump(stats.errors, `uncaught:${e?.code || e?.message || 'erro'}`);
});
