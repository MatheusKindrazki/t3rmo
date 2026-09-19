/**
 * Server-only word data.
 *
 * Deliberately NOT re-exported from the package index. The validation
 * dictionary is ~100 KB and the answer pool must never reach a browser, so the
 * client imports `@arena/core` and the Durable Object imports
 * `@arena/core/dict`. A guess already costs a round trip, so validating it
 * server-side loses nothing: the only thing client-side validation would have
 * saved is a round trip on the error path.
 */
import { DICT_PACKED, DICT_COUNT } from './words.generated.ts';
import { ANSWERS } from './answers.ts';
import { normalize } from './evaluate.ts';
import { mulberry32, hashSeed, pickDistinct } from './rng.ts';

export { ANSWERS, DICT_COUNT };

let lookup: Set<string> | null = null;

/** Unpacked lazily: the DO pays the ~100 KB Set build once per isolate. */
function dictionary(): Set<string> {
  if (lookup) return lookup;
  const s = new Set<string>();
  for (let i = 0; i < DICT_PACKED.length; i += 5) s.add(DICT_PACKED.slice(i, i + 5));
  lookup = s;
  return s;
}

export function isValidGuess(word: string): boolean {
  const n = normalize(word);
  return n.length === 5 && dictionary().has(n);
}

/** Answers for one round, distinct within the round and reproducible from the seed. */
export function drawAnswers(roomSeed: string, round: number, count: number): string[] {
  const rand = mulberry32(hashSeed(`${roomSeed}#${round}`));
  return pickDistinct(ANSWERS, count, rand);
}
