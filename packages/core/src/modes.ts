/** The four competitive formats. A guess is applied to every board at once. */
export type Mode = 'termo' | 'dueto' | 'trieto' | 'quarteto';

export interface ModeConfig {
  readonly id: Mode;
  readonly label: string;
  /** How many secret words are solved in parallel. */
  readonly boards: number;
  /** Total guesses shared across all boards. */
  readonly maxGuesses: number;
  /** Round clock, in milliseconds. */
  readonly roundMs: number;
}

export const MODES: Record<Mode, ModeConfig> = {
  termo:    { id: 'termo',    label: 'TERMO',    boards: 1, maxGuesses: 6, roundMs: 150_000 },
  dueto:    { id: 'dueto',    label: 'DUETO',    boards: 2, maxGuesses: 7, roundMs: 180_000 },
  trieto:   { id: 'trieto',   label: 'TRIETO',   boards: 3, maxGuesses: 8, roundMs: 210_000 },
  quarteto: { id: 'quarteto', label: 'QUARTETO', boards: 4, maxGuesses: 9, roundMs: 240_000 },
};

export const MODE_IDS: readonly Mode[] = ['termo', 'dueto', 'trieto', 'quarteto'];

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);
}

export const WORD_LENGTH = 5;
