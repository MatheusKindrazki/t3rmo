#!/usr/bin/env node
/**
 * Fan-out load test.
 *
 * The claim under test is not "the game logic works" — the unit tests cover
 * that — it is "one room survives a thousand simultaneous players". The failure
 * mode being hunted is the obvious implementation of a live leaderboard:
 * broadcasting on every guess, which at a thousand players is roughly 66
 * inbound messages a second times a thousand recipients.
 *
 * Bots are real solvers, not spammers. A bot that submits garbage never
 * finishes, never scores and never moves the leaderboard, so the tick frame
 * would stay trivially small and the test would prove nothing. These filter the
 * candidate pool against the tile feedback they get back, so they solve in
 * three to five guesses, the table churns, and the fan-out is measured under
 * the traffic the real thing produces.
 *
 *   node tools/loadtest.mjs --n 1000 --mode termo --rounds 2
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const N = Number(arg('n', 200));
const HOST = arg('host', '127.0.0.1:8791');
const MODE = arg('mode', 'termo');
const ROUNDS = Number(arg('rounds', 1));
const RAMP_MS = Number(arg('ramp', 8000));
const SAMPLE = 25; // sockets whose inbound frames get measured in detail
// Local wrangler is plain http; anything else is the real edge behind TLS.
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(HOST);
const HTTP = LOCAL ? 'http' : 'https';
const WS = LOCAL ? 'ws' : 'wss';

const normalize = (w) =>
  w.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');

const answersSrc = readFileSync(join(root, 'packages/core/src/answers.ts'), 'utf8');
const POOL = [...answersSrc.split('= [')[1].split('];')[0].matchAll(/'([^']+)'/g)].map((m) => normalize(m[1]));

/** Same two-pass rule the server uses; bots need it to reason about feedback. */
function evaluate(guess, answer) {
  const t = [0, 0, 0, 0, 0];
  const pool = new Map();
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) t[i] = 2;
    else pool.set(answer[i], (pool.get(answer[i]) ?? 0) + 1);
  }
  for (let i = 0; i < 5; i++) {
    if (t[i] === 2) continue;
    const left = pool.get(guess[i]) ?? 0;
    if (left > 0) { t[i] = 1; pool.set(guess[i], left - 1); }
  }
  return t;
}
const sameTiles = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];

const stats = {
  connected: 0, failed: 0, joined: 0,
  guesses: 0, ok: 0, rejected: 0, solved: 0,
  latencies: [],
  frames: 0, frameBytes: 0, frameMax: 0,
  tickTimes: [],
  inboundBytes: 0, inboundMsgs: 0,
  roundsSeen: 0,
};

class Bot {
  constructor(i, code) {
    this.i = i;
    this.sampled = i < SAMPLE;
    this.cands = null;
    this.pending = new Map();
    this.boards = 1;
    this.playing = false;
    this.ws = new WebSocket(`${WS}://${HOST}/api/rooms/${code}/ws`);
    this.ws.onopen = () => {
      stats.connected++;
      this.send({ t: 'join', name: `bot${String(i).padStart(4, '0')}`, clientId: `load-${i}-${Date.now()}`, v: 1 });
    };
    this.ws.onerror = () => { stats.failed++; };
    this.ws.onmessage = (ev) => this.onMsg(ev.data);
  }

  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  onMsg(raw) {
    stats.inboundMsgs++;
    stats.inboundBytes += raw.length;
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'welcome') { stats.joined++; return; }

    if (m.t === 'tick' && this.sampled) {
      stats.frames++;
      stats.frameBytes += raw.length;
      stats.frameMax = Math.max(stats.frameMax, raw.length);
      if (this.i === 0) stats.tickTimes.push(Date.now());
      return;
    }

    if (m.t === 'roundStart') {
      this.boards = m.boards;
      // One independent candidate list per board; a guess is judged on all.
      this.cands = Array.from({ length: m.boards }, () => POOL.slice());
      this.done = new Array(m.boards).fill(false);
      this.playing = true;
      if (this.i === 0) stats.roundsSeen++;
      this.think();
      return;
    }

    if (m.t === 'result') {
      const sent = this.pending.get(m.seq);
      if (sent) { stats.latencies.push(Date.now() - sent); this.pending.delete(m.seq); }
      if (!m.ok) { stats.rejected++; this.think(300); return; }
      stats.ok++;
      for (let b = 0; b < this.boards; b++) {
        if (this.done[b]) continue;
        const tiles = m.tiles[b];
        if (!tiles) continue;
        if (m.solved[b]) { this.done[b] = true; continue; }
        this.cands[b] = this.cands[b].filter((c) => c !== m.word && sameTiles(evaluate(m.word, c), tiles));
      }
      if (m.finished) {
        this.playing = false;
        if (m.solved.every(Boolean)) stats.solved++;
        return;
      }
      this.think();
      return;
    }

    if (m.t === 'roundEnd' || m.t === 'matchEnd') { this.playing = false; }
  }

  /** Human-ish pacing: nobody submits five words in one second. */
  think(extra = 0) {
    if (!this.playing) return;
    const wait = extra + 900 + Math.random() * 2600;
    setTimeout(() => {
      if (!this.playing) return;
      const open = this.cands
        .map((c, b) => (this.done[b] ? null : c))
        .filter((c) => c && c.length);
      const from = open.length ? open[0] : POOL;
      const word = from[Math.floor(Math.random() * from.length)];
      const seq = ++this.seq0 || (this.seq0 = 1);
      this.pending.set(seq, Date.now());
      stats.guesses++;
      this.send({ t: 'guess', word, seq });
    }, wait);
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const main = async () => {
  // --code joins an existing room (a human already sitting in it); without it
  // the test mints its own.
  let code = arg('code', '');
  if (!code) {
    const res = await fetch(`${HTTP}://${HOST}/api/rooms`, { method: 'POST' });
    ({ code } = await res.json());
  }
  console.log(`sala ${code} · ${N} bots · modo ${MODE} · ${ROUNDS} rodada(s)\n`);

  const bots = [];
  const gap = RAMP_MS / N;
  for (let i = 0; i < N; i++) {
    bots.push(new Bot(i, code));
    if (gap >= 1) await new Promise((r) => setTimeout(r, gap));
  }

  // Give the ramp time to settle, then the first socket (the host) configures
  // and starts the match.
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`conectados ${stats.connected}/${N} · join confirmado ${stats.joined}`);
  // The human in the room is the host when --code was given; only self-hosted
  // runs may configure and start.
  if (!arg('code', '')) {
    bots[0].send({ t: 'config', mode: MODE, rounds: ROUNDS });
    await new Promise((r) => setTimeout(r, 400));
    bots[0].send({ t: 'start' });
  } else {
    console.log('aguardando o humano começar a partida…');
  }

  const t0 = Date.now();
  const deadline = t0 + 20_000 + ROUNDS * 70_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(
      `\r  ${el}s · palpites ${stats.guesses} · aceitos ${stats.ok} · recusados ${stats.rejected} · resolveram ${stats.solved}   `,
    );
    // Self-hosted runs stop as soon as the room is done. When a human is in the
    // room (--code) the bots stay until the deadline: exiting early would yank
    // every opponent out from under them mid-round, which looked like a server
    // bug the first time it happened.
    if (!arg('code', '') && stats.solved >= N * 0.9 && stats.guesses > N) break;
  }
  console.log('\n');

  const gaps = [];
  for (let i = 1; i < stats.tickTimes.length; i++) gaps.push(stats.tickTimes[i] - stats.tickTimes[i - 1]);
  const secs = (Date.now() - t0) / 1000;

  console.log('── fan-out ─────────────────────────────────────────');
  console.log(`  frames de tick medidos   : ${stats.frames} (em ${SAMPLE} sockets amostrados)`);
  console.log(`  tamanho médio do frame   : ${stats.frames ? (stats.frameBytes / stats.frames).toFixed(0) : 0} B`);
  console.log(`  maior frame              : ${stats.frameMax} B`);
  console.log(`  intervalo entre ticks    : mediana ${pct(gaps, 50)} ms · p95 ${pct(gaps, 95)} ms`);
  console.log(`  egresso estimado p/ sala : ${((stats.frameBytes / Math.max(1, stats.frames)) * N * (1000 / Math.max(1, pct(gaps, 50))) / 1024).toFixed(0)} KB/s`);
  console.log('── latência do palpite ─────────────────────────────');
  console.log(`  amostras                 : ${stats.latencies.length}`);
  console.log(`  p50 ${pct(stats.latencies, 50)} ms · p95 ${pct(stats.latencies, 95)} ms · p99 ${pct(stats.latencies, 99)} ms · max ${Math.max(0, ...stats.latencies)} ms`);
  console.log('── jogo ────────────────────────────────────────────');
  console.log(`  conectados               : ${stats.connected}/${N} (falhas ${stats.failed})`);
  console.log(`  palpites enviados        : ${stats.guesses} (${(stats.guesses / secs).toFixed(1)}/s)`);
  console.log(`  aceitos ${stats.ok} · recusados ${stats.rejected}`);
  console.log(`  bots que fecharam        : ${stats.solved}/${N}`);
  console.log(`  tráfego total recebido   : ${(stats.inboundBytes / 1024 / 1024).toFixed(2)} MB em ${stats.inboundMsgs} mensagens`);

  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
