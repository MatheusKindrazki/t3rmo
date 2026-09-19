#!/usr/bin/env node
/**
 * Watch the bot fleet without reading the raw run.
 *
 * The point of the load test is that the owner sits in the room and PLAYS
 * while ten thousand bots do too. That means the terminal running the fleet is
 * not the terminal he is looking at, and "is it still going?" should not cost
 * a scroll through a log. This reads the coordinator's status file and redraws
 * a few lines in place.
 *
 *   node tools/fleetwatch.mjs            # redrawn block, 1 Hz
 *   node tools/fleetwatch.mjs --line     # a single line, for a status bar
 *   node tools/fleetwatch.mjs --every 2  # slower
 */
import { readFileSync } from 'node:fs';
import { arg, flag, STATUS_PATH, fmtBytes } from './loadtest-shared.mjs';

const FILE = arg('status', STATUS_PATH);
const EVERY = Math.max(0.2, Number(arg('every', 1))) * 1000;
const ONE_LINE = flag('line');
const STALE_MS = 8000;

let drawn = 0;

function read() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; }
}

function bar(frac, width = 24) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return `${'█'.repeat(n)}${'·'.repeat(width - n)}`;
}

function render() {
  const d = read();
  const out = [];
  if (!d) {
    out.push('sem frota ativa — nenhum coordenador publicando em');
    out.push(`  ${FILE}`);
    return out;
  }
  const age = Date.now() - d.ts;
  const stale = age > STALE_MS;
  const a = d.agg;
  const pct = d.target ? a.sockets / d.target : 0;

  if (ONE_LINE || stale) {
    const tag = stale ? `PARADO há ${(age / 1000).toFixed(0)}s` : d.phase;
    out.push(
      `sala ${d.code} ${d.mode} · ${tag} · ${Math.round(d.elapsed)}s · sockets ${a.sockets}/${d.target}` +
      ` · ${d.rate.toFixed(0)}/s · solv ${a.solves} · fech ${a.closed} · lag ${a.lagMax.toFixed(0)}ms`,
    );
    return out;
  }

  out.push(`sala ${d.code}  ${d.mode}  ${d.rounds} rodada(s)  ${d.host}   [${d.phase}]  ${Math.round(d.elapsed)}s`);
  out.push(`  sockets  ${bar(pct)} ${a.sockets}/${d.target}   derrubados ${a.closed}   falhas ${a.failed}`);
  out.push(`  jogo     palpites ${a.guesses} (${d.rate.toFixed(0)}/s) · aceitos ${a.ok} · recusados ${a.rejected} · fecharam ${a.solves}`);
  out.push(`  saúde    lag pior worker ${a.lagMax.toFixed(0)} ms · p95 palpite ${a.latP95} ms · recebido ${fmtBytes(a.inboundBytes)}`);
  out.push('  worker   sockets   palpites   lag p99      RSS');
  for (const w of d.workers) {
    out.push(
      `  ${String(w.id).padEnd(7)}${String(w.sockets).padStart(8)}${String(w.guesses).padStart(11)}` +
      `${(w.lagP99.toFixed(1) + 'ms').padStart(10)}${fmtBytes(w.rss).padStart(9)}`,
    );
  }
  return out;
}

function tick() {
  const lines = render();
  if (drawn && process.stdout.isTTY) process.stdout.write(`\x1b[${drawn}A\x1b[0J`);
  process.stdout.write(`${lines.join('\n')}\n`);
  drawn = process.stdout.isTTY ? lines.length : 0;
}

tick();
const timer = setInterval(tick, EVERY);
process.on('SIGINT', () => { clearInterval(timer); process.stdout.write('\n'); process.exit(0); });
