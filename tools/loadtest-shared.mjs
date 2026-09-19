/**
 * Shared between the load-test coordinator, its workers and the fleet watcher.
 *
 * Node built-ins only, on purpose: this tool has to run from a clean checkout
 * on a machine nobody prepared, and a load test that needs its own install
 * step is a load test that does not get run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the coordinator publishes live state for `fleetwatch.mjs`. */
export const STATUS_PATH = join(tmpdir(), 'termo-loadtest-status.json');

export const arg = (k, d, argv = process.argv) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
export const flag = (k, argv = process.argv) => argv.includes(`--${k}`);

export const normalize = (w) =>
  w.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * The answer pool, read straight out of the source rather than imported: the
 * package is TypeScript and this tool must stay build-free.
 */
export function loadPool() {
  const src = readFileSync(join(ROOT, 'packages/core/src/answers.ts'), 'utf8');
  return [...src.split('= [')[1].split('];')[0].matchAll(/'([^']+)'/g)].map((m) => normalize(m[1]));
}

/** Same two-pass rule the server uses; bots need it to reason about feedback. */
export function evaluate(guess, answer) {
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
export const sameTiles = (a, b) =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];

/**
 * Fixed-bucket histogram.
 *
 * Percentiles have to be merged across processes, and shipping a million raw
 * samples over IPC to do it is absurd. Buckets are 1 ms up to a second and
 * 10 ms up to ten, which is finer than the thing being measured: nobody cares
 * whether p95 was 61 or 62 ms, and everybody cares whether it was 60 or 600.
 * Anything past ten seconds lands in the overflow bucket and is reported as
 * `>=10000`, never silently clipped into the last real bucket.
 */
const FINE = 1000;      // 0..999 ms, 1 ms each
const COARSE = 900;     // 1000..9990 ms, 10 ms each
export const HIST_SIZE = FINE + COARSE + 1;
const OVERFLOW = HIST_SIZE - 1;

export class Hist {
  constructor() { this.b = new Int32Array(HIST_SIZE); this.n = 0; this.sum = 0; this.hi = 0; }
  static idx(v) {
    if (v < FINE) return v < 0 ? 0 : v | 0;
    if (v < 10000) return FINE + (((v - FINE) / 10) | 0);
    return OVERFLOW;
  }
  static value(i) { return i < FINE ? i : i === OVERFLOW ? 10000 : FINE + (i - FINE) * 10; }
  record(v) { this.b[Hist.idx(v)]++; this.n++; this.sum += v; if (v > this.hi) this.hi = v; }
  percentile(p) {
    if (!this.n) return 0;
    const want = Math.max(1, Math.ceil((p / 100) * this.n));
    let seen = 0;
    for (let i = 0; i < HIST_SIZE; i++) {
      seen += this.b[i];
      if (seen >= want) return Hist.value(i);
    }
    return this.hi;
  }
  get mean() { return this.n ? this.sum / this.n : 0; }
  /** Sparse [index, count, ...] — a mostly-empty histogram costs almost nothing. */
  pack() {
    const out = [];
    for (let i = 0; i < HIST_SIZE; i++) if (this.b[i]) out.push(i, this.b[i]);
    return { s: out, n: this.n, sum: this.sum, hi: this.hi };
  }
  merge(p) {
    if (!p) return this;
    for (let k = 0; k < p.s.length; k += 2) this.b[p.s[k]] += p.s[k + 1];
    this.n += p.n; this.sum += p.sum; if (p.hi > this.hi) this.hi = p.hi;
    return this;
  }
}

export const fmtMs = (v) => (v >= 10000 ? '>=10000' : String(v));
export const fmtBytes = (b) =>
  b >= 1024 * 1024 * 1024 ? `${(b / 1024 ** 3).toFixed(2)} GB`
  : b >= 1024 * 1024 ? `${(b / 1024 ** 2).toFixed(2)} MB`
  : `${(b / 1024).toFixed(1)} KB`;
