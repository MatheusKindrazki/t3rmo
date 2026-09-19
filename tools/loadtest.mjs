#!/usr/bin/env node
/**
 * Fan-out load test — coordinator.
 *
 * The claim under test is not "the game logic works" — the unit tests cover
 * that — it is "one room survives ten thousand simultaneous players". The
 * failure mode being hunted is the obvious implementation of a live
 * leaderboard: broadcasting on every guess, which at ten thousand players is
 * roughly 660 inbound messages a second times ten thousand recipients.
 *
 * Bots are real solvers, not spammers. A bot that submits garbage never
 * finishes, never scores and never moves the leaderboard, so the tick frame
 * would stay trivially small and the test would prove nothing. These filter the
 * candidate pool against the tile feedback they get back, so they solve in
 * three to five guesses, the table churns, and the fan-out is measured under
 * the traffic the real thing produces.
 *
 * WHY THIS IS MULTI-PROCESS. Measured on this machine (18 cores, ulimit -n
 * 1048576), one Node process carried 6000 sockets with its event loop still
 * idle — file descriptors were never the constraint and neither, at that size,
 * was the solver. What breaks is subtler: a single loop is a single point of
 * measurement, so when latency climbs you cannot tell whether the server got
 * slow or your own loop got behind and is now inventing the number it reports.
 * Splitting the fleet across processes gives every slice its own event-loop
 * clock, and that is what makes the CLIENT/SERVER verdict at the bottom of the
 * report an observation instead of a guess.
 *
 *   node tools/loadtest.mjs --n 5000 --mode termo --rounds 2
 *   node tools/loadtest.mjs --n 10000 --workers 8 --ramp 60000
 *   node tools/loadtest.mjs --n 2000 --code ABCD      # join a human's room
 *   node tools/fleetwatch.mjs                          # live, in another shell
 */
import { fork } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpus } from 'node:os';
import { arg, flag, Hist, STATUS_PATH, fmtMs, fmtBytes } from './loadtest-shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const N = Number(arg('n', 200));
const HOST = arg('host', '127.0.0.1:8791');
const MODE = arg('mode', 'termo');
const ROUNDS = Number(arg('rounds', 1));
const RAMP_MS = Number(arg('ramp', 8000));
const CODE_IN = arg('code', '');
const STATUS_FILE = arg('status', STATUS_PATH);
const QUIET = flag('quiet');

/** MISTO is being added by another agent; accept it before it lands. */
const MODES = ['termo', 'dueto', 'trieto', 'quarteto', 'misto'];
if (!MODES.includes(MODE)) {
  console.error(`modo inválido: ${MODE} (use ${MODES.join(' | ')})`);
  process.exit(2);
}

// Local wrangler is plain http; anything else is the real edge behind TLS.
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(HOST);
const HTTP = LOCAL ? 'http' : 'https';
const WS = LOCAL ? 'ws' : 'wss';

/**
 * ~1500 bots a worker. One process managed 6000 before anything smelled, but
 * the tail that matters is the instant `roundStart` lands and every bot in the
 * slice runs its first full-pool filter at once — 113 us each, measured, times
 * boards. At 1500 that spike is ~0.17 s of CPU per board; at 6000 it is 0.7 s,
 * which is long enough to distort the very latencies being recorded.
 */
const WORKERS = Math.max(1, Math.min(
  Number(arg('workers', 0)) || Math.ceil(N / 1500),
  Math.max(1, cpus().length - 2),
));
const REPORT_MS = 1000;

const live = new Map();   // worker id -> latest snapshot
const finals = new Map();
const kids = [];
let hostInfo = null, matchEnded = false, t0 = 0, peakSockets = 0;
let quorumAt = 0, configSent = false, started = false;
let lastGuesses = 0, lastAt = 0, rate = 0, lastPrinted = 0;

const sum = (f) => { let n = 0; for (const s of live.values()) n += f(s) || 0; return n; };
const mergeMaps = (f) => {
  const out = {};
  for (const s of live.values()) for (const [k, v] of Object.entries(f(s) || {})) out[k] = (out[k] || 0) + v;
  return out;
};
const maxOf = (f) => { let n = 0; for (const s of live.values()) n = Math.max(n, f(s) || 0); return n; };

function aggregate() {
  const sockets = sum((s) => s.sockets);
  peakSockets = Math.max(peakSockets, sockets);
  return {
    sockets, peakSockets,
    connected: sum((s) => s.connected), failed: sum((s) => s.failed),
    joined: sum((s) => s.joined), closed: sum((s) => s.closed),
    closeCodes: mergeMaps((s) => s.closeCodes), errors: mergeMaps((s) => s.errors),
    guesses: sum((s) => s.guesses), ok: sum((s) => s.ok), rejected: sum((s) => s.rejected),
    solves: sum((s) => s.solves), roundsFinished: sum((s) => s.roundsFinished),
    frames: sum((s) => s.frames), frameBytes: sum((s) => s.frameBytes), frameMax: maxOf((s) => s.frameMax),
    inboundBytes: sum((s) => s.inboundBytes), inboundMsgs: sum((s) => s.inboundMsgs),
    pings: sum((s) => s.pings), pongs: sum((s) => s.pongs),
    rss: sum((s) => s.rss), rss0: sum((s) => s.rss0), lagMax: maxOf((s) => s.lagP99), latP95: maxOf((s) => s.latP95),
    boardsSeen: mergeMaps((s) => s.boardsSeen),
  };
}

function publish(phase, code) {
  const a = aggregate();
  const now = Date.now();
  if (lastAt) rate = ((a.guesses - lastGuesses) * 1000) / Math.max(1, now - lastAt);
  lastGuesses = a.guesses; lastAt = now;
  const doc = {
    ts: now, phase, code, mode: MODE, rounds: ROUNDS, target: N, host: HOST,
    elapsed: t0 ? (now - t0) / 1000 : 0, rate, agg: a,
    workers: [...live.values()].map((s) => ({
      id: s.id, sockets: s.sockets, closed: s.closed, guesses: s.guesses,
      lagP50: +s.lagP50.toFixed(1), lagP99: +s.lagP99.toFixed(1), lagMax: +s.lagMax.toFixed(1),
      rss: s.rss,
    })).sort((x, y) => x.id - y.id),
  };
  try { writeFileSync(STATUS_FILE, JSON.stringify(doc)); } catch { /* watcher is optional */ }
  if (!QUIET && (process.stdout.isTTY || now - lastPrinted >= 5000)) {
    lastPrinted = now;
    const el = String(Math.round(doc.elapsed)).padStart(4);
    process.stdout.write(
      `${process.stdout.isTTY ? '\r' : '\n'}  ${el}s ${phase.padEnd(9)} sock ${String(a.sockets).padStart(6)}/${N}` +
      ` · palp ${String(a.guesses).padStart(7)} (${rate.toFixed(0).padStart(4)}/s)` +
      ` · ok ${a.ok} · rec ${a.rejected} · solv ${a.solves}` +
      ` · lag ${a.lagMax.toFixed(0).padStart(3)}ms · p95 ${String(a.latP95).padStart(4)}ms` +
      ` · fech ${a.closed}    `,
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // --code joins an existing room (a human already sitting in it); without it
  // the test mints its own.
  let code = CODE_IN;
  if (!code) {
    const res = await fetch(`${HTTP}://${HOST}/api/rooms`, { method: 'POST' });
    ({ code } = await res.json());
  }

  // Round length comes from the server, not from a table in here: MISTO does
  // not exist in this file's world and its clock must not be guessed at.
  let roundMs = 240_000, boardsHint = '?';
  try {
    const h = await (await fetch(`${HTTP}://${HOST}/api/health`)).json();
    const cfg = (h.modes || []).find((m) => m.id === MODE);
    if (cfg) { roundMs = cfg.roundMs; boardsHint = String(cfg.boards); }
    else console.log(`aviso: o servidor não conhece o modo "${MODE}" (conhece: ${(h.modes || []).map((m) => m.id).join(', ')})`);
  } catch { console.log('aviso: /api/health não respondeu; usando relógio de rodada conservador'); }

  console.log(`sala ${code} · ${N} bots · modo ${MODE} (boards ${boardsHint}) · ${ROUNDS} rodada(s) · ${WORKERS} worker(s) · ramp ${RAMP_MS} ms`);
  console.log(`status ao vivo: node tools/fleetwatch.mjs${STATUS_FILE !== STATUS_PATH ? ` --status ${STATUS_FILE}` : ''}\n`);

  // Slices are contiguous so bot 0 — the host when we own the room — is worker
  // 0's first bot, and the global index still drives the ramp.
  const rampStart = Date.now() + 500;
  const per = Math.ceil(N / WORKERS);
  const runId = Date.now();
  for (let w = 0; w < WORKERS; w++) {
    const from = w * per, to = Math.min(N, from + per);
    if (from >= to) break;
    const child = fork(join(HERE, 'loadtest-worker.mjs'), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    kids.push(child);
    child.on('message', (m) => {
      if (m.t === 'tick' || m.t === 'final') live.set(m.id, m);
      if (m.t === 'final') finals.set(m.id, m);
      if (m.t === 'host') {
        hostInfo = m;
        // Configure the instant the host is in, while the room is still a
        // one-player lobby. The server auto-starts 30 s after the SECOND
        // player arrives, so on any ramp longer than that a config sent after
        // the ramp lands on a running match and is rejected 'locked' — which
        // is exactly what happened at --n 5000 --ramp 30000: the fleet played
        // the server's default 5 rounds instead of the 1 that was asked for,
        // and nothing in the report said so.
        if (!CODE_IN && !configSent) {
          configSent = true;
          kids[0].send({ t: 'host-config', mode: MODE, rounds: ROUNDS });
        }
      }
      if (m.t === 'matchEnd') matchEnded = true;
    });
    child.on('exit', (c) => { if (c !== 0 && c !== null) console.error(`\nworker ${w} saiu com código ${c}`); });
    child.send({
      t: 'init',
      cfg: {
        id: w, from, to, total: N, host: HOST, code, wsScheme: WS, runId,
        rampStart, rampMs: RAMP_MS, reportMs: REPORT_MS,
        // ~25 detailed tick samplers and ~40 ping probes, spread evenly over
        // the fleet instead of bunched in worker 0.
        sampleEvery: Math.max(1, Math.floor(N / 25)),
        probeEvery: Math.max(1, Math.floor(N / 40)),
      },
    });
  }

  t0 = Date.now();
  const timer = setInterval(() => {
    publish('ramp', code);
    if (!quorumAt && aggregate().connected >= 2) quorumAt = Date.now();
  }, REPORT_MS);

  // Wait out the ramp, then let the room settle before anyone starts — but
  // never past the server's own auto-start, or it starts the match for us with
  // the wrong settings. AUTOSTART_MS is 30 s from quorum; 24 s leaves room for
  // the config round trip.
  const rampEnd = rampStart + RAMP_MS;
  const settled = () => Date.now() >= rampEnd + 2500;
  let forced = false;
  while (!settled()) {
    if (!CODE_IN && quorumAt && Date.now() >= quorumAt + 24_000) { forced = true; break; }
    await sleep(200);
  }
  clearInterval(timer);
  if (forced) {
    const a = aggregate();
    console.log(`\naviso: o servidor auto-inicia 30 s após o 2º jogador; começando com ${a.connected}/${N} conectados.`);
    console.log('       os bots restantes entram com a partida em curso. Para evitar, use --ramp menor que 20000.');
  }

  const a0 = aggregate();
  console.log(`\nconectados ${a0.connected}/${N} · join confirmado ${a0.joined} · fechados ${a0.closed}`);

  // The human in the room is the host when --code was given; only self-hosted
  // runs may configure and start.
  if (!CODE_IN) {
    if (hostInfo && hostInfo.you && hostInfo.you.isHost === false) {
      console.log('aviso: o bot 0 não é o host desta sala — não vou configurar nem começar');
    }
    if (!configSent) { configSent = true; kids[0].send({ t: 'host-config', mode: MODE, rounds: ROUNDS }); await sleep(400); }
    if (sum((s) => s.roundStarts) > 0) {
      console.log('aviso: a partida já estava em curso quando o ramp terminou — não vou reiniciá-la');
    } else {
      started = true;
      kids[0].send({ t: 'host-start' });
    }
  } else {
    console.log('aguardando o humano começar a partida…');
  }

  const playTimer = setInterval(() => publish('jogando', code), REPORT_MS);
  const budget = 20_000 + ROUNDS * (roundMs + 15_000);
  const tEnd = Date.now() + budget;
  while (Date.now() < tEnd) {
    await sleep(500);
    // Self-hosted runs stop as soon as the room is done. When a human is in the
    // room (--code) the bots stay until the deadline: exiting early would yank
    // every opponent out from under them mid-round, which looked like a server
    // bug the first time it happened.
    if (!CODE_IN && matchEnded) break;
    if (!CODE_IN && live.size && aggregate().sockets === 0) { console.log('\ntodos os sockets caíram — encerrando'); break; }
  }
  clearInterval(playTimer);
  publish('colhendo', code);

  // Collect the histograms, then report once.
  for (const k of kids) k.send({ t: 'final' });
  const waitUntil = Date.now() + 5000;
  while (finals.size < kids.length && Date.now() < waitUntil) await sleep(100);
  for (const k of kids) { try { k.kill(); } catch { /* already gone */ } }

  report(code, roundMs);
  try { unlinkSync(STATUS_FILE); } catch { /* fine */ }
  process.exit(0);
}

function report(code, roundMs) {
  const lat = new Hist(), rtt = new Hist(), hand = new Hist(), gap = new Hist();
  for (const f of finals.values()) { lat.merge(f.lat); rtt.merge(f.rtt); hand.merge(f.hand); gap.merge(f.gap); }
  const a = aggregate();
  const secs = Math.max(1, (Date.now() - t0) / 1000);
  const avgFrame = a.frames ? a.frameBytes / a.frames : 0;
  const tickMed = gap.percentile(50);
  const missing = kids.length - finals.size;

  console.log('\n');
  console.log('── fan-out ─────────────────────────────────────────');
  console.log(`  frames de tick medidos   : ${a.frames} (em ~25 sockets amostrados)`);
  console.log(`  tamanho médio do frame   : ${avgFrame.toFixed(0)} B`);
  console.log(`  maior frame              : ${a.frameMax} B`);
  console.log(`  intervalo entre ticks    : mediana ${fmtMs(tickMed)} ms · p95 ${fmtMs(gap.percentile(95))} ms`);
  console.log(`  egresso estimado p/ sala : ${((avgFrame * a.peakSockets * (1000 / Math.max(1, tickMed))) / 1024).toFixed(0)} KB/s`);
  console.log('── latência do palpite ─────────────────────────────');
  console.log(`  amostras                 : ${lat.n}`);
  console.log(`  p50 ${fmtMs(lat.percentile(50))} ms · p95 ${fmtMs(lat.percentile(95))} ms · p99 ${fmtMs(lat.percentile(99))} ms · max ${lat.hi} ms`);
  console.log('── jogo ────────────────────────────────────────────');
  console.log(`  conectados               : ${a.connected}/${N} (falhas ${a.failed})`);
  console.log(`  pico de sockets vivos    : ${a.peakSockets} · vivos no fim ${a.sockets}`);
  console.log(`  sockets derrubados       : ${a.closed}${Object.keys(a.closeCodes).length ? ` ${JSON.stringify(a.closeCodes)}` : ''}`);
  console.log(`  palpites enviados        : ${a.guesses} (${(a.guesses / secs).toFixed(1)}/s)`);
  console.log(`  aceitos ${a.ok} · recusados ${a.rejected}`);
  console.log(`  rodadas encerradas       : ${a.roundsFinished} · fecharam tudo ${a.solves}`);
  console.log(`  boards por rodada vistos : ${JSON.stringify(a.boardsSeen)}   (do frame roundStart, não do --mode)`);
  console.log(`  tráfego total recebido   : ${fmtBytes(a.inboundBytes)} em ${a.inboundMsgs} mensagens`);
  if (Object.keys(a.errors).length) console.log(`  erros                    : ${JSON.stringify(a.errors)}`);

  console.log('── frota (por worker) ──────────────────────────────');
  console.log('  id   sockets  fech   palpites   lag p50   lag p99   lag max      RSS');
  const rows = [...live.values()].sort((x, y) => x.id - y.id);
  for (const s of rows) {
    console.log(
      `  ${String(s.id).padEnd(3)}${String(s.sockets).padStart(8)}${String(s.closed).padStart(6)}` +
      `${String(s.guesses).padStart(11)}${(s.lagP50.toFixed(1) + 'ms').padStart(10)}` +
      `${(s.lagP99.toFixed(1) + 'ms').padStart(10)}${(s.lagMax.toFixed(0) + 'ms').padStart(10)}` +
      `${fmtBytes(s.rss).padStart(10)}`,
    );
  }
  if (missing > 0) console.log(`  (${missing} worker(s) não entregaram histograma final — números abaixo podem estar incompletos)`);
  console.log(`  handshake                : p50 ${fmtMs(hand.percentile(50))} ms · p95 ${fmtMs(hand.percentile(95))} ms · max ${hand.hi} ms`);
  console.log(`  RTT ping/pong            : amostras ${rtt.n} · p50 ${fmtMs(rtt.percentile(50))} ms · p95 ${fmtMs(rtt.percentile(95))} ms · max ${rtt.hi} ms`);
  // Marginal, not total: at 50 sockets the total is ~95% Node baseline, and
  // quoting that as "KB/socket" would put the capacity estimate off by 20x.
  const marginal = Math.max(0, a.rss - a.rss0);
  console.log(`  RSS somado dos workers   : ${fmtBytes(a.rss)} (base ${fmtBytes(a.rss0)} + ${fmtBytes(marginal)} de carga)`);
  console.log(`  custo marginal do socket : ${a.peakSockets ? (marginal / a.peakSockets / 1024).toFixed(1) : 0} KB · projeção 10k = ${a.peakSockets ? fmtBytes((marginal / a.peakSockets) * 10000) : 'n/d'}`);

  verdict({ a, lat, rtt, hand, gap, roundMs, code });
}

/**
 * CLIENT or SERVER — the question a load test exists to answer.
 *
 * The discriminator is the worker event loop. Every latency in this report was
 * stamped by a worker, so a worker that is itself behind reports a number that
 * is partly its own. RTT is the cleanest probe of the far side: `ping`/`pong`
 * does no game work, so what it measures is the Durable Object's queue, and
 * subtracting our own lag from it leaves the server's share.
 */
function verdict({ a, lat, rtt, hand, gap, roundMs }) {
  const clientLag = a.lagMax;                       // worst worker p99
  const rttP95 = rtt.percentile(95);
  const serverQueue = Math.max(0, rttP95 - clientLag);
  const latP95 = lat.percentile(95);
  const handP95 = hand.percentile(95);
  const dropped = a.closed;
  const dropRate = a.peakSockets ? dropped / a.peakSockets : 0;

  const why = [];
  let who = 'NENHUM DOS DOIS saturou';

  const failRate = a.failed / Math.max(1, a.failed + a.connected);

  if (failRate >= 0.05 && clientLag < 150) {
    // A refused upgrade is the server saying no out loud. It outranks every
    // latency number below, because the latencies that survived were measured
    // on the connections it agreed to accept — a fleet half this size.
    who = 'SERVIDOR';
    why.push(`recusou ${a.failed} de ${a.failed + a.connected} handshakes (${(failRate * 100).toFixed(0)}%) com o cliente ocioso (lag p99 ${clientLag.toFixed(0)} ms)`);
    why.push(`teto observado nesta execução: ${a.peakSockets} sockets simultâneos`);
    why.push('a latência acima vale só para quem CONSEGUIU entrar — não é o perfil de uma sala com --n inteiro');
  } else if (dropRate >= 0.5) {
    who = 'SERVIDOR';
    why.push(`derrubou ${dropped} de ${a.peakSockets} sockets (${(dropRate * 100).toFixed(0)}%) — códigos ${JSON.stringify(a.closeCodes)}`);
  } else if (clientLag >= 150 && clientLag >= latP95 * 0.5) {
    who = 'CLIENTE (esta ferramenta)';
    why.push(`event-loop lag p99 do pior worker ${clientLag.toFixed(0)} ms, contra p95 de palpite ${latP95} ms — a medição está sendo produzida pela própria fila do worker`);
    why.push(`suba --workers (agora ${live.size}) ou baixe --n por worker`);
  } else if (handP95 >= 1000 && clientLag < 150) {
    who = 'SERVIDOR';
    why.push(`handshake p95 ${handP95} ms com o cliente ocioso (lag p99 ${clientLag.toFixed(0)} ms) — a fila de accept do servidor é o gargalo, não a nossa`);
  } else if (serverQueue >= 150) {
    who = 'SERVIDOR';
    why.push(`RTT ping/pong p95 ${rttP95} ms menos o nosso lag ${clientLag.toFixed(0)} ms deixa ${serverQueue.toFixed(0)} ms de fila no Durable Object`);
  } else if (dropRate > 0.05) {
    who = 'SERVIDOR (parcial)';
    why.push(`derrubou ${dropped} sockets (${(dropRate * 100).toFixed(0)}%) — códigos ${JSON.stringify(a.closeCodes)}`);
  } else {
    why.push(`cliente ocioso (lag p99 ${clientLag.toFixed(0)} ms) e servidor respondendo (RTT p95 ${rttP95} ms, palpite p95 ${latP95} ms)`);
    why.push('nenhum dos lados atingiu o limite nesta execução — suba --n');
  }

  // Tick drift is the fan-out's own health, independent of who is to blame.
  const tickMed = gap.percentile(50);
  const expect = a.peakSockets <= 400 ? 500 : a.peakSockets <= 1500 ? 750 : a.peakSockets <= 4000 ? 1000 : 1500;
  const drift = tickMed - expect;

  console.log('── veredito ────────────────────────────────────────');
  console.log(`  GARGALO: ${who}`);
  for (const w of why) console.log(`    · ${w}`);
  console.log(`  cadência do tick         : medida ${fmtMs(tickMed)} ms · esperada ${expect} ms (tickMsFor(${a.peakSockets}))` +
    `${gap.n ? ` · desvio ${drift >= 0 ? '+' : ''}${drift} ms` : ' · sem amostras'}`);
  if (gap.n && drift > expect * 0.25) {
    console.log('    · o tick está atrasando: a sala não termina um fan-out antes do próximo vencer');
  }
  if (a.pings && a.pongs < a.pings * 0.9) {
    console.log(`    · ${a.pings - a.pongs} de ${a.pings} pings ficaram sem resposta — o servidor perdeu mensagens, não só atrasou`);
  }
  console.log(`  confiança                : ${lat.n} amostras de latência, ${rtt.n} de RTT, ${gap.n} de tick`);
  if (lat.n < 100) console.log('    · poucas amostras: trate os percentis como indicativos, não como medida');
}

main().catch((e) => { console.error(e); for (const k of kids) { try { k.kill(); } catch {} } process.exit(1); });
