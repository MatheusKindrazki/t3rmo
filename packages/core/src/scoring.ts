import type { ModeConfig } from './modes.ts';

/**
 * Competitive scoring.
 *
 * "Fewest attempts goes to the front" is the spine, but the clock is not just a
 * tiebreaker any more — speed can lift you PAST people who spent one guess
 * fewer. The bound that keeps that sane is structural, not a lucky number:
 *
 *     ATTEMPT_STEP  <  SPEED_MAX      (speed can cross ONE tier)
 *     SPEED_MAX + STREAK_MAX  <  2 x ATTEMPT_STEP   (never two)
 *
 * So a lightning solve at n+1 guesses can beat a crawling solve at n, but no
 * amount of speed or streak lets an n+2 solve catch a buzzer-beating n. A
 * perfect solve (the minimum guesses) keeps its bonus and so stays hard to
 * pass. `assertScoringBounds` proves both halves at module load, over every
 * playable config — the earlier model made attempts strictly dominant and this
 * is the deliberate move away from it (the room owner asked for the blend).
 */
export const WORD_POINTS = 1000;
/** Points surrendered per guess beyond the theoretical minimum. */
export const ATTEMPT_STEP = 600;
/**
 * Maximum the clock can contribute. ABOVE one attempt step on purpose, so a
 * fast solve can cross a single attempt tier — but capped with STREAK_MAX below
 * two steps so it can never cross two. See assertScoringBounds.
 */
export const SPEED_MAX = 700;
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
  //
  // The bounty is a round total rather than a per-word rate because this is the
  // one term that distinguishes one format from another — see ModeConfig.bounty.
  // For every single-format mode bounty / boards is exactly WORD_POINTS, so this
  // is the flat per-word award it replaced, to the point.
  const words = Math.round((mode.bounty * Math.max(0, Math.min(boards, perf.wordsSolved))) / boards);

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
 * Proves the two halves of the scoring bound for a config: speed may cross ONE
 * attempt tier but never TWO. Concretely — a buzzer solve at k guesses, no
 * streak, still outscores the most gilded solve (instant, full streak) two
 * tiers worse; and, among imperfect solves, an instant solve one tier worse
 * DOES overtake a crawling one, so the blend is not silently inert.
 *
 * Takes a config, not a mode id, because a MISTO rung is a config that no entry
 * of MODES is equal to. Run it over ROUND_CONFIGS.
 */
export function assertScoringBounds(mode: ModeConfig): void {
  const worst = (g: number) =>
    scoreRound({ wordsSolved: mode.boards, guessesUsed: g, elapsedMs: mode.roundMs, streakBefore: 0 }, mode).total;
  const best = (g: number) =>
    scoreRound({ wordsSolved: mode.boards, guessesUsed: g, elapsedMs: 0, streakBefore: STREAK_CAP }, mode).total;

  // Never two tiers: the slowest solve at g beats the best possible two worse.
  for (let g = mode.boards; g + 2 <= mode.maxGuesses; g++) {
    if (worst(g) <= best(g + 2)) {
      throw new Error(
        `scoring bound broken in ${mode.id}/${mode.label}: a buzzer solve at ${g} guesses with no streak ` +
          `(${worst(g)}) is caught by an instant, full-streak solve two tiers worse at ${g + 2} (${best(g + 2)})`,
      );
    }
  }

  // Blend is live: among imperfect solves an instant solve one tier worse passes
  // a crawling one. Starts one tier below perfect, which keeps its own bonus.
  if (mode.boards + 2 <= mode.maxGuesses) {
    const slow = worst(mode.boards + 1);
    const fast = scoreRound(
      { wordsSolved: mode.boards, guessesUsed: mode.boards + 2, elapsedMs: 0, streakBefore: 0 },
      mode,
    ).total;
    if (fast <= slow) {
      throw new Error(
        `scoring blend inert in ${mode.id}/${mode.label}: a lightning solve at ${mode.boards + 2} guesses ` +
          `(${fast}) cannot pass a crawling solve one tier better at ${mode.boards + 1} (${slow})`,
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
