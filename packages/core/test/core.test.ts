import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, normalize, isSolved } from '../src/evaluate.ts';
import { MODES, MODE_IDS } from '../src/modes.ts';
import { scoreRound, compareStandings, assertAttemptsDominate, type Standing } from '../src/scoring.ts';
import { isValidGuess, drawAnswers, ANSWERS } from '../src/dict.ts';

test('normalize bridges accents so players can type plainly', () => {
  assert.equal(normalize('açúcar'), 'ACUCAR');
  assert.equal(normalize('AVIÃO'), 'AVIAO');
  assert.equal(normalize('Ópera'), 'OPERA');
});

test('duplicate letters: exact hits claim the pool before present hits', () => {
  // The classic one-pass bug: every A would be marked "present" against BANCO.
  assert.deepEqual(evaluate('AAAAA', 'BANCO'), [0, 2, 0, 0, 0]);
  // TERRA has two Rs; guessing three must only light two of them.
  assert.deepEqual(evaluate('RRRRR', 'TERRA'), [0, 0, 2, 2, 0]);
  // One O in guess, one in answer, wrong slot.
  assert.deepEqual(evaluate('OLHAR', 'CORPO'), [1, 0, 0, 0, 1]);
});

test('a repeated letter only lights as many times as the answer holds it', () => {
  // CASAL has one S and two As. SALSA spends: S(0) present, A(1) exact,
  // L(2) present, S(3) gets nothing because the single S was already claimed,
  // A(4) present from the second A.
  assert.deepEqual(evaluate('SALSA', 'CASAL'), [1, 2, 1, 0, 1]);
});

test('solved detection', () => {
  assert.equal(isSolved(evaluate('TERMO', 'TERMO')), true);
  assert.equal(isSolved(evaluate('TERMO', 'TERNO')), false);
});

test('accented answer is solved by the unaccented guess', () => {
  assert.equal(isSolved(evaluate('AVIAO', 'AVIÃO')), true);
  assert.equal(isSolved(evaluate('ACIDO', 'ÁCIDO')), true);
});

test('fewer attempts always beats more attempts, at every mode', () => {
  for (const id of MODE_IDS) assertAttemptsDominate(MODES[id]);
});

test('the attempts axis outranks the clock, concretely', () => {
  const m = MODES.termo;
  const slowIn3 = scoreRound({ wordsSolved: 1, guessesUsed: 3, elapsedMs: m.roundMs, streakBefore: 0 }, m);
  const fastIn4 = scoreRound({ wordsSolved: 1, guessesUsed: 4, elapsedMs: 0, streakBefore: 0 }, m);
  assert.ok(slowIn3.total > fastIn4.total,
    `3 guesses at the buzzer (${slowIn3.total}) must beat 4 guesses instantly (${fastIn4.total})`);
});

test('the clock breaks ties inside one attempt bracket', () => {
  const m = MODES.dueto;
  const quick = scoreRound({ wordsSolved: 2, guessesUsed: 4, elapsedMs: 10_000, streakBefore: 0 }, m);
  const slow = scoreRound({ wordsSolved: 2, guessesUsed: 4, elapsedMs: 120_000, streakBefore: 0 }, m);
  assert.ok(quick.total > slow.total);
});

test('partial solves still score, unsolved rounds do not get bonuses', () => {
  const m = MODES.quarteto;
  const partial = scoreRound({ wordsSolved: 3, guessesUsed: 9, elapsedMs: m.roundMs, streakBefore: 0 }, m);
  assert.equal(partial.fullSolve, false);
  assert.equal(partial.attempts, 0);
  assert.equal(partial.speed, 0);
  assert.ok(partial.total > 0, 'three of four boards is real work and must score');
});

test('standings sort by score, then fewer guesses, then time', () => {
  const mk = (o: Partial<Standing>): Standing =>
    ({ id: 'x', name: 'x', score: 0, guesses: 0, solvedWords: 0, timeMs: 0, streak: 0, ...o });
  const rows = [
    mk({ id: 'c', score: 100, guesses: 4, timeMs: 1000 }),
    mk({ id: 'a', score: 100, guesses: 3, timeMs: 9000 }),
    mk({ id: 'b', score: 100, guesses: 3, timeMs: 5000 }),
    mk({ id: 'd', score: 200, guesses: 6, timeMs: 9999 }),
  ].sort(compareStandings);
  assert.deepEqual(rows.map((r) => r.id), ['d', 'b', 'a', 'c']);
});

test('every curated answer is a legal guess', () => {
  const rejected = ANSWERS.filter((a) => !isValidGuess(a));
  assert.deepEqual(rejected, [], 'an answer the dictionary rejects loses the round for whoever types it');
});

test('conjugated forms players actually type are accepted', () => {
  for (const w of ['TINHA', 'PODIA', 'POSSO', 'TENHO', 'ESTAO', 'VAMOS', 'FIQUE', 'DEVEM']) {
    assert.equal(isValidGuess(w), true, `${w} must be a legal guess`);
  }
});

test('junk is rejected', () => {
  for (const w of ['XXXXX', 'ABCDE', 'QQQQQ', 'ZZZZZ']) assert.equal(isValidGuess(w), false);
});

test('a round draws distinct answers and is reproducible from the seed', () => {
  const a = drawAnswers('sala-a7x', 3, 4);
  const b = drawAnswers('sala-a7x', 3, 4);
  assert.deepEqual(a, b, 'same seed and round must redraw identically');
  assert.equal(new Set(a).size, 4, 'no repeated word inside one round');
  assert.notDeepEqual(drawAnswers('sala-a7x', 4, 4), a, 'next round must differ');
});
