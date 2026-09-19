import type { Tile } from '@arena/core';
import { KB_ROWS } from '../lib/game.ts';

export function Keyboard({
  states, boards, onKey, disabled,
}: {
  states: Map<string, (Tile | undefined)[]>;
  boards: number;
  onKey: (k: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="kb">
      {KB_ROWS.map((row, i) => (
        <div className="kb-r" key={i}>
          {row.map((k) => {
            const wide = k === 'ENTER' || k === 'BACK';
            const slots = states.get(k);
            // Only TERMO can honestly paint a whole key: with more boards the
            // same letter holds different truths at the same time.
            const solid = boards === 1 ? slots?.[0] : undefined;
            return (
              <button
                key={k}
                className="key"
                data-wide={wide || undefined}
                data-solid={solid}
                disabled={disabled}
                onClick={() => onKey(k)}
                aria-label={k === 'BACK' ? 'apagar letra' : k === 'ENTER' ? 'enviar palpite' : `letra ${k}`}
              >
                {k === 'BACK' ? '⌫' : k === 'ENTER' ? 'ENVIAR' : k}
                {boards > 1 && slots && (
                  <span className="key-st" aria-hidden>
                    {Array.from({ length: boards }, (_, b) => <span className="key-sg" key={b} data-s={slots[b]} />)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
