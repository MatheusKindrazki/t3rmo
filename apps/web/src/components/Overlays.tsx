import { useEffect, useState } from 'react';
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
  standings, you, onAgain, isHost,
}: {
  standings: RowWire[];
  you: { rank: number; score: number } | null;
  onAgain: () => void;
  isHost: boolean;
}) {
  return (
    <div className="veil">
      <div className="veil-box">
        <div className="kicker">partida encerrada</div>
        <div className="vtitle" style={{ color: 'var(--right)' }}>
          {standings[0] ? standings[0][2] : '—'}
        </div>
        {you && <div className="hint" style={{ marginTop: 6 }}>você terminou em #{fmtInt(you.rank)} com {fmtInt(you.score)} pontos</div>}

        <div className="pod" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {standings.slice(0, 12).map(([rank, id, name, score, guesses, , mine]) => (
            <div className="pod-r" key={id} data-p={rank <= 3 ? rank : undefined}
                 style={mine === 1 ? { background: 'rgba(79,216,255,.1)' } : undefined}>
              <span className="lb-k">{rank}</span>
              <span className="lb-nm">{name}</span>
              <span className="lb-a">{guesses}t</span>
              <span className="lb-s">{fmtInt(score)}</span>
            </div>
          ))}
        </div>

        {isHost
          ? <button className="btn" style={{ marginTop: 20 }} onClick={onAgain}>JOGAR DE NOVO</button>
          : <div className="hint" style={{ marginTop: 20 }}>aguardando quem criou a sala começar outra</div>}
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
