import type { Tile } from '@arena/core';

/**
 * One grid per secret word. A guess is spent on every unsolved board at once,
 * which is what separates DUETO/TRIETO/QUARTETO from four games side by side:
 * the same five letters have to earn their keep everywhere.
 *
 * A solved board dims rather than vanishing — its history is still the evidence
 * used on the boards that remain.
 */
export function Boards({
  boards, maxGuesses, guesses, tiles, solved, draft, shakeKey, tile,
}: {
  boards: number; maxGuesses: number; guesses: string[];
  tiles: Tile[][][]; solved: boolean[]; draft: string; shakeKey: number; tile: number;
}) {
  return (
    <div className="boards" data-n={boards} style={{ ['--tile' as string]: `${tile}px` }}>
      {Array.from({ length: boards }, (_, b) => {
        const done = solved[b] === true;
        const showDraft = !done && guesses.length < maxGuesses;
        return (
          <div className="board" key={b} data-solved={done}>
            {boards > 1 && <span className="board-f">{done ? `✓ PALAVRA ${b + 1}` : `PALAVRA ${b + 1}`}</span>}
            {Array.from({ length: maxGuesses }, (_, r) => {
              const submitted = r < guesses.length;
              const isDraft = showDraft && r === guesses.length;
              const word = submitted ? (guesses[r] ?? '') : isDraft ? draft : '';
              const row = submitted ? tiles[b]?.[r] : undefined;
              return (
                <div
                  className="row"
                  // Re-keying on shakeKey gives the CSS animation a fresh node;
                  // without it a second invalid word would not shake again.
                  key={isDraft ? `d${r}:${shakeKey}` : `g${r}`}
                  data-shake={isDraft && shakeKey > 0 ? true : undefined}
                >
                  {Array.from({ length: 5 }, (_, c) => {
                    const ch = word[c] ?? '';
                    const st = row?.[c];
                    return (
                      <div
                        className="tile"
                        key={c}
                        data-filled={ch !== '' && st === undefined ? true : undefined}
                        data-cursor={isDraft && c === draft.length ? true : undefined}
                        data-state={st}
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
        );
      })}
    </div>
  );
}
