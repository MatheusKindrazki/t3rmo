#!/usr/bin/env node
/**
 * Spins up a test room with bots and waits for you.
 *
 * Doing this by hand takes several steps and two of them are easy to get
 * wrong, which is why this exists:
 *
 *  1. A room is only REAL once the socket that opened it says `?new=1`.
 *     Without that the server treats it as a ghost room and the join page
 *     refuses it — the defence against typo'd codes fires on your own test.
 *  2. The room auto-starts 30 s after the SECOND player joins. Ramp four
 *     hundred bots in and the match is already running before you have opened
 *     the link. So the fleet is held back: one socket opens the room, prints
 *     the link, and nothing else connects until a human actually shows up.
 *
 * Usage
 *   node tools/arena.mjs                          400 bots, MISTO, 4 rounds, production
 *   node tools/arena.mjs --bots 50 --mode termo   a small, fast one
 *   node tools/arena.mjs --host 127.0.0.1:8791    against the local dev server
 *   node tools/arena.mjs --no-wait                start immediately, do not wait for a human
 *   node tools/arena.mjs --start-in 20            seconds to give yourself after arriving
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const flag = (k) => process.argv.includes(`--${k}`);

const HOST = arg('host', 't3rmo.com');
const BOTS = Number(arg('bots', 400));
const MODE = arg('mode', 'misto');
const ROUNDS = Number(arg('rounds', 4));
const RAMP = Number(arg('ramp', Math.max(8000, BOTS * 60)));
const START_IN = Number(arg('start-in', 15));
const START_AT = Number(arg('start-at', 0)); // inicia quando N sockets conectaram (medição)
const WAIT = !flag('no-wait');

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(HOST);
const HTTP = LOCAL ? 'http' : 'https';
const WS = LOCAL ? 'ws' : 'wss';

const C = { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', c: '\x1b[36m', y: '\x1b[33m', r: '\x1b[0m' };
const say = (s = '') => process.stdout.write(s + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(code) {
  try {
    const r = await fetch(`${HTTP}://${HOST}/api/rooms/${code}/info`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const main = async () => {
  say(`${C.dim}abrindo sala em ${HOST}…${C.r}`);
  const res = await fetch(`${HTTP}://${HOST}/api/rooms`, { method: 'POST' });
  if (!res.ok) { say(`não consegui criar a sala: HTTP ${res.status}`); process.exit(1); }
  const { code } = await res.json();

  // The host socket. `?new=1` is what makes the room real; holding the socket
  // open is what makes this process the host, so it can start the match.
  const host = new WebSocket(`${WS}://${HOST}/api/rooms/${code}/ws?new=1`);
  const send = (m) => host.readyState === 1 && host.send(JSON.stringify(m));
  let started = false;

  await new Promise((ok, fail) => {
    host.onopen = ok;
    host.onerror = () => fail(new Error('não consegui abrir o socket do anfitrião'));
    setTimeout(() => fail(new Error('tempo esgotado abrindo o socket')), 15000);
  });
  send({ t: 'join', name: 'anfitriao', clientId: `arena-host-${Date.now()}`, v: 1 });
  send({ t: 'config', mode: MODE, rounds: ROUNDS });
  await sleep(1200);

  const conf = await info(code);
  const cfg = conf?.cfg;
  say('');
  say(`  ${C.b}${C.c}${HTTP}://${HOST}/?sala=${code}${C.r}`);
  say('');
  say(`  ${C.dim}modo${C.r} ${conf?.mode ?? MODE}   ${C.dim}rodadas${C.r} ${conf?.rounds ?? ROUNDS}   ` +
      `${C.dim}1ª${C.r} ${cfg?.l ?? '?'} (${cfg?.b ?? '?'} palavra(s), ${cfg?.g ?? '?'} tentativas)   ${C.dim}bots${C.r} ${BOTS}`);
  if (conf && conf.mode !== MODE) {
    say(`  ${C.y}atenção: pedi ${MODE} e a sala ficou ${conf.mode}${C.r}`);
  }
  say('');

  if (WAIT) {
    say(`${C.dim}esperando você entrar… (ctrl-c cancela)${C.r}`);
    for (;;) {
      const i = await info(code);
      if ((i?.online ?? 0) >= 2) break;
      await sleep(1500);
    }
    say(`${C.g}✓ você entrou${C.r} — soltando ${BOTS} bots, partida em ${START_IN}s`);
  }

  // Bots go through the load test, which already knows how to be a fleet:
  // real solvers, multi-process, close-aware, and they stay for the whole match.
  const fleet = spawn(process.execPath, [
    join(here, 'loadtest.mjs'),
    '--n', String(BOTS), '--host', HOST, '--code', code,
    '--mode', MODE, '--rounds', String(ROUNDS), '--ramp', String(RAMP),
  ], { stdio: 'inherit' });

  // The host starts the match. With --start-at N it waits until N sockets are
  // actually connected — the way to measure steady-state fan-out instead of the
  // ramp. Otherwise it starts on a fixed delay.
  const fire = () => { if (!started) { started = true; send({ t: 'start' }); say(`${C.g}✓ partida iniciada${C.r}`); } };
  if (START_AT > 0) {
    say(`${C.dim}vou iniciar quando ${START_AT} sockets estiverem conectados…${C.r}`);
    const poll = setInterval(async () => {
      const i = await info(code);
      if ((i?.online ?? 0) >= START_AT) { clearInterval(poll); fire(); }
    }, 2000);
    // teto de segurança: não espera para sempre
    setTimeout(() => { clearInterval(poll); fire(); }, 180_000);
  } else {
    setTimeout(fire, (WAIT ? START_IN : 5) * 1000);
  }

  const bye = () => { try { host.close(); } catch {} try { fleet.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', bye);
  fleet.on('exit', () => { try { host.close(); } catch {} process.exit(0); });
};

main().catch((e) => { say(String(e?.message ?? e)); process.exit(1); });
