#!/usr/bin/env node
/**
 * Spins up a test room with bots and waits for you.
 *
 * Protocol v2: rooms are reserved server-side; host authority comes from the
 * private creation capability. Friend rooms start only on a host command.
 * The fleet waits for a human so the round is not missed during setup.
 *
 * Usage
 *   node tools/arena.mjs                          400 bots, MISTO, 4 rounds, production
 *   node tools/arena.mjs --bots 50 --mode termo   a small, fast one
 *   node tools/arena.mjs --host 127.0.0.1:8791    against the local dev server
 *   node tools/arena.mjs --no-wait                start immediately, do not wait for a human
 *   node tools/arena.mjs --start-in 20            seconds to give yourself after arriving
 */
import WebSocket from 'ws';
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
const BOTS = Number(arg('bots', 20));
if (!Number.isInteger(BOTS) || BOTS < 1 || BOTS > 48) throw new Error('Use 1–48 bots; larger load needs an explicitly configured staging policy.');
const MODE = arg('mode', 'misto');
const ROUNDS = Number(arg('rounds', 4));
const RAMP = Number(arg('ramp', Math.max(8000, BOTS * 60)));
const START_IN = Number(arg('start-in', 15));
const START_AT = Number(arg('start-at', 0)); // inicia quando N sockets conectaram (medição)
const IQ = arg('iq', 'bom');                 // nível dos bots: iniciante|casual|bom|pro|mix
const TEMPO = Number(arg('tempo', 1));       // multiplicador do relógio (0.5 = rápido, 2 = longo)
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
  const res = await fetch(`${HTTP}://${HOST}/api/rooms`, { method: 'POST', headers:{Origin:`${HTTP}://${HOST}`,'Content-Type':'application/json'}, body:JSON.stringify({mode:MODE,rounds:ROUNDS,pace:TEMPO}) });
  if (!res.ok) { say(`não consegui criar a sala: HTTP ${res.status}`); process.exit(1); }
  const { code, hostToken } = await res.json();

  // Only the creation token grants host authority; it is never printed.
  const host = new WebSocket(`${WS}://${HOST}/api/rooms/${code}/ws`, {origin:`${HTTP}://${HOST}`});
  const send = (m) => host.readyState === 1 && host.send(JSON.stringify(m));
  let started = false;

  await new Promise((ok, fail) => {
    host.onopen = ok;
    host.onerror = () => fail(new Error('não consegui abrir o socket do anfitrião'));
    setTimeout(() => fail(new Error('tempo esgotado abrindo o socket')), 15000);
  });
  send({ t: 'join', name: 'anfitriao', token:hostToken, v: 2 });

  await sleep(1200);

  const conf = await info(code);
  const cfg = conf?.cfg;
  say('');
  say(`  ${C.b}${C.c}${HTTP}://${HOST}/?sala=${code}${C.r}`);
  say('');
  say(`  ${C.dim}modo${C.r} ${conf?.mode ?? MODE}   ${C.dim}rodadas${C.r} ${conf?.rounds ?? ROUNDS}   ` +
      `${C.dim}1ª${C.r} ${cfg?.l ?? '?'} (${cfg?.b ?? '?'} palavra(s), ${cfg?.g ?? '?'} tentativas)   ${C.dim}bots${C.r} ${BOTS}   ${C.dim}iq${C.r} ${IQ}   ${C.dim}tempo${C.r} ${TEMPO}x`);
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
    '--mode', MODE, '--rounds', String(ROUNDS), '--ramp', String(RAMP), '--iq', IQ,
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
