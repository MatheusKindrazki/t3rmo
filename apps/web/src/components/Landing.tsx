import { useState } from 'react';
import { MODES, MODE_IDS, type Mode } from '@arena/core';
import { fmtClock } from '../lib/game.ts';
import { Crowd } from './Crowd.tsx';

/** T3RMO is five characters — exactly one Termo row. The mark IS the game. */
function Mark() {
  return (
    <div className="mark-tiles" aria-label="T3RMO">
      {['T', '3', 'R', 'M', 'O'].map((ch, i) => (
        <span key={i} className="mt" data-hit={ch === '3' ? 'right' : 'plain'} style={{ animationDelay: `${i * 85}ms` }}>
          {ch}
        </span>
      ))}
    </div>
  );
}

/** The board shape, drawn — four pips said nothing four squares do not. */
function Glyph({ n }: { n: number }) {
  // n = board count for TERMO..QUARTETO. MISTO passes 0 and gets a rising
  // ladder instead — it is the "all of them, in sequence" mode, not one board.
  if (n === 0) {
    return (
      <span className="glyph glyph-ladder" aria-hidden>
        {[1, 2, 3, 4].map((h) => <span key={h} style={{ height: `${h * 3 + 2}px` }} />)}
      </span>
    );
  }
  return <span className="glyph" data-n={n}>{Array.from({ length: n }, (_, i) => <span key={i} />)}</span>;
}

/**
 * Two full-bleed halves with a hard edge: a solid slab of entry controls
 * against the left, and the crowd itself filling everything to the right of it.
 *
 * The page it replaced was the default template — oversized heading, a
 * subheading, a form rail, a three-column 01/02/03 strip, and the bottom forty
 * percent left as empty ground. Nothing about it belonged to this product.
 * Here the claim "thousands of people, the same word, the same second" is not
 * written above a form; it is the picture you are looking at.
 */
export function Landing({
  name, setName, onCreate, onJoin, busy, error, onRules, onProgress,
}: {
  name: string;
  setName: (n: string) => void;
  onCreate: (mode: Mode, rounds: number) => void;
  onJoin: (code: string) => void | Promise<void>;
  busy: boolean;
  error: string | null;
  onRules: () => void;
  onProgress: () => void;
}) {
  const [mode, setMode] = useState<Mode>('termo');
  const [rounds, setRounds] = useState(5);
  const [code, setCode] = useState('');
  const cfg = MODES[mode];

  return (
    <div className="lp">
      {/* Desk first in the DOM as well as on screen: it is the narrow column,
          and a keyboard user should reach the form before the scenery. */}
      <aside className="lp-desk">
        <div className="lp-desk-in">
          <Mark />
          <h1 className="lp-claim">Termo<br />competitivo</h1>

          <div className="lp-entry">
            <label className="label" htmlFor="nick">seu nome na tabela</label>
            <input
              id="nick" className="input" value={name} maxLength={16}
              placeholder="aparece no ranking"
              onChange={(e) => setName(e.target.value)}
            />

            <span className="label" style={{ marginTop: 16 }}>formato</span>
            <div className="seg">
              {MODE_IDS.filter((m) => m !== 'misto').map((m) => (
                <button key={m} className="seg-b" data-on={mode === m} onClick={() => setMode(m)}>
                  <Glyph n={MODES[m].boards} />
                  <span className="seg-name">{MODES[m].label}</span>
                  <span className="seg-meta">{MODES[m].boards} palavra{MODES[m].boards > 1 ? 's' : ''}</span>
                </button>
              ))}
            </div>
            {/* MISTO is not a fifth peer in the grid — it is the combination of
                the other four, so it gets its own full-width row that says so. */}
            <button className="seg-misto" data-on={mode === 'misto'} onClick={() => setMode('misto')}>
              <Glyph n={0} />
              <span className="seg-misto-text">
                <b>MISTO</b>
                <i>sobe a escada — um TERMO, um DUETO, um TRIETO, um QUARTETO</i>
              </span>
            </button>

            <div className="lp-rounds">
              <label className="label" htmlFor="rounds">rodadas <b>{rounds}</b></label>
              <input
                id="rounds" className="slider" type="range" min={1} max={12} value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
                style={{ ['--fill' as string]: `${((rounds - 1) / 11) * 100}%` }}
              />
              <span className="lp-meta">
                {mode === 'misto'
                  ? `${rounds} rodada${rounds > 1 ? 's' : ''} · a escada recomeça a cada 4`
                  : `${cfg.maxGuesses} tentativas · ${fmtClock(cfg.roundMs)} por rodada`}
              </span>
            </div>

            <button className="btn lp-cta" disabled={busy} onClick={() => onCreate(mode, rounds)}>
              {busy ? 'abrindo…' : 'abrir sala'}
            </button>

            <div className="join">
              <input
                className="input" placeholder="CÓDIGO" value={code} maxLength={8}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.length >= 3) onJoin(code); }}
              />
              <button className="btn" data-variant="ghost" disabled={code.length < 3} onClick={() => onJoin(code)}>
                entrar
              </button>
            </div>

            {error && <div className="err">{error}</div>}
          </div>

          <footer className="lp-foot">
            <p>Quem fecha em <em>menos tentativas</em> fica na frente. O relógio só desempata dentro do mesmo número.</p>
            <nav>
              <button className="link" onClick={onRules}>como jogar</button>
              <button className="link" onClick={onProgress}>seu progresso</button>
            </nav>
          </footer>
        </div>
      </aside>

      {/* The crowd is the page's ground, not decoration behind a card. */}
      <div className="lp-field">
        <Crowd />
        <div className="lp-field-cap"><span>a sala inteira na mesma palavra, no mesmo segundo</span></div>
      </div>
    </div>
  );
}
