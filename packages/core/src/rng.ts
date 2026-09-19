/** Deterministic PRNG (mulberry32) so a room's word sequence is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Picks `count` distinct items without mutating the source array. */
export function pickDistinct<T>(items: readonly T[], count: number, rand: () => number): T[] {
  if (count >= items.length) return [...items];
  const seen = new Set<number>();
  const out: T[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const i = Math.floor(rand() * items.length);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(items[i]!);
  }
  return out;
}
