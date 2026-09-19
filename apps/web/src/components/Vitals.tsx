import { fmtInt } from '../lib/game.ts';

/**
 * The one line of competition that survives a phone.
 *
 * On a narrow screen the board and the keyboard need the whole surface, so the
 * rails have to go — but stripping them left plain single-player Termo with a
 * button, which is the opposite of the product. This is the irreducible
 * residue: how many are here, how many already closed, and where you stand.
 * Three numbers, one row, always visible, no interaction required.
 */
export function Vitals({
  online, solved, rank, approx, onOpen,
}: {
  online: number;
  solved: number;
  rank: number;
  approx: boolean;
  onOpen: (which: 'rank' | 'pulse') => void;
}) {
  const pct = online > 0 ? Math.round((solved / online) * 100) : 0;
  return (
    <div className="vitals">
      <button className="vital" onClick={() => onOpen('rank')}>
        <b>{fmtInt(online)}</b><i>na sala</i>
      </button>
      <button className="vital" onClick={() => onOpen('pulse')}>
        <b data-tone="right">{fmtInt(solved)}</b><i>fecharam · {pct}%</i>
      </button>
      <button className="vital" onClick={() => onOpen('rank')}>
        <b data-tone="you">{rank > 0 ? `${approx ? '~' : ''}#${fmtInt(rank)}` : '—'}</b><i>você</i>
      </button>
    </div>
  );
}
