import { useEffect, useState } from 'react';
import { Confetti } from './Confetti.tsx';
import type { RowWire } from '@arena/core';
import { fmtInt } from '../lib/game.ts';

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
  you: { score: number; rank: number; solvedWords: number; guesses: number; roundScore: number } | null;
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
  standings, you, answers, onAgain, isHost,
}: {
  standings: RowWire[];
  you: { rank: number; score: number } | null;
  /** The final round's words — nothing else ever reveals them. */
  answers: string[];
  onAgain: () => void;
  isHost: boolean;
}) {
  const podium = standings.slice(0, 3);
  const onPodium = you !== null && you.rank > 0 && you.rank <= 3;
  return (
    <div className="veil" role="status">
      {podium.length > 0 && <Confetti />}
      <div className="veil-box">
        <div className="kicker">{onPodium ? 'você subiu no pódio' : 'partida encerrada'}</div>

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

        {you && !onPodium && (
          <div className="hint" style={{ marginTop: 12 }}>
            você terminou em <b style={{ color: 'var(--you)' }}>#{fmtInt(you.rank)}</b> com {fmtInt(you.score)} pontos
          </div>
        )}

        {standings.length > 3 && (
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

        {isHost
          ? <button className="btn" style={{ marginTop: 18, position: 'relative', zIndex: 2 }} onClick={onAgain}>jogar de novo</button>
          : <div className="hint" style={{ marginTop: 18 }}>aguardando quem criou a sala começar outra</div>}
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
  online, isHost, onStart, code,
}: {
  online: number;
  isHost: boolean;
  onStart: () => void;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/?sala=${code}`;
  return (
    <div className="veil">
      <div className="veil-box">
        <div className="kicker">sala aberta</div>
        <div className="vtitle">{code}</div>
        <div className="hint" style={{ marginTop: 10 }}>
          {online === 1 ? 'você é a única pessoa aqui' : `${fmtInt(online)} pessoas na sala`}
          {online >= 2 && ' · começa sozinho em 30s'}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn"
            data-variant="ghost"
            onClick={() => {
              navigator.clipboard?.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }).catch(() => undefined);
            }}
          >
            {copied ? 'LINK COPIADO' : 'COPIAR CONVITE'}
          </button>
          {isHost && <button className="btn" onClick={onStart}>COMEÇAR AGORA</button>}
        </div>

        {!isHost && <div className="hint" style={{ marginTop: 16 }}>quem criou a sala começa a partida</div>}
      </div>
    </div>
  );
}
