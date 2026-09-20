/**
 * Personal record, kept on the device.
 *
 * term.ooo keeps its "progresso" in localStorage and so does this, for the same
 * reason: no account, no login, no server row per player. The difference is
 * what gets counted. term.ooo is solitaire, so games and streaks are the whole
 * story; here the number that decides everything is the average number of
 * attempts, because that is the axis the ranking is built on. Position is
 * tracked beside it so a player can see whether the field got harder.
 *
 * Stored per mode: an average built from TERMO and QUARTETO rounds mixed
 * together would be meaningless — they have different floors.
 */
import type { Mode } from '@arena/core';

const KEY = 'arena.stats.v2';

export interface ModeStats {
  rounds: number;
  solved: number;
  fails: number;
  /** dist[i] = rounds fully solved using i+1 guesses. */
  dist: number[];
  guessSum: number;
  streak: number;
  bestStreak: number;
  matches: number;
  wins: number;
  podiums: number;
  bestRank: number;
  rankSum: number;
  rankCount: number;
}

export type AllStats = Partial<Record<Mode, ModeStats>>;

export function emptyMode(): ModeStats {
  return {
    rounds: 0, solved: 0, fails: 0, dist: [], guessSum: 0,
    streak: 0, bestStreak: 0, matches: 0, wins: 0, podiums: 0,
    bestRank: 0, rankSum: 0, rankCount: 0,
  };
}

export function loadStats(): AllStats {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AllStats) : {};
  } catch {
    return {};
  }
}

function save(all: AllStats): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

export function recordRound(
  mode: Mode,
  r: { solvedWords: number; boards: number; guesses: number; rank: number },
): AllStats {
  const all = loadStats();
  const m = all[mode] ?? emptyMode();
  const full = r.solvedWords >= r.boards;

  m.rounds += 1;
  if (full) {
    m.solved += 1;
    m.guessSum += r.guesses;
    const i = Math.max(0, r.guesses - 1);
    while (m.dist.length <= i) m.dist.push(0);
    m.dist[i] = (m.dist[i] ?? 0) + 1;
    m.streak += 1;
    m.bestStreak = Math.max(m.bestStreak, m.streak);
  } else {
    m.fails += 1;
    m.streak = 0;
  }
  if (r.rank > 0) {
    m.rankSum += r.rank;
    m.rankCount += 1;
    m.bestRank = m.bestRank === 0 ? r.rank : Math.min(m.bestRank, r.rank);
  }
  all[mode] = m;
  save(all);
  return all;
}

export function recordMatch(mode: Mode, rank: number): AllStats {
  const all = loadStats();
  const m = all[mode] ?? emptyMode();
  m.matches += 1;
  if (rank === 1) m.wins += 1;
  if (rank > 0 && rank <= 3) m.podiums += 1;
  all[mode] = m;
  save(all);
  return all;
}

export const avgGuesses = (m: ModeStats) => (m.solved ? m.guessSum / m.solved : 0);
export const avgRank = (m: ModeStats) => (m.rankCount ? m.rankSum / m.rankCount : 0);
export const winRate = (m: ModeStats) => (m.rounds ? (m.solved / m.rounds) * 100 : 0);

/** Solo practice is deliberately stored outside competitive statistics. */
export function loadTrainingStats(): { sessions: number; solved: number; guesses: number } {
  try { return JSON.parse(localStorage.getItem('arena.training.v1') ?? 'null') ?? { sessions: 0, solved: 0, guesses: 0 }; }
  catch { return { sessions: 0, solved: 0, guesses: 0 }; }
}
export function recordTraining(solved: boolean, guesses: number): void {
  const previous = loadTrainingStats();
  try { localStorage.setItem('arena.training.v1', JSON.stringify({ sessions: previous.sessions + 1, solved: previous.solved + Number(solved), guesses: previous.guesses + guesses })); } catch { /* private mode */ }
}


const seenReceipts = new Set<string>();
/** Receipt IDs survive reloads, but are bounded; no personal data or tokens. */
export function claimReceipt(id: string): boolean {
  if (seenReceipts.has(id)) return false;
  let previous: string[] = [];
  try { const parsed: unknown = JSON.parse(localStorage.getItem('arena.receipts.v1') ?? '[]'); if(Array.isArray(parsed)) previous=parsed.filter((x): x is string=>typeof x==='string'); } catch { /* no persistent storage */ }
  if(previous.includes(id)) {seenReceipts.add(id);return false;}
  seenReceipts.add(id);
  if(seenReceipts.size>1024) seenReceipts.delete(seenReceipts.values().next().value!);
  try {localStorage.setItem('arena.receipts.v1',JSON.stringify([...previous.slice(-1023),id]));} catch { /* in-memory dedupe */ }
  return true;
}
