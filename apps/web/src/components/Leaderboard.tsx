import { useEffect, useRef, useState } from 'react';
import type { RowWire } from '@arena/core';
import { fmtInt } from '../lib/game.ts';

const ROW_H = 32;
const WORD = 5;

/**
 * Rivals' boards, as tile digits only.
 *
 * This is the "watch the room play each other" affordance. You see a leader go
 * three-teal and it lands in your stomach; you learn nothing about which
 * letters got them there, because letters never leave the server. Only board 1
 * is mirrored — reflecting all four in QUARTETO would quadruple the frame for a
 * strip nobody reads that closely.
 */
function Spy({ spy, top, maxGuesses, mineId }: { spy: [string, string][]; top: RowWire[]; maxGuesses: number; mineId: string }) {
  // All-empty grids read as static rather than as information; the strip only
  // earns its space once somebody has actually guessed.
  if (!spy.length || !spy.some(([, packed]) => packed.length > 0)) return null;
  const nameOf = new Map(top.map((r) => [r[1], { name: r[2], you: r[6] === 1 || r[1] === mineId }]));
  return (
    <div className="spy">
      {spy.map(([id, packed]) => {
        const who = nameOf.get(id);
        const rows = Math.ceil(packed.length / WORD);
        return (
          <div className="spy-c" key={id} data-you={who?.you}>
            <div className="spy-g" aria-hidden>
              {Array.from({ length: maxGuesses }, (_, r) => (
                <div className="spy-row" key={r}>
                  {Array.from({ length: WORD }, (_, c) => (
                    <span className="spy-t" key={c} data-s={r < rows ? packed[r * WORD + c] : undefined} />
                  ))}
                </div>
              ))}
            </div>
            <div className="spy-n">{who?.name ?? '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Leaderboard({
  top, spy, maxGuesses, me, myName, myId, total, approx,
}: {
  top: RowWire[];
  spy: [string, string][];
  maxGuesses: number;
  me: [number, number, number] | null;
  myName: string;
  /** Full player id; rows carry only its first 8 chars. */
  myId: string;
  total: number;
  approx: boolean;
}) {
  // The broadcast frame is one string for the whole room, so "you" cannot be
  // marked server-side without marking it for everybody. The client matches the
  // prefix instead. r[6] stays authoritative on unicast rows (podium, standings).
  const mine = myId.slice(0, 8);
  const isYou = (r: RowWire) => r[6] === 1 || r[1] === mine;
  const prev = useRef(new Map<string, number>());
  const [climb, setClimb] = useState<Set<string>>(new Set());

  useEffect(() => {
    const moved = new Set<string>();
    for (const r of top) {
      const before = prev.current.get(r[1]);
      if (before !== undefined && r[0] < before) moved.add(r[1]);
      prev.current.set(r[1], r[0]);
    }
    if (!moved.size) return;
    setClimb(moved);
    const t = setTimeout(() => setClimb(new Set()), 700);
    return () => clearTimeout(t);
  }, [top]);

  const youInTop = top.some(isYou);

  return (
    <aside className="rail rail-r">
      <div className="rail-hd">
        <span className="rail-t">Ranking</span>
        <span className="rail-s">{total > 0 ? `${fmtInt(total)} na sala` : 'ao vivo'}</span>
      </div>

      <Spy spy={spy} top={top} maxGuesses={maxGuesses} mineId={mine} />

      <div className="lb">
        <div className="lb-c" style={{ height: top.length * ROW_H }}>
          {top.map(([rank, id, name, score, guesses, , you]) => (
            <div
              key={id}
              className="lb-r"
              data-you={isYou([rank, id, name, score, guesses, 0, you])}
              data-p={rank <= 3 ? rank : undefined}
              data-climb={climb.has(id)}
              style={{ transform: `translateY(${(rank - 1) * ROW_H}px)` }}
            >
              <span className="lb-k">{rank}</span>
              <span className="lb-nm">{name}</span>
              <span className="lb-a">{guesses}t</span>
              <span className="lb-s">{fmtInt(score)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Pinned even at #1.284: the number that matters most to a player is
          always the one about them. */}
      {me && !youInTop && (
        <>
          <div className="lb-pin">
            <span className="lb-k">{me[0] > 0 ? `${approx ? '~' : ''}${me[0]}` : '—'}</span>
            <span className="lb-nm" style={{ color: 'var(--you)' }}>{myName}</span>
            <span className="lb-a">{me[2]}t</span>
            <span className="lb-s">{fmtInt(me[1])}</span>
          </div>
          {approx && (
            <div className="lb-approx">
              posição estimada — vira exata no seu próximo palpite
            </div>
          )}
        </>
      )}
    </aside>
  );
}
