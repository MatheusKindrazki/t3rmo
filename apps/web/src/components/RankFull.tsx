import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CUT_RANKS, PAGE_MAX, type RowWire } from '@arena/core';
import { Modal } from './Modal.tsx';
import { fmtInt } from '../lib/game.ts';

const ROW_H = 48;
const BUFFER = 8;

/** Ranks that mark an elite step, for quick lookup while scrolling. */
const CUTS = new Set<number>(CUT_RANKS as readonly number[]);
function cutLabel(rank: number): string | null {
  return CUTS.has(rank) ? `top ${fmtInt(rank)}` : null;
}

/**
 * The whole ranking, scrollable, paged on demand.
 *
 * The rail only streams the top twelve and the slice around you; everyone in
 * between is a page pull. This view virtualises the full 1..N list — a spacer
 * gives it the true height, only the visible window renders, and the band you
 * scroll into is requested (throttled, and the server rate-limits it too). The
 * elite steps (top 10 / 50 / 100 …) are tagged inline, so climbing has a
 * visible target.
 */
export function RankFull({
  total, rows, myRank, myId, cuts, requestPage, onClose, onKick,
}: {
  total: number;
  rows: Record<number, RowWire>;
  myRank: number;
  myId: string;
  cuts: number[];
  requestPage: (from: number, to: number) => void;
  onClose: () => void;
  onKick?: (id:string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(480);
  const lastReq = useRef(0);
  const mine = myId.slice(0, 8);

  // Ask the server for whatever the visible band is missing. Throttled below the
  // server's own 1/s page limit; a request only fires when a row in view is a
  // hole, so a fully-cached band is free.
  const fill = (top: number, h: number) => {
    const first = Math.max(1, Math.floor(top / ROW_H) + 1 - BUFFER);
    const last = Math.min(total, Math.ceil((top + h) / ROW_H) + BUFFER);
    let hole = false;
    for (let r = first; r <= last; r++) if (!rows[r]) { hole = true; break; }
    if (!hole) return;
    const now = Date.now();
    if (now - lastReq.current < 1100) return;
    lastReq.current = now;
    const from = Math.max(0, first - 1);
    const to = Math.min(total, Math.min(from + PAGE_MAX, last));
    requestPage(from, to);
  };

  // Land on the player's own position, and pull that band immediately.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const target = myRank > 0 ? Math.max(0, (myRank - 1) * ROW_H - el.clientHeight / 2) : 0;
    el.scrollTop = target;
    setScrollTop(target);
    fill(target, el.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-check for holes whenever new rows land while sitting on a band.
  useEffect(() => {
    fill(scrollTop, viewH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, scrollTop, viewH]);

  useEffect(() => { const timer=setInterval(()=>fill(scrollTop,viewH),1200); return ()=>clearInterval(timer); },[rows,scrollTop,viewH]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    fill(el.scrollTop, el.clientHeight);
  };

  const jumpToMe = () => {
    const el = scroller.current;
    if (!el || myRank <= 0) return;
    el.scrollTop = Math.max(0, (myRank - 1) * ROW_H - el.clientHeight / 2);
  };

  const first = Math.max(1, Math.floor(scrollTop / ROW_H) + 1 - BUFFER);
  const last = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);
  const visible: number[] = [];
  for (let r = first; r <= last; r++) visible.push(r);

  // The elite steps as a reference strip: the score each rung costs, straight
  // from the ladder the big-room tick already carries.
  const steps = cuts.length
    ? CUT_RANKS.slice(0, cuts.length)
        .map((rank, i) => ({ rank, score: cuts[i]! }))
        .filter((s) => s.rank <= total)
    : [];

  return (
    <Modal title="Ranking completo" onClose={onClose}>
      <div className="rankfull" onClick={(e) => e.stopPropagation()}>
        <div className="rankfull-hd">
          <span className="rail-t">Ranking completo</span>
          <span className="rail-s">{fmtInt(total)} na sala</span>
          <button className="rankfull-x" onClick={onClose} aria-label="fechar">✕</button>
        </div>

        {steps.length > 0 && (
          <div className="rankfull-steps">
            {steps.map((s) => (
              <span className="step-chip" key={s.rank}>
                <b>top {fmtInt(s.rank)}</b> {fmtInt(s.score)}
              </span>
            ))}
          </div>
        )}

        <div className="rankfull-scroll" ref={scroller} onScroll={onScroll}>
          <div className="rankfull-spacer" style={{ height: total * ROW_H }}>
            {visible.map((rank) => {
              const row = rows[rank];
              const you = rank === myRank || (row && (row[6] === 1 || row[1] === mine));
              const tag = cutLabel(rank);
              return (
                <div
                  key={rank}
                  className="lb-r rankfull-r"
                  data-you={you || undefined}
                  data-p={rank <= 3 ? rank : undefined}
                  data-cut={tag ? true : undefined}
                  style={{ transform: `translateY(${(rank - 1) * ROW_H}px)`,height:ROW_H,gridTemplateColumns:onKick?'28px minmax(60px,1fr) 28px 48px 68px':undefined }}
                >
                  <span className="lb-k">{rank}</span>
                  <span className="lb-nm">
                    {row ? row[2] : <span className="rankfull-wait">—</span>}
                    {tag && <span className="rankfull-tag">{tag}</span>}
                  </span>
                  <span className="lb-a">{row ? `${row[4]}t` : ''}</span>
                  <span className="lb-s">{row ? fmtInt(row[3]) : ''}</span>
                  {row && onKick && row[1] !== mine && <button className="link" aria-label={`Remover ${row[2]}`} onClick={()=>{if(window.confirm(`Remover ${row[2]} desta sala?`))onKick(row[1]);}}>Remover</button>}
                </div>
              );
            })}
          </div>
        </div>

        {myRank > 0 && (
          <button className="rankfull-me" onClick={jumpToMe}>ir para a minha posição · {myRank > 0 ? fmtInt(myRank) : '—'}</button>
        )}
      </div>
    </Modal>
  );
}
