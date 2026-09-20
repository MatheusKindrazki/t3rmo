import { useState } from 'react';
import { MODES, MODE_IDS, MISTO_RUNGS, type ModeConfig, type Tile } from '@arena/core';
import { fmtClock } from '../lib/game.ts';
import { Modal } from './Modal.tsx';

function Row({ word, tiles }: { word: string; tiles: Tile[] }) {
  return (
    <div className="ex-row">
      {[...word].map((ch, i) => (
        <span className="ex-t" key={i} data-state={tiles[i]}>{ch}</span>
      ))}
    </div>
  );
}

/**
 * Two halves, in the order a newcomer needs them.
 *
 * The first half is the Termo everyone already knows, kept in term.ooo's own
 * shape — three worked examples, one per tile state — because relearning that
 * is not the point. The second half is the part that is actually new here, and
 * it is the part that decides whether someone plays well: a guess is spent on
 * every word at once, and the ranking is attempts first with the clock only
 * breaking ties. A player who does not know the second rule will rush, and
 * rushing is exactly the wrong strategy.
 */
const MARKS_KEY = 'arena.marks';

/**
 * Off by default.
 *
 * The symbol existed because teal against sand measured 1.26:1 under
 * protanopia — the game's entire feedback channel collapsing into one colour
 * for about one man in sixteen. That is no longer the case: the palette was
 * rebuilt around a luminance split and the two states now hold 3.08:1 apart
 * under the same simulation, which is a real difference in lightness, not a
 * difference in hue. So the colour genuinely does say it, the mark is
 * redundant for most people, and it goes back to being what it should always
 * have been — an option for the players who still need it, not furniture
 * everyone has to look at.
 */
export function readMarks(): boolean {
  try { return localStorage.getItem(MARKS_KEY) === 'on'; } catch { return false; }
}
function writeMarks(on: boolean): void {
  try { localStorage.setItem(MARKS_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  document.documentElement.dataset.marks = on ? 'on' : 'off';
}

export function Rules({ onClose }: { onClose: () => void }) {
  const [marks, setMarksState] = useState(readMarks);
  const setMarks = (on: boolean) => { setMarksState(on); writeMarks(on); };
  return (
    <Modal title="Como jogar" onClose={onClose}>
      <p className="mdl-p">
        Descubra a palavra de 5 letras. A cada palpite, as peças mostram o quão perto você chegou.
      </p>

      <Row word="TURMA" tiles={[2, 0, 0, 0, 0]} />
      <p className="mdl-c">A letra <b>T</b> está na palavra e na posição certa.</p>

      <Row word="VIOLA" tiles={[0, 0, 1, 0, 0]} />
      <p className="mdl-c">A letra <b>O</b> está na palavra, mas em outra posição.</p>

      <Row word="PULGA" tiles={[0, 0, 0, 0, 0]} />
      <p className="mdl-c">Nenhuma dessas letras está na palavra.</p>

      <label className="switch">
        <input type="checkbox" checked={marks} onChange={(e) => setMarks(e.target.checked)} />
        <span>
          marcar as peças com um símbolo além da cor
          <i>para quem não distingue verde de areia</i>
        </span>
      </label>

      <p className="mdl-p">
        Os acentos são preenchidos automaticamente: digite <b>aviao</b> e o jogo revela <b>AVIÃO</b>.
        Palavras podem ter letras repetidas.
      </p>

      <div className="mdl-sep">o que muda na arena</div>

      <p className="mdl-p">
        <b>Todo mundo joga a mesma palavra, ao mesmo tempo.</b> A sala inteira recebe a rodada
        no mesmo segundo — não é o seu jogo do dia, é uma corrida.
      </p>
      <p className="mdl-p">
        <b>Um palpite vale para todas as palavras da rodada.</b> No DUETO você resolve duas
        palavras com 7 tentativas no total; no QUARTETO, quatro com 9. As mesmas cinco letras
        precisam render em todos os tabuleiros.
      </p>

      <div className="mode-tab">
        {MODE_IDS.filter((m) => m !== 'misto').map((m) => {
          const c = MODES[m];
          return (
            <div className="mode-tab-r" key={m}>
              <b>{c.label}</b>
              <span>{c.boards} palavra{c.boards > 1 ? 's' : ''}</span>
              <span>{c.maxGuesses} tentativas</span>
              <span>{fmtClock(c.roundMs)}</span>
            </div>
          );
        })}
      </div>

      <div className="mdl-sep">misto — a escada</div>

      <p className="mdl-p">
        No <b>MISTO</b> a partida sobe degrau a degrau: a primeira rodada é um TERMO, a segunda
        um DUETO, a terceira um TRIETO e a quarta um QUARTETO. Passou da quarta, recomeça de
        baixo. Você joga os quatro formatos na mesma partida, cada um valendo pontos — não é
        preciso escolher no que você é bom.
      </p>
      <div className="mode-tab">
        {MISTO_RUNGS.map((c: ModeConfig, i: number) => (
          <div className="mode-tab-r" key={i}>
            <b>{i + 1}ª · {c.label}</b>
            <span>{c.boards} palavra{c.boards > 1 ? 's' : ''}</span>
            <span>{c.maxGuesses} tentativas</span>
            <span>{fmtClock(c.roundMs)}</span>
          </div>
        ))}
      </div>
      <p className="mdl-p">
        Os degraus mais difíceis valem um pouco mais, <b>mas não muito</b>: um QUARTETO impecável
        rende cerca de 15% a mais que um TERMO impecável, não o dobro. Sem isso a última rodada
        decidiria a mesa sozinha e as três primeiras virariam aquecimento. O nome do degrau em
        que você está aparece no topo da tela.
      </p>

      <div className="mdl-sep">como se ganha</div>

      <p className="mdl-p">
        <b>Acertos, tentativas e velocidade somam pontos.</b> Menos tentativas rende mais,
        mas a velocidade pode compensar uma tentativa extra. Velocidade e sequência juntas
        não compensam duas tentativas extras na mesma rodada. Vence quem soma mais pontos na partida.
      </p>
      <p className="mdl-p">
        Resolver parte das palavras já pontua. Fechar sem desperdiçar nenhuma tentativa dá bônus,
        e rodadas fechadas em sequência valem um extra crescente.
      </p>
    </Modal>
  );
}
