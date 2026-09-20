import { useEffect, useState } from 'react';
import { Confetti } from './Confetti.tsx';
import { ShareAction } from './ShareAction.tsx';
import { Modal } from './Modal.tsx';
import type { RowWire, FeedWire, RoundScore } from '@arena/core';
import { fmtInt } from '../lib/game.ts';

function ScoreDetail({ score }: { score?: RoundScore }) {
  if (!score) return null;
  return <><p className="hint">Pontos da última rodada: {fmtInt(score.total)}</p><dl className="score-breakdown">{([['Acertos', score.words], ['Tentativas', score.attempts], ['Velocidade', score.speed], ['Sequência', score.streak], ['Bônus perfeito', score.perfect]] as const).map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd>{fmtInt(value)}</dd></div>)}</dl></>;
}

export function CountdownVeil({ deadline, serverNow }: { deadline: number; serverNow: () => number }) {
  const [n, setN] = useState(() => Math.ceil((deadline - serverNow()) / 1000));
  useEffect(() => {
    const id = setInterval(() => setN(Math.ceil((deadline - serverNow()) / 1000)), 120);
    return () => clearInterval(id);
  }, [deadline, serverNow]);
  return (
    <div className="veil">
      <div className="veil-box">
        <div className="kicker">todo mundo na mesma palavra</div>
        {/* Keyed on the number so the pop animation restarts each second. */}
        <div className="count" key={n}>{n > 0 ? n : 'JÁ'}</div>
      </div>
    </div>
  );
}

export function RoundEndVeil({
  answers, you, podium, round, rounds,
}: {
  answers: string[];
  you: { score: number; rank: number; solvedWords: number; guesses: number; roundScore: number; breakdown?: RoundScore } | null;
  podium: RowWire[];
  round: number;
  rounds: number;
}) {
  return (
    <div className="veil">
      <div className="veil-box">
        <div className="kicker">rodada {round} de {rounds} · a palavra era</div>
        <div className="reveal">
          {answers.map((w, i) => (
            <div className="rw" key={w} style={{ animationDelay: `${i * 110}ms` }}>
              {[...w].map((ch, j) => <span className="rc" key={j}>{ch}</span>)}
            </div>
          ))}
        </div>

        {you && (
          <div className="vtitle" style={{ marginTop: 6 }}>
            {you.solvedWords === answers.length
              ? <>FECHOU EM <span style={{ color: 'var(--right)' }}>{you.guesses}</span></>
              : <span style={{ color: 'var(--live)' }}>NÃO FECHOU</span>}
          </div>
        )}
        {you && (
          <div className="hint" style={{ marginTop: 8 }}>
            +{fmtInt(you.roundScore)} nesta rodada · total {fmtInt(you.score)} · posição #{fmtInt(you.rank)}
          </div>
        )}

        <ScoreDetail score={you?.breakdown} />
        <div className="pod">
          {podium.map(([rank, id, name, score, guesses]) => (
            <div className="pod-r" key={id} data-p={rank}>
              <span className="lb-k">{rank}</span>
              <span className="lb-nm">{name}</span>
              <span className="lb-a">{guesses}t</span>
              <span className="lb-s">{fmtInt(score)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MatchEndVeil({
  standings, you, answers, onAgain, onLeave, isHost, training = false, guesses = 0, solved = false,
}: {
  standings: RowWire[];
  you: { rank: number; score: number; breakdown?: RoundScore } | null;
  training?: boolean; guesses?: number; solved?: boolean;
  /** The final round's words — nothing else ever reveals them. */
  answers: string[];
  onAgain: () => void;
  onLeave: () => void;
  isHost: boolean;
}) {
  const podium = training ? [] : standings.slice(0, 3);
  const onPodium = you !== null && you.rank > 0 && you.rank <= 3;
  return (
    <div className="veil" role="status">
      {podium.length > 0 && <Confetti />}
      <div className="veil-box">
        <div className="kicker">{training ? 'Treino concluído' : onPodium ? 'você subiu no pódio' : 'partida encerrada'}</div>

        {/* The last round's answer used to die unseen: endRound flips the phase
            to 'finished' before the reveal renders, so the most satisfying beat
            in Termo was missing from the round the match actually ends on. */}
        {answers.length > 0 && (
          <div className="reveal">
            {answers.map((w, i) => (
              <div className="rw" key={w} style={{ animationDelay: `${i * 90}ms` }}>
                {[...w].map((ch, j) => <span className="rc" key={j}>{ch}</span>)}
              </div>
            ))}
          </div>
        )}

        <div className="pod-top">
          {podium.map(([rank, id, name, score, guesses, , mine]) => (
            <div className="pod-big" key={id} data-p={rank}>
              <span className="pod-medal">{rank === 1 ? '1º' : rank === 2 ? '2º' : '3º'}</span>
              <span className="pod-name">{name}{mine === 1 ? ' (você)' : ''}</span>
              <span className="pod-att">{guesses}t</span>
              <span className="pod-score">{fmtInt(score)}</span>
            </div>
          ))}
        </div>

        {training && <p>{solved ? `Você acertou em ${guesses} tentativas.` : `Você usou ${guesses} tentativas. Vale treinar de novo!`}</p>}
        <ScoreDetail score={you?.breakdown} />
        {you && !training && <p className="hint">Total da partida: {fmtInt(you.score)} pontos</p>}
        {you && !training && !onPodium && (
          <div className="hint" style={{ marginTop: 12 }}>
            você terminou em <b style={{ color: 'var(--you)' }}>#{fmtInt(you.rank)}</b> com {fmtInt(you.score)} pontos
          </div>
        )}

        {!training && standings.length > 3 && (
          <div className="pod" style={{ maxHeight: 190, overflowY: 'auto', marginTop: 12 }}>
            {standings.slice(3, 15).map(([rank, id, name, score, guesses, , mine]) => (
              <div className="pod-r" key={id} style={mine === 1 ? { background: 'rgba(143,211,255,.12)' } : undefined}>
                <span className="lb-k">{rank}</span>
                <span className="lb-nm">{name}</span>
                <span className="lb-a">{guesses}t</span>
                <span className="lb-s">{fmtInt(score)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Everyone gets a way out to the home screen — the non-host used to be
            stranded on "aguardando…" with no exit at all. The host also gets
            to restart the match in place. */}
        <div className="result-actions">
        <div className="result-actions-primary">
          {isHost && <button className="btn" onClick={onAgain}>{training ? 'Treinar de novo' : 'Jogar de novo'}</button>}
          <button className="btn" data-variant="ghost" onClick={onLeave}>{training ? 'Chamar amigos para jogar' : 'Voltar ao início'}</button>
        </div>
        <div className="result-actions-share"><ShareAction label="Compartilhar resultado" text={training ? `Treinei no T3RMO: ${guesses} tentativas. Bora jogar juntos? https://t3rmo.com/` : `Joguei T3RMO com amigos${you ? `: posição ${you.rank}, ${you.score} pontos` : ''}. Bora jogar? https://t3rmo.com/`} /></div>
        </div>
        {!isHost && (
          <div className="hint" style={{ marginTop: 12 }}>quem criou a sala pode começar outra partida</div>
        )}
      </div>
    </div>
  );
}

/**
 * Arriving in a room whose match already ended used to render nothing at all —
 * `matchEnd` only reaches sockets that were present when it happened, so a
 * stale invite link produced a dead grey grid with no message and no exit.
 */
export function DeadRoomVeil({ code, onLeave }: { code: string; onLeave: () => void }) {
  return (
    <div className="veil" role="status">
      <div className="veil-box">
        <div className="kicker">sala {code}</div>
        <div className="vtitle">esta partida já acabou</div>
        <div className="hint" style={{ marginTop: 10 }}>o link que você abriu é de uma partida encerrada.</div>
        <button className="btn" style={{ marginTop: 20 }} onClick={onLeave}>abrir uma sala nova</button>
      </div>
    </div>
  );
}

/** Someone who joins mid-intermission has no roundEnd to show; the clock does. */
export function WaitVeil({ deadline, serverNow }: { deadline: number; serverNow: () => number }) {
  const [left, setLeft] = useState(() => deadline - serverNow());
  useEffect(() => {
    const id = setInterval(() => setLeft(deadline - serverNow()), 250);
    return () => clearInterval(id);
  }, [deadline, serverNow]);
  return (
    <div className="veil" role="status">
      <div className="veil-box">
        <div className="kicker">você entrou entre rodadas</div>
        <div className="vtitle">{Math.max(0, Math.ceil(left / 1000))}s</div>
        <div className="hint" style={{ marginTop: 8 }}>a próxima rodada começa e você joga desde o primeiro palpite.</div>
      </div>
    </div>
  );
}

export function LobbyVeil({
  online, isHost, onStart, code, feed = [], mode = 'termo', rounds = 3, format = 'TERMO', players = [], hostPrefix, onKick, onOpenPlayers,
}: {
  players?: RowWire[]; hostPrefix?: string | null; onKick?: (id: string) => void; onOpenPlayers: () => void;
  online: number;
  isHost: boolean;
  onStart: () => void;
  code: string;
  feed?: FeedWire[];
  mode?: string;
  rounds?: number;
  /** Label of the round about to play — 'TERMO' … 'QUARTETO', or 'MISTO'. */
  format?: string;
}) {
  const [kick, setKick] = useState<RowWire | null>(null);
  const link = `${location.origin}/?sala=${code}`;
  // Newest arrivals first — the lobby's proof of life while people trickle in.
  const arrivals = feed.filter((f) => f[0] === 'join').slice(-4).reverse();
  const modeLabel = mode === 'misto' ? 'MISTO' : format;
  return (
    <div className="veil lobby">
      <div className="lobby-card">
        <div className="kicker">sala aberta</div>
        <div className="lobby-code">{code}</div>

        <div className="lobby-tags">
          <span className="ltag" data-hl>{modeLabel}</span>
          <span className="ltag">{rounds} rodada{rounds > 1 ? 's' : ''}</span>
          {mode === 'misto' && <span className="ltag">sobe a escada</span>}
        </div>

        {online <= 1 ? (
          <div className="lobby-empty">
            <span className="lobby-dot" aria-hidden />
            A sala está pronta. Mande o convite ou comece sozinho.
          </div>
        ) : (
          <>
            <div className="lobby-live" aria-live="polite">
              <span className="lobby-dot" aria-hidden />
              <span className="lobby-n" key={online}>{fmtInt(online)}</span>
              <span className="lobby-unit">na sala</span>
            </div>
            {arrivals.length > 0 && (
              <div className="lobby-feed" aria-live="polite">
                {arrivals.map((a, i) => (
                  <div className="lobby-in" key={`${a[1]}-${i}`} style={{ opacity: 1 - i * 0.24 }}>
                    <b>{a[1]}</b> entrou
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="lobby-cta">
          {isHost && <button className="btn" onClick={onStart}>COMEÇAR AGORA</button>}
          <ShareAction label="Copiar convite" native={false} text={link} />
          <ShareAction label="Compartilhar convite" text={link} />
        </div>

        <div className="lobby-people" aria-label="Participantes">{players.slice(0, 20).map((row) => <div className="lobby-person" key={row[1]}><span>{row[2]} {row[1] === hostPrefix ? '· anfitrião' : ''}</span>{isHost && row[1] !== hostPrefix && <button className="link" onClick={() => setKick(row)}>Remover</button>}</div>)}</div>
        <button className="link" onClick={onOpenPlayers}>Ver todos os participantes · {online}</button>
        <div className="lobby-note">{isHost ? 'Comece quando seus amigos estiverem prontos.' : 'Esperando o anfitrião começar.'}</div>
        {kick && <Modal title={`Remover ${kick[2]}?`} onClose={() => setKick(null)}><p>Remove esta sessão e impede que o mesmo acesso volte à sala. Não bloqueia a pessoa em outros dispositivos.</p><button className="btn" onClick={() => { onKick?.(kick[1]); setKick(null); }}>Remover da sala</button></Modal>}
      </div>
    </div>
  );
}


/**
 * Leaving is cheap to do and expensive to undo, so it asks first.
 *
 * The cost is stated rather than implied: mid-match you lose your position and
 * your cumulative score, and the room does not hold your seat. In the lobby
 * there is nothing to lose and the copy says so — a warning that cries wolf
 * about a harmless action teaches people to click through the one that matters.
 */
export function LeaveVeil({
  phase, round, rounds, rank, onCancel, onConfirm,
}: {
  phase: string;
  round: number;
  rounds: number;
  rank: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const live = phase === 'playing' || phase === 'countdown' || phase === 'intermission';

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onCancel]);

  return (
    <Modal title="Sair da sala?" onClose={onCancel}>
      <div className="veil-box">
        <div className="kicker">{live ? `rodada ${round} de ${rounds} em andamento` : 'sala'}</div>
        <div className="vtitle">Sair da sala?</div>
        <p className="hint" style={{ marginTop: 12, maxWidth: 380, marginInline: 'auto' }}>
          {live
            ? <>A sala continua sem você. Seu acesso pode recuperar a partida neste navegador enquanto a sessão estiver disponível.</>
            : <>A partida ainda não começou, então não há nada a perder — você pode voltar pelo mesmo código.</>}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
          <button className="btn" onClick={onCancel} autoFocus>continuar jogando</button>
          <button className="btn" data-variant="danger" onClick={onConfirm}>sair mesmo assim</button>
        </div>
      </div>
    </Modal>
  );
}
