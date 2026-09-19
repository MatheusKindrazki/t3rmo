import { MODES, CUT_RANKS, type Mode, type Tile } from '@arena/core';

export const KB_ROWS = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L','Ç'],
  ['ENTER','Z','X','C','V','B','N','M','BACK'],
] as const;

/** Board arrangement per mode: [columns, rows] of boards on screen. */
export const GRID: Record<number, [number, number]> = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2] };

/**
 * Best-known state of each typed letter, per board.
 *
 * From DUETO up the same letter can be exact on one board and absent on
 * another, so the keyboard cannot collapse to one colour without lying.
 */
export function keyStates(guesses: string[], tiles: Tile[][][], boards: number): Map<string, (Tile | undefined)[]> {
  const out = new Map<string, (Tile | undefined)[]>();
  for (let b = 0; b < boards; b++) {
    const board = tiles[b] ?? [];
    for (let g = 0; g < guesses.length; g++) {
      const word = guesses[g] ?? '';
      const row = board[g];
      if (!row) continue;
      for (let i = 0; i < word.length; i++) {
        const ch = word[i]!;
        const st = row[i]!;
        const slot = out.get(ch) ?? new Array<Tile | undefined>(boards).fill(undefined);
        const prev = slot[b];
        slot[b] = prev === undefined ? st : ((Math.max(prev, st)) as Tile);
        out.set(ch, slot);
      }
    }
  }
  return out;
}

export function modeOf(m: Mode) { return MODES[m]; }

/**
 * Tile size, fitted to BOTH axes.
 *
 * term.ooo derives its board from viewport height at a 5/6 ratio, which works
 * because it only ever draws one board. QUARTETO draws four, so the fit has to
 * consider width as well or the boards overflow a laptop sideways before they
 * overflow it vertically.
 */
export function tilePx(boards: number, maxGuesses: number, vw: number, vh: number): number {
  const [gx, gy] = GRID[boards] ?? [1, 1];
  // The keyboard's height is not a constant — it shrinks on short viewports
  // (see the max-height rules in styles.css) and the tile fit has to use the
  // same number the stylesheet does, or the board is sized against a keyboard
  // that is no longer there. Same for the header and for the rails, which the
  // height terms in those queries can retire even on a wide screen.
  const GAP = 5, BOARD_GAP = 20;
  const narrow = vw <= 900 || vh <= 520;

  const HEADER = vh <= 540 ? 44 : 54;
  // The vitals row only exists on narrow screens, and forgetting it is exactly
  // how the board came out one row too tall on a phone: sized against space
  // that something else was already occupying, so the top row was clipped by a
  // container that could not grow.
  const VITALS = narrow ? 48 : 0;
  // Must track the keyboard the STYLESHEET renders, not a guess: the keys are
  // 46px under 900px wide and shrink again on short viewports.
  const KBD = vh <= 540 ? 116 : narrow ? 168 : vh <= 640 ? 140 : vh <= 760 ? 162 : 190;
  const PAD = narrow ? 24 : 44;
  const RAILS = vw > 1280 && vh > 620 ? 520 : (vw > 900 && vh > 520) ? 260 : 0;
  const colW = Math.min(vw - RAILS - 24, 720);
  const wFit = (colW - (gx - 1) * BOARD_GAP) / gx / 5 - GAP;
  const hFit = (vh - HEADER - VITALS - KBD - PAD - (gy - 1) * BOARD_GAP) / gy / maxGuesses - GAP;
  return Math.max(18, Math.min(76, Math.floor(Math.min(wFit, hFit))));
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtInt(n: number): string { return n.toLocaleString('pt-BR'); }

/**
 * Approximate rank from the percentile ladder a large room broadcasts instead
 * of addressing every socket individually. The answer is an upper bound — "at
 * worst #250" — and it is replaced by the exact figure the moment the player
 * submits anything.
 */
export function rankFromCuts(score: number, cuts: number[], total: number): number {
  for (let i = 0; i < cuts.length; i++) {
    if (score >= (cuts[i] ?? Infinity)) return CUT_RANKS[i] ?? total;
  }
  return total;
}
