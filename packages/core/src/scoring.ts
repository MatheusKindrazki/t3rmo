import type { ModeConfig } from './modes.ts';

/**
 * Competitive scoring.
 *
 * The rule the room is sold on is "whoever wins in the fewest attempts goes to
 * the front". With a thousand players that rule alone produces enormous ties —
 * in TERMO the entire top of the table lands on 3 guesses — so the clock has to
 * break ties. The danger is the clock breaking more than ties.
 *
 * So dominance is made STRUCTURAL rather than a numeric coincidence:
 *
 *     ATTEMPT_STEP  >  SPEED_MAX + STREAK_MAX
 *
 * One extra guess costs more than every tiebreaker in the game can hand back.
 * A player who solved in n guesses therefore cannot be passed, in that round,
 * by anyone who needed n+1 — no matter how fast they were or how hot a streak
 * they carried. `assertAttemptsDominate` proves it at module load, and the
 * first version of this file shipped with 280 < 450 and violated it silently.
 */
export const WORD_POINTS = 1000;
/** Points surrendered per guess beyond the theoretical minimum. */
export const ATTEMPT_STEP = 600;
/** Maximum the clock can contribute. Strictly below one attempt step. */
export const SPEED_MAX = 250;
/** Awarded only on a flawless round (no guess wasted). */
export const PERFECT_BONUS = 250;
export const STREAK_POINTS = 60;
export const STREAK_CAP = 5;
export const STREAK_MAX = STREAK_POINTS * STREAK_CAP;

export interface RoundPerformance {
  /** How many of the round's secret words this player cracked. */
  wordsSolved: number;
  /** Guesses actually submitted. */
  guessesUsed: number;
  /** Time from round start to the last solve, in ms. Round length if unsolved. */
  elapsedMs: number;
  /** Consecutive prior rounds fully solved, feeding the streak bonus. */
  streakBefore: number;
}

export interface RoundScore {
  total: number;
  words: number;
  attempts: number;
  speed: number;
  perfect: number;
  streak: number;
  fullSolve: boolean;
}

export function scoreRound(perf: RoundPerformance, mode: ModeConfig): RoundScore {
  const boards = mode.boards;
  const fullSolve = perf.wordsSolved >= boards;

  // Partial credit always counts: cracking 3 of 4 boards in QUARTETO is real work.
  const words = Math.max(0, Math.min(boards, perf.wordsSolved)) * WORD_POINTS;

  let attempts = 0;
  let speed = 0;
  let perfect = 0;
  let streak = 0;

  if (fullSolve) {
    // N boards cannot fall in fewer than N guesses, so N is the floor and
    // efficiency is measured from there rather than from a single guess.
    const span = Math.max(1, mode.maxGuesses - boards);
    const over = Math.min(span, Math.max(0, perf.guessesUsed - boards));
    attempts = ATTEMPT_STEP * (span - over);

    const t = Math.min(1, Math.max(0, perf.elapsedMs / mode.roundMs));
    // Concave decay: the opening seconds are worth far more than the closing
    // ones, which is what makes a room race instead of idling to the buzzer.
    speed = Math.round(SPEED_MAX * Math.pow(1 - t, 1.4));

    if (over === 0) perfect = PERFECT_BONUS;
    streak = STREAK_POINTS * Math.min(STREAK_CAP, Math.max(0, perf.streakBefore));
  }

  return { total: words + attempts + speed + perfect + streak, words, attempts, speed, perfect, streak, fullSolve };
}

/**
 * Proves the headline promise for a mode: the worst imaginable round at k
 * guesses still outscores the best imaginable round at k+1 — slowest possible
 * clock and zero streak against instant solve on a maxed streak.
 */
export function assertAttemptsDominate(mode: ModeConfig): void {
  for (let g = mode.boards; g < mode.maxGuesses; g++) {
    const worstAtK = scoreRound(
      { wordsSolved: mode.boards, guessesUsed: g, elapsedMs: mode.roundMs, streakBefore: 0 },
      mode,
    ).total;
    const bestAtKPlus1 = scoreRound(
      { wordsSolved: mode.boards, guessesUsed: g + 1, elapsedMs: 0, streakBefore: STREAK_CAP },
      mode,
    ).total;
    if (worstAtK <= bestAtKPlus1) {
      throw new Error(
        `scoring invariant broken in ${mode.id}: ${g} guesses at the buzzer with no streak ` +
          `(${worstAtK}) does not beat ${g + 1} guesses instantly on a full streak (${bestAtKPlus1})`,
      );
    }
  }
}

export interface Standing {
  id: string;
  name: string;
  score: number;
  guesses: number;
  solvedWords: number;
  timeMs: number;
  streak: number;
}

/**
 * Table order. Score already encodes attempts, but the raw counters stay as
 * explicit tiebreaks so two players on the same score are still separated by
 * the thing they were told matters: fewer guesses, then time.
 */
export function compareStandings(a: Standing, b: Standing): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.guesses !== b.guesses) return a.guesses - b.guesses;
  if (b.solvedWords !== a.solvedWords) return b.solvedWords - a.solvedWords;
  if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
