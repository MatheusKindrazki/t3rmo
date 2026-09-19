/** The competitive formats. A guess is applied to every board at once. */
export type Mode = 'termo' | 'dueto' | 'trieto' | 'quarteto' | 'misto';

export interface ModeConfig {
  readonly id: Mode;
  readonly label: string;
  /** How many secret words are solved in parallel. */
  readonly boards: number;
  /** Total guesses shared across all boards. */
  readonly maxGuesses: number;
  /**
   * What a round pays for cracking its whole set, handed out pro rata per board.
   *
   * This is the only number in scoring.ts that knows which format it is
   * scoring. Everything else is format-blind by construction: the efficiency
   * span is `maxGuesses - boards`, every single-format mode sets
   * `maxGuesses = boards + 5`, so attempts, speed, perfect and streak are
   * capped identically in TERMO and in QUARTETO. Balancing a format is
   * therefore entirely a matter of choosing its bounty.
   *
   * For the single-format modes bounty is WORD_POINTS x boards, which makes
   * `bounty / boards` exactly WORD_POINTS and the award identical to the flat
   * per-word one it replaced. MISTO is the only place the ratio differs.
   */
  readonly bounty: number;
  /** Round clock, in milliseconds. */
  readonly roundMs: number;
}

export const MODES: Record<Mode, ModeConfig> = {
  termo:    { id: 'termo',    label: 'TERMO',    boards: 1, maxGuesses: 6, bounty: 1000, roundMs: 150_000 },
  dueto:    { id: 'dueto',    label: 'DUETO',    boards: 2, maxGuesses: 7, bounty: 2000, roundMs: 180_000 },
  trieto:   { id: 'trieto',   label: 'TRIETO',   boards: 3, maxGuesses: 8, bounty: 3000, roundMs: 210_000 },
  quarteto: { id: 'quarteto', label: 'QUARTETO', boards: 4, maxGuesses: 9, bounty: 4000, roundMs: 240_000 },
  // A MISTO room does not play this config — `roundConfig` swaps in a rung per
  // round. It mirrors rung 1 so anything that reads MODES[mode] before the
  // first round (lobby preview, /api/health) previews what round 1 will be.
  misto:    { id: 'misto',    label: 'MISTO',    boards: 1, maxGuesses: 6, bounty: 1000, roundMs: 90_000 },
};

export const MODE_IDS: readonly Mode[] = ['termo', 'dueto', 'trieto', 'quarteto', 'misto'];

/**
 * MISTO: one match that escalates. Round 1 is a TERMO, round 2 a DUETO, and so
 * on to QUARTETO, then back to the top.
 *
 * The rungs differ from the single-format modes only in bounty and clock, and
 * the bounty step of 250 is load-bearing — do not round it to something
 * prettier. The constraint is that escalation must not become a shortcut: the
 * sloppiest conceivable QUARTETO (all nine guesses, solved on the buzzer, streak
 * maxed = 1750 + 300) must still lose to a strong TERMO round (three guesses at
 * 30s of 150s = 2983). That caps the per-rung step below 561; 250 sits at 45% of
 * the ceiling, leaving room for the tuning nobody has done yet.
 *
 * The payoff is compression. Max round score runs 4800 / 5050 / 5300 / 5550 — a
 * 1.156:1 spread, against the 1.625:1 the single-format bounties produce. A
 * player who happens to be strongest at DUETO is not handed the match by the
 * schedule.
 */
export const MISTO_RUNGS: readonly ModeConfig[] = [
  { id: 'misto', label: 'TERMO',    boards: 1, maxGuesses: 6, bounty: 1000, roundMs:  90_000 },
  { id: 'misto', label: 'DUETO',    boards: 2, maxGuesses: 7, bounty: 1250, roundMs: 120_000 },
  { id: 'misto', label: 'TRIETO',   boards: 3, maxGuesses: 8, bounty: 1500, roundMs: 165_000 },
  { id: 'misto', label: 'QUARTETO', boards: 4, maxGuesses: 9, bounty: 1750, roundMs: 210_000 },
];

/**
 * The config actually governing a round.
 *
 * Everything that used to read `MODES[mode]` to size a board, a guess budget or
 * a clock has to come through here instead, because in MISTO those three things
 * change under the room every round. `round` is 1-based; round 0 is the lobby,
 * which previews rung 1.
 */
export function roundConfig(mode: Mode, round: number): ModeConfig {
  if (mode !== 'misto') return MODES[mode];
  const i = Math.max(0, Math.floor(round) - 1) % MISTO_RUNGS.length;
  return MISTO_RUNGS[i]!;
}

/**
 * Every config that can ever govern a round. The scoring invariant has to be
 * proven over this list, not over MODES — a MISTO rung is a config no entry of
 * MODES is equal to.
 */
export const ROUND_CONFIGS: readonly ModeConfig[] = [
  ...MODE_IDS.map((id) => MODES[id]),
  ...MISTO_RUNGS,
];

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);
}

export const WORD_LENGTH = 5;
