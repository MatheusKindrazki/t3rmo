import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, normalize, isSolved } from '../src/evaluate.ts';
import { MODES, MODE_IDS, MISTO_RUNGS, ROUND_CONFIGS, roundConfig } from '../src/modes.ts';
import {
  scoreRound, compareStandings, assertAttemptsDominate, type Standing,
  WORD_POINTS, ATTEMPT_STEP, SPEED_MAX, PERFECT_BONUS, STREAK_MAX,
} from '../src/scoring.ts';
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

test('tempo scales the clock linearly and never breaks attempt-dominance', () => {
  // The host's tempo multiplier scales roundMs and nothing else. pace=1 must be
  // the exact same object shape; other paces scale the clock; and the scoring
  // invariant has to survive every pace, since a wrong scale would let the clock
  // outrank an attempt (the whole game's promise).
  for (const id of MODE_IDS) {
    assert.equal(roundConfig(id, 1, 1).roundMs, MODES[id].roundMs, `${id} pace=1 is identity`);
  }
  for (const pace of [0.5, 0.6, 1, 1.4, 2]) {
    for (const round of [1, 2, 3, 4]) {
      const base = roundConfig('misto', round);
      const scaled = roundConfig('misto', round, pace);
      assert.equal(scaled.roundMs, Math.round(base.roundMs * pace), `misto r${round} @${pace}`);
      assert.equal(scaled.boards, base.boards, 'pace never touches the board count');
      assert.equal(scaled.bounty, base.bounty, 'pace never touches the payout');
      assertAttemptsDominate(scaled); // the invariant holds at every tempo
    }
    for (const id of MODE_IDS) assertAttemptsDominate(roundConfig(id, 1, pace));
  }
});

test('fewer attempts always beats more attempts, in every playable config', () => {
  // ROUND_CONFIGS and not MODES: each MISTO rung governs real rounds under an
  // id that MODES maps to something else entirely.
  for (const cfg of ROUND_CONFIGS) assertAttemptsDominate(cfg);
  assert.ok(ROUND_CONFIGS.length >= MODE_IDS.length + MISTO_RUNGS.length);
});

test('the bounty rewrite pays exactly what the flat per-word award paid', () => {
  // The entire safety argument for adding MISTO is that bounty / boards is
  // exactly WORD_POINTS for every single-format mode, so the new expression
  // cannot move a point of an existing match. Asserted over the whole legal
  // input space rather than spot-checked, because "should be equivalent" is the
  // kind of claim that is true for the three cases somebody tried.
  let checked = 0;
  for (const id of MODE_IDS) {
    const m = MODES[id];
    assert.equal(m.bounty, WORD_POINTS * m.boards, `${id} is not a flat-rate mode`);
    for (let wordsSolved = 0; wordsSolved <= m.boards; wordsSolved++) {
      for (let guessesUsed = m.boards; guessesUsed <= m.maxGuesses; guessesUsed++) {
        for (const elapsedMs of [0, 1000, m.roundMs]) {
          for (let streakBefore = 0; streakBefore <= 6; streakBefore++) {
            const got = scoreRound({ wordsSolved, guessesUsed, elapsedMs, streakBefore }, m);
            assert.equal(got.words, WORD_POINTS * wordsSolved,
              `${id} w=${wordsSolved} g=${guessesUsed} t=${elapsedMs} s=${streakBefore}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 500, `only ${checked} combinations covered`);
});

test('MISTO escalates TERMO to QUARTETO and then cycles', () => {
  const shape = (round: number) => {
    const c = roundConfig('misto', round);
    return [c.label, c.boards, c.maxGuesses];
  };
  assert.deepEqual(shape(1), ['TERMO', 1, 6]);
  assert.deepEqual(shape(2), ['DUETO', 2, 7]);
  assert.deepEqual(shape(3), ['TRIETO', 3, 8]);
  assert.deepEqual(shape(4), ['QUARTETO', 4, 9]);
  assert.deepEqual(shape(5), shape(1), 'a fifth round starts the ladder over');
  assert.deepEqual(shape(8), shape(4));
  // The lobby sits on round 0 and has to preview something; rung 1 is what the
  // room is about to play.
  assert.deepEqual(shape(0), shape(1));
  for (const id of MODE_IDS) {
    if (id === 'misto') continue;
    assert.equal(roundConfig(id, 3), MODES[id], `${id} must ignore the round number`);
  }
});

test('escalating in MISTO is never a shortcut past a strong early round', () => {
  // The constraint the 250-point bounty step exists to satisfy. A sloppy late
  // round must not outscore a sharp early one just for being worth more.
  const strongTermo = scoreRound(
    { wordsSolved: 1, guessesUsed: 3, elapsedMs: 30_000, streakBefore: 0 },
    MODES.termo,
  ).total;
  const sloppiestQuarteto = scoreRound(
    { wordsSolved: 4, guessesUsed: 9, elapsedMs: MISTO_RUNGS[3]!.roundMs, streakBefore: 99 },
    MISTO_RUNGS[3]!,
  ).total;
  assert.equal(strongTermo, 2983);
  assert.ok(sloppiestQuarteto < strongTermo,
    `the worst full QUARTETO (${sloppiestQuarteto}) must lose to a sharp TERMO (${strongTermo})`);
});

test('MISTO rungs pay within 1.16:1 of each other, the flat modes 1.625:1', () => {
  // The whole point of the compressed bounties: which rung you happen to be
  // strongest at should not decide the match.
  const ceiling = (m: typeof MODES.termo) =>
    scoreRound({ wordsSolved: m.boards, guessesUsed: m.boards, elapsedMs: 0, streakBefore: 99 }, m).total;
  const rungs = MISTO_RUNGS.map(ceiling);
  assert.deepEqual(rungs, [4800, 5050, 5300, 5550]);
  // Every ceiling is its bounty plus the format-blind maximum, which is what
  // makes bounty the only balancing dial there is.
  const blind = ATTEMPT_STEP * 5 + SPEED_MAX + PERFECT_BONUS + STREAK_MAX;
  assert.deepEqual(rungs, MISTO_RUNGS.map((m) => m.bounty + blind));
  assert.ok(rungs[3]! / rungs[0]! < 1.16, `spread ${rungs[3]! / rungs[0]!}`);
  const flat = [MODES.termo, MODES.dueto, MODES.trieto, MODES.quarteto].map(ceiling);
  assert.deepEqual(flat, [4800, 5800, 6800, 7800]);
  assert.ok(flat[3]! / flat[0]! > 1.6, 'the single-format spread is the thing MISTO compresses');
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
