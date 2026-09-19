import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '@arena/core';
import { fmtClock, fmtInt } from '../lib/game.ts';

/**
 * Header, trimmed to what a player actually looks at mid-round.
 *
 * What came out and why:
 *  - "AO VIVO" — a running clock already says the round is live; a badge that
 *    is lit essentially all the time carries no information.
 *  - the mode label — four grids on screen IS the label. TERMO/QUARTETO was
 *    words restating a picture.
 *  - the burger — on desktop the table is permanently docked, so the control
 *    opened something already open; on narrow screens the floating tab does
 *    that job. A menu that is a no-op most of the time is worse than no menu.
 *
 * What stayed is the three numbers people glance at — clock, headcount, your
 * own position — plus the room code, which is no longer decoration: it is the
 * copy-invite button, which is the only reason anyone reads it.
 */
function Clock({ deadline, serverNow }: { deadline: number; serverNow: () => number }) {
  const [left, setLeft] = useState(() => deadline - serverNow());
  useEffect(() => {
    const id = setInterval(() => setLeft(deadline - serverNow()), 250);
    setLeft(deadline - serverNow());
    return () => clearInterval(id);
  }, [deadline, serverNow]);
  return <div className="hd-clock" data-urgent={left <= 15_000 && left > 0}>{fmtClock(left)}</div>;
}

export function TopBar({
  room, online, myRank, prevRank, approx, serverNow, onRules, onProgress,
}: {
  room: RoomSnapshot;
  online: number;
  myRank: number;
  /** Where you were before the last change, so the header can show movement. */
  prevRank: number;
  approx: boolean;
  serverNow: () => number;
  onRules: () => void;
  onProgress: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const moved = prevRank > 0 && myRank > 0 ? prevRank - myRank : 0;
  const showClock = room.deadline > 0 && room.phase !== 'finished' && room.phase !== 'lobby';

  const invite = () => {
    navigator.clipboard?.writeText(`${location.origin}/?sala=${room.code}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => undefined);
  };

  return (
    <header className="hd">
      <div className="hd-l">
        <span className="mark">T<em>3</em>RMO</span>
        <button className="code" onClick={invite} title="copiar convite da sala">
          {copied ? 'link copiado' : room.code}
        </button>
        <span className="hd-round">{room.round || 1}<i>/{room.rounds}</i></span>
        {/* In MISTO the format changes every round, so the rung has to be on
            screen — otherwise the player discovers they are in QUARTETO by
            counting grids. */}
        {room.mode === 'misto' && <span className="rung">{room.cfg.l}</span>}
      </div>

      <div className="hd-c">{showClock && <Clock deadline={room.deadline} serverNow={serverNow} />}</div>

      <div className="hd-r">
        <div className="stat">
          <b>{fmtInt(online)}</b>
          <i>jogando</i>
        </div>
        <div className="stat" data-tone="you">
          <b>
            {myRank > 0 ? `${approx ? '~' : ''}${fmtInt(myRank)}` : '—'}
            {/* A table that only says where you ARE hides the thing actually
                happening to you. Lower rank number means you climbed. */}
            {moved !== 0 && (
              <span className="delta" data-dir={moved > 0 ? 'up' : 'down'}>
                {moved > 0 ? '▲' : '▼'}{Math.abs(moved)}
              </span>
            )}
          </b>
          <i>sua posição</i>
        </div>
        {/* Two buttons that each do one nameable thing, instead of one that
            hides both behind a shrug. */}
        <div className="hd-icons">
          <button className="ico" onClick={onRules} title="como jogar" aria-label="como jogar">?</button>
          <button className="ico" onClick={onProgress} title="seu progresso" aria-label="seu progresso">▥</button>
        </div>
      </div>
    </header>
  );
}
