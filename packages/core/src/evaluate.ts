import { WORD_LENGTH } from './modes.ts';

/** 0 = absent, 1 = present elsewhere, 2 = exact position. */
export type Tile = 0 | 1 | 2;

/**
 * Strips diacritics and upper-cases, so players can type "acucar" for "AÇÚCAR".
 * Comparison always happens on the normalized form; display uses the accented one.
 */
export function normalize(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

/**
 * Standard two-pass Wordle scoring.
 *
 * The single pass version is the classic bug: with answer BANCO and guess
 * AAAAA, a naive loop marks every A as "present". Exact hits must be claimed
 * first, and only the letters they leave behind can feed a "present" mark.
 */
export function evaluate(guess: string, answer: string): Tile[] {
  const g = normalize(guess);
  const a = normalize(answer);
  const tiles: Tile[] = new Array(WORD_LENGTH).fill(0);

  // Pass 1: exact positions consume their letter from the pool.
  const pool = new Map<string, number>();
  for (let i = 0; i < WORD_LENGTH; i++) {
    const ac = a[i]!;
    if (g[i] === ac) tiles[i] = 2;
    else pool.set(ac, (pool.get(ac) ?? 0) + 1);
  }

  // Pass 2: remaining letters claim from whatever the pool still holds.
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (tiles[i] === 2) continue;
    const gc = g[i]!;
    const left = pool.get(gc) ?? 0;
    if (left > 0) {
      tiles[i] = 1;
      pool.set(gc, left - 1);
    }
  }
  return tiles;
}

export function isSolved(tiles: readonly Tile[]): boolean {
  return tiles.length === WORD_LENGTH && tiles.every((t) => t === 2);
}

/** Best-known state of a letter, used to paint the keyboard. 2 beats 1 beats 0. */
export function mergeKeyState(a: Tile | undefined, b: Tile): Tile {
  if (a === undefined) return b;
  return (Math.max(a, b) as Tile);
}
