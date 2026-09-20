import { MODES, MODE_IDS, type Mode } from '@arena/core';
import { useState } from 'react';
import { Modal } from './Modal.tsx';
import { loadStats, loadTrainingStats, emptyMode, avgGuesses, avgRank, winRate } from '../lib/stats.ts';
import { fmtInt } from '../lib/game.ts';

/**
 * Personal record, per mode.
 *
 * term.ooo's "progresso" leads with games and streaks because it is solitaire.
 * This leads with the average number of attempts, because that is the axis the
 * whole ranking is built on: it is the one number a player can move to climb,
 * and it is the honest self-assessment the leaderboard cannot give them (their
 * position depends on who else showed up).
 */
export function Progress({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const [tab, setTab] = useState<Mode>(mode);
  const all = loadStats();
  const training = loadTrainingStats();
  const s = all[tab] ?? emptyMode();
  const cfg = MODES[tab];
  const peak = Math.max(1, ...s.dist, s.fails);

  return (
    <Modal title="Seu progresso" onClose={onClose}>
      <p className="mdl-p"><b>Treino solo:</b> {training.sessions} sessões · {training.solved} resolvidas.</p>
      <p className="mdl-p">Partidas com amigos neste dispositivo. Treinos solo não entram nestes números.</p>
      <div className="tabs">
        {MODE_IDS.map((m) => (
          <button key={m} className="tab" aria-pressed={tab === m} data-on={tab === m} onClick={() => setTab(m)}>
            {MODES[m].label}
          </button>
        ))}
      </div>

      {s.rounds === 0 ? (
        <p className="mdl-p" style={{ textAlign: 'center', padding: '22px 0' }}>
          Nenhuma rodada de <b>{cfg.label}</b> ainda. Jogue uma e os números aparecem aqui.
        </p>
      ) : (
        <>
          <div className="big4">
            <div className="big">
              <b data-tone="right">{avgGuesses(s) ? avgGuesses(s).toFixed(2) : '—'}</b>
              <i>tentativas por<br />rodada fechada</i>
            </div>
            <div className="big">
              <b>{winRate(s).toFixed(0)}%</b>
              <i>rodadas<br />fechadas</i>
            </div>
            <div className="big">
              <b data-tone="you">{s.bestRank || '—'}</b>
              <i>melhor<br />posição</i>
            </div>
            <div className="big">
              <b>{s.bestStreak}</b>
              <i>melhor<br />sequência</i>
            </div>
          </div>

          <div className="mdl-sep">distribuição de tentativas</div>
          <div className="dist">
            {Array.from({ length: cfg.maxGuesses }, (_, i) => {
              const n = s.dist[i] ?? 0;
              return (
                <div className="dist-r" key={i}>
                  <span className="dist-k">{i + 1}</span>
                  <span className="dist-t"><span className="dist-f" style={{ width: `${(n / peak) * 100}%` }} /></span>
                  <span className="dist-n">{n}</span>
                </div>
              );
            })}
            <div className="dist-r" data-fail="true">
              <span className="dist-k">✕</span>
              <span className="dist-t"><span className="dist-f" style={{ width: `${(s.fails / peak) * 100}%` }} /></span>
              <span className="dist-n">{s.fails}</span>
            </div>
          </div>

          <div className="mdl-sep">na arena</div>
          <div className="mini4">
            <div className="mini"><b>{fmtInt(s.matches)}</b><i>partidas</i></div>
            <div className="mini"><b>{fmtInt(s.wins)}</b><i>vitórias</i></div>
            <div className="mini"><b>{fmtInt(s.podiums)}</b><i>pódios</i></div>
            <div className="mini"><b>{avgRank(s) ? `#${avgRank(s).toFixed(0)}` : '—'}</b><i>posição média</i></div>
          </div>

          <p className="mdl-note">
            Guardado só neste navegador. Posição média depende de quantas pessoas estavam
            na sala — compare com a sua média de tentativas, que não depende de ninguém.
          </p>
        </>
      )}
    </Modal>
  );
}
