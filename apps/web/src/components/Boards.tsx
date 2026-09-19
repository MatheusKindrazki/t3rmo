import { useEffect, useRef } from 'react';
import type { Tile } from '@arena/core';

/**
 * One grid per secret word. A guess is spent on every unsolved board at once,
 * which is what separates DUETO/TRIETO/QUARTETO from four games side by side:
 * the same five letters have to earn their keep everywhere.
 *
 * The draft row is addressable. Every square in it is a real button, so a
 * letter can be dropped into the middle of an empty row by tapping the square
 * or by walking there with the arrow keys — which is how people actually solve,
 * knowing the word ends in -ÃO long before they know how it starts.
 *
 * A solved board dims rather than vanishing: its history is still the evidence
 * used on the boards that remain.
 */
export function Boards({
  boards, maxGuesses, guesses, tiles, solved, draft, cursor, onPick, shakeKey, shakeAt, tile,
}: {
  boards: number; maxGuesses: number; guesses: string[];
  tiles: Tile[][][]; solved: boolean[];
  draft: string[]; cursor: number; onPick: (i: number) => void;
  shakeKey: number; shakeAt: number; tile: number;
}) {
  const liveRow = useRef<HTMLDivElement | null>(null);

  // On a phone each board is a scroll window (nine rows of QUARTETO cannot fit
  // twice over on a 660px viewport at a legible size), so the row being typed
  // has to be dragged into view as the round advances.
  useEffect(() => {
    liveRow.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [guesses.length, boards]);

  return (
    <div className="boards" data-n={boards} style={{ ['--tile' as string]: `${tile}px` }}>
      {Array.from({ length: boards }, (_, b) => {
        const done = solved[b] === true;
        const showDraft = !done && guesses.length < maxGuesses;
        return (
          <div className="board" key={b} data-solved={done} role="group" aria-label={`palavra ${b + 1}${done ? ', resolvida' : ''}`}>
            {boards > 1 && <span className="board-f">{done ? `✓ ${b + 1}` : `PALAVRA ${b + 1}`}</span>}
            <div className="board-scroll">
              {Array.from({ length: maxGuesses }, (_, r) => {
                const submitted = r < guesses.length;
                const isDraft = showDraft && r === guesses.length;
                const word = submitted ? (guesses[r] ?? '') : '';
                const row = submitted ? tiles[b]?.[r] : undefined;
                return (
                  <div
                    className="row"
                    // Two things at once. The shake is pinned to the row it
                    // belongs to — gating on `shakeKey > 0` made every later
                    // row shake too, so from the first typo on, the player was
                    // told they had erred on every correct word. And changing
                    // an attribute value does not restart a CSS animation, so
                    // a rejected word only shakes again if the node is new.
                    key={isDraft && shakeAt === r ? `d${r}:${shakeKey}` : `r${r}`}
                    ref={isDraft && b === 0 ? liveRow : undefined}
                    role="row"
                    data-shake={isDraft && shakeAt === r ? true : undefined}
                  >
                    {Array.from({ length: 5 }, (_, c) => {
                      const ch = submitted ? (word[c] ?? '') : isDraft ? (draft[c] ?? '') : '';
                      const st = row?.[c];
                      const label = st === undefined ? ch : `${ch} ${st === 2 ? 'certa' : st === 1 ? 'na palavra, outra posição' : 'fora'}`;

                      // Only the draft row is interactive, and only on the
                      // first board — every board shares one draft, so five
                      // buttons is the right number however many grids there are.
                      if (isDraft && b === 0) {
                        return (
                          <button
                            type="button"
                            className="tile"
                            key={c}
                            data-filled={ch !== '' ? true : undefined}
                            data-cursor={c === cursor ? true : undefined}
                            onClick={(e) => {
                              onPick(c);
                              // Hand focus back. A focused control owns Enter,
                              // so leaving focus on the square you just tapped
                              // meant Enter re-picked that square instead of
                              // submitting the word.
                              e.currentTarget.blur();
                            }}
                            aria-label={`posição ${c + 1}${ch ? `, ${ch}` : ', vazia'}`}
                          >
                            {ch}
                          </button>
                        );
                      }
                      return (
                        <div
                          className="tile"
                          key={c}
                          role="gridcell"
                          data-filled={ch !== '' && st === undefined ? true : undefined}
                          data-cursor={isDraft && c === cursor ? true : undefined}
                          data-state={st}
                          aria-label={label}
                          style={st !== undefined ? { animationDelay: `${c * 85}ms` } : undefined}
                        >
                          {ch}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
