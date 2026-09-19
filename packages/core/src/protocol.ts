import type { Mode } from './modes.ts';
import type { Tile } from './evaluate.ts';

export const PROTOCOL_VERSION = 1;

/** Base cadence for a small room. Large rooms slow down — see `tickMsFor`. */
export const TICK_MS = 500;

/**
 * Tick cadence as a function of room size.
 *
 * Egress is `frame x players x rate`. At ~640 B a frame, holding 2 Hz all the
 * way up means 3.8 MB/s at 3000 players and 12.8 MB/s at 10000 — and measured
 * at 3000, the tick itself starts drifting (p95 504 -> 660 ms) because the room
 * cannot finish one fan-out before the next is due. Slowing the clock as the
 * crowd grows keeps egress roughly flat and the cadence honest. Nobody notices:
 * the countdown runs locally, and at 3000 players the top of the table changes
 * far faster than anyone can read it anyway.
 */
export function tickMsFor(players: number): number {
  if (players <= 400) return 500;
  if (players <= 1500) return 750;
  if (players <= 4000) return 1000;
  return 1500;
}

/**
 * Above this headcount the per-socket personal splice is dropped and clients
 * locate themselves against `cuts` instead. Exact rank still arrives with every
 * `result`, so the number is exact whenever the player actually did something.
 */
export const EXACT_RANK_LIMIT = 800;

/** Ranks sampled into the `cuts` ladder, in order. */
export const CUT_RANKS = [1, 2, 3, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/** How many opponents' boards are mirrored into the frame. */
export const SPY_N = 6;
/** A frame is emitted even with nothing new, so clients can detect a dead room. */
export const HEARTBEAT_MS = 5_000;
/** Minimum spacing between two guesses from the same socket. */
export const GUESS_COOLDOWN_MS = 200;
/** How many rows ride in the broadcast frame. Deeper pages are pulled on demand. */
export const TOP_N = 12;
/** Upper bound on a single leaderboard page request. */
export const PAGE_MAX = 100;

export type Phase = 'lobby' | 'countdown' | 'playing' | 'intermission' | 'finished';

/* ------------------------------------------------------------------ client -> server */

export type ClientMessage =
  | { t: 'join'; name: string; clientId: string; v: number }
  | { t: 'guess'; word: string; seq: number }
  | { t: 'config'; mode?: Mode; rounds?: number }
  | { t: 'start' }
  | { t: 'page'; from: number; to: number }
  | { t: 'ping'; ts: number };

/* ------------------------------------------------------------------ server -> client */

/**
 * Compact leaderboard row: [rank, id, name, score, guesses, solvedWords, isYou].
 *
 * The short id costs ~8 bytes a row and buys the one thing the live table is
 * for: a stable React key, so a rank change animates as a player physically
 * sliding past another instead of two rows swapping their text. Names cannot
 * do that job — they are user-chosen and collide.
 */
export type RowWire = [number, string, string, number, number, number, 0 | 1];

/** Compact feed entry: [kind, name, value]. */
export type FeedWire = [FeedKind, string, number];
export type FeedKind = 'solve' | 'lead' | 'join' | 'perfect' | 'out';

/**
 * The round's effective shape: boards, guess budget, label.
 *
 * Short keys because this rides in every `state` frame the room fans out, and
 * a lobby of thousands gets one on every host config change. It is not in
 * `tick`, so the three fields cost nothing on the hot path.
 *
 * It exists because `mode` stopped being enough to derive the board count: a
 * MISTO room plays a different format every round, and a client sizing its grid
 * from MODES[room.mode] would draw one board through a QUARTETO.
 */
export interface RoundCfgWire {
  /** Boards in play this round. */
  b: number;
  /** Guesses allowed this round. */
  g: number;
  /** What to call this round — 'TERMO', 'QUARTETO', … even inside MISTO. */
  l: string;
}

export interface RoomSnapshot {
  code: string;
  mode: Mode;
  phase: Phase;
  round: number;
  rounds: number;
  online: number;
  /** Absolute server-clock deadline of the current phase, in ms. */
  deadline: number;
  hostId: string | null;
  /** Config of the round in progress, or of the next one while in lobby. */
  cfg: RoundCfgWire;
}

/** Everything a player needs to redraw their own boards from scratch. */
export interface PlayerBoardState {
  /** guesses[i] is the i-th word this player submitted, already normalized. */
  guesses: string[];
  /** tiles[board][guessIndex] = the five tiles for that board. */
  tiles: Tile[][][];
  solved: boolean[];
  finished: boolean;
  score: number;
  streak: number;
}

export type ServerMessage =
  | { t: 'welcome'; you: { id: string; name: string; isHost: boolean }; room: RoomSnapshot; now: number }
  | { t: 'state'; room: RoomSnapshot; board: PlayerBoardState | null; now: number }
  | { t: 'roundStart'; room: RoomSnapshot; boards: number; maxGuesses: number; now: number }
  | {
      t: 'result';
      seq: number;
      ok: true;
      word: string;
      tiles: Tile[][];
      solved: boolean[];
      guessesUsed: number;
      finished: boolean;
      score: number;
      rank: number;
    }
  | { t: 'result'; seq: number; ok: false; reason: 'unknown-word' | 'too-fast' | 'closed' | 'duplicate' }
  | {
      t: 'tick';
      now: number;
      online: number;
      solved: number;
      /** histogram[k] = players who fully solved using k+1 guesses. */
      hist: number[];
      top: RowWire[];
      feed: FeedWire[];
      /**
       * Live boards of the leaders: [id, packed tiles of board 1].
       *
       * Digits only, never letters — you watch a rival go three-teal without
       * learning which letters got them there. This is the whole "watch the
       * room play" affordance, and it leaks nothing a scoreboard would not.
       */
      spy?: [string, string][];
      /**
       * Score at each rank in CUT_RANKS, truncated to the ranks that exist.
       * Present only in rooms too large for an exact per-socket rank; the
       * client interpolates its position from its own known score.
       */
      cuts?: number[];
      /** Personal slice, appended per socket: [rank, score, guessesUsed]. */
      me?: [number, number, number];
    }
  | {
      t: 'roundEnd';
      room: RoomSnapshot;
      answers: string[];
      you: { score: number; rank: number; solvedWords: number; guesses: number; roundScore: number } | null;
      podium: RowWire[];
    }
  | {
      t: 'matchEnd';
      room: RoomSnapshot;
      standings: RowWire[];
      /**
       * The final round's words. They are here as well as in `roundEnd` because
       * the last round never passes through an intermission — `endRound` has
       * already set the phase to 'finished' by the time its frame is built — so
       * a reveal gated on 'intermission' would never fire for the round the
       * whole match ended on.
       */
      answers: string[];
      you: { rank: number; score: number } | null;
    }
  | { t: 'page'; from: number; rows: RowWire[]; total: number }
  | { t: 'pong'; ts: number; now: number }
  | { t: 'error'; code: string; message: string };

/**
 * The broadcast frame is serialized ONCE per tick and then given a per-socket
 * personal suffix by string splice, so a thousand recipients cost a thousand
 * small concatenations instead of a thousand JSON.stringify calls over the
 * whole object. `encodeTick`/`spliceMe` are the two halves of that trick and
 * must stay in sync: the shared part is emitted without `me`, always ending in
 * `}`, and the suffix re-opens it.
 */
export function encodeTickShared(frame: Omit<Extract<ServerMessage, { t: 'tick' }>, 'me'>): string {
  return JSON.stringify(frame);
}

export function spliceMe(shared: string, me: [number, number, number]): string {
  return `${shared.slice(0, -1)},"me":[${me[0]},${me[1]},${me[2]}]}`;
}
