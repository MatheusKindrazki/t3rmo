import type { ReactNode } from 'react';
import type { FeedWire } from '@arena/core';
import { fmtInt } from '../lib/game.ts';

const COPY: Record<string, (n: string, v: number) => ReactNode> = {
  solve:   (n, v) => <><span className="feed-w">{n}</span> fechou em <span className="feed-g">{v}</span></>,
  perfect: (n, v) => <><span className="feed-w">{n}</span> <span className="feed-g">PERFEITO</span> em {v}</>,
  join:    (n, v) => <><span className="feed-w">{n}</span> entrou · {fmtInt(v)} na sala</>,
  lead:    (n) => <><span className="feed-w">{n}</span> assumiu a ponta</>,
  out:     (n) => <><span className="feed-w">{n}</span> saiu</>,
};

export function Pulse({
  online, solved, hist, feed, myGuesses,
}: {
  online: number; solved: number; hist: number[]; feed: FeedWire[]; myGuesses: number;
}) {
  const peak = Math.max(1, ...hist);
  return (
    <aside className="rail rail-l">
      <div className="rail-hd"><span className="rail-t">Pulso</span><span className="rail-s">da sala</span></div>

      <div className="blk">
        <div className="k">já fecharam</div>
        <div className="v" data-tone="right">
          {fmtInt(solved)}
          <span style={{ fontSize: 13, color: 'var(--mute)', fontFamily: 'var(--f-ui)', fontWeight: 600 }}>
            {online > 0 ? ` · ${((solved / online) * 100).toFixed(0)}%` : ''}
          </span>
        </div>
      </div>

      <div className="blk">
        <div className="k" style={{ marginBottom: 2 }}>em quantas tentativas</div>
        <div className="hist">
          {hist.map((n, i) => (
            <div className="hist-r" key={i} data-mine={myGuesses === i + 1}>
              <span className="hist-n">{i + 1}</span>
              <span className="hist-t"><span className="hist-f" style={{ width: `${(n / peak) * 100}%` }} /></span>
              <span className="hist-c">{n > 0 ? fmtInt(n) : '·'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="feed">
        {feed.slice(-16).map(([kind, name, v], i) => (
          <div className="feed-i" key={`${i}-${name}-${v}`}>{(COPY[kind] ?? COPY.join!)(name, v)}</div>
        ))}
      </div>
    </aside>
  );
}
