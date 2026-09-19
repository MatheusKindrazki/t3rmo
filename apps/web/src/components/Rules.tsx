import { MODES, MODE_IDS, type Tile } from '@arena/core';
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
export function Rules({ onClose }: { onClose: () => void }) {
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

      <p className="mdl-p">
        Os acentos são preenchidos automaticamente: digite <b>acucar</b> e o jogo revela <b>AÇÚCAR</b>.
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
        {MODE_IDS.map((m) => {
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

      <div className="mdl-sep">como se ganha</div>

      <p className="mdl-p">
        <b style={{ color: 'var(--right)' }}>Menos tentativas sempre fica na frente.</b> Quem
        fecha em 3 não pode ser ultrapassado, naquela rodada, por quem precisou de 4 — por mais
        rápido que o outro tenha sido. O relógio só desempata <i>dentro</i> do mesmo número de
        tentativas.
      </p>
      <p className="mdl-p">
        Resolver parte das palavras já pontua. Fechar sem desperdiçar nenhuma tentativa dá bônus,
        e rodadas fechadas em sequência valem um extra crescente.
      </p>
    </Modal>
  );
}
