import { useEffect, useState } from 'react';
import { MODES, MODE_IDS, roundConfig, PACE_MIN, PACE_MAX, type Mode } from '@arena/core';
import { fmtClock } from '../lib/game.ts';

type Preview = { created?: boolean; phase?: string; mode?: Mode; rounds?: number; online?: number; training?: boolean; full?: boolean };
export function Landing({ name, setName, onCreate, onJoin, busy, error, onRules, onProgress }: {
  name: string; setName: (n: string) => void;
  onCreate: (mode: Mode, rounds: number, pace: number, training?: boolean) => void;
  onJoin: (code: string) => void | Promise<void>; busy: boolean; error: string | null;
  onRules: () => void; onProgress: () => void;
}) {
  const initial = new URLSearchParams(location.search).get('sala')?.toUpperCase() ?? '';
  const [step, setStep] = useState<'home' | 'setup' | 'join'>(initial ? 'join' : 'home');
  const [mode, setMode] = useState<Mode>('termo');
  const [rounds, setRounds] = useState(3);
  const [pace, setPace] = useState(1);
  const [code, setCode] = useState(initial);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (step !== 'join') return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    setPreview(null); setPreviewError('');
    fetch(`/api/rooms/${encodeURIComponent(code)}/info`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Não encontramos essa sala. Confira o código ou crie uma nova.' : 'Não foi possível consultar a sala. Tente novamente.');
        const info = await res.json() as Preview;
        if(info.training) throw new Error('Esse convite é de um treino solo. Crie uma sala para jogar com amigos.');
        if(info.full) throw new Error('A sala está cheia. Tente novamente em instantes.');
        if (!info.created) throw new Error('Não encontramos essa sala. Confira o código ou crie uma nova.');
        if (active) setPreview(info);
      }).catch((e) => { if (!active) return; if (!controller.signal.aborted) setPreviewError(e.message); else setPreviewError('A consulta demorou. Tente novamente.'); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [step, retry]);
  const duration = Array.from({ length: rounds }, (_, i) => roundConfig(mode, i + 1, pace).roundMs).reduce((a, b) => a + b, 0);
  const nick = <><label className="label" htmlFor="nick">Seu nome na sala</label><input id="nick" className="input" value={name} maxLength={16} placeholder="Como podemos chamar você?" onChange={(e) => setName(e.target.value)} /><p className="entry-note">É assim que você aparece na sala. Se deixar vazio, usaremos um nome temporário.</p></>;
  return <main className="entry">
    <header className="entry-header"><a href="/" className="mark-tiles" aria-label="T3RMO início">{[...'T3RMO'].map((ch, i) => <span className="mt" data-hit={i === 1 ? 'right' : 'plain'} key={i}>{ch}</span>)}</a><nav><button className="link" onClick={onRules}>Como jogar</button><button className="link" onClick={onProgress}>Meu progresso</button></nav></header>
    <div className="entry-grid"><section className="entry-main">
      {step === 'home' ? <>
        <p className="entry-eyebrow">JOGO DE PALAVRAS · EM TEMPO REAL</p>
        <h1>A mesma palavra.<br />Uma disputa entre amigos.</h1>
        <p className="entry-description">Crie uma sala, compartilhe o link e joguem ao mesmo tempo. Grátis, sem cadastro.</p>
        <div className="entry-actions"><button className="btn" disabled={busy} onClick={() => setStep('setup')}>Jogar com amigos</button><span className="entry-note">Você cria a sala e manda o convite.</span><button className="btn" data-variant="ghost" disabled={busy} onClick={() => onCreate('termo', 1, 1, true)}>{busy ? 'Preparando treino…' : 'Jogar agora'}</button><span className="entry-note">Treino solo · 1 rodada</span></div>
        <form className="entry-code" onSubmit={(e) => { e.preventDefault(); setStep('join'); }}><label htmlFor="room-code">Recebeu um código?</label><div className="join"><input id="room-code" aria-label="Código da sala" className="input" placeholder="CÓDIGO DA SALA" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /><button className="btn" data-variant="ghost" disabled={busy || code.length !== 4}>Entrar</button></div></form>
      </> : <>
        <button className="link" disabled={busy} onClick={() => setStep('home')}>← Voltar</button>
        <h1>{step === 'setup' ? 'Sua sala, suas regras.' : `Convite para a sala ${code}`}</h1>
        {step === 'setup' ? <form onSubmit={(e) => { e.preventDefault(); onCreate(mode, rounds, pace); }}>
          {nick}<p className="entry-summary">{MODES[mode].label} · {rounds} rodadas · {pace === 1 ? 'tempo normal' : `${pace}× tempo`}<small>Até {fmtClock(duration)} de relógio, mais as pausas entre rodadas.</small></p>
          <details className="entry-custom"><summary>Personalizar partida</summary><fieldset><legend>Formato</legend><div className="entry-modes">{MODE_IDS.map((m) => <label key={m}><input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); if (m === 'misto') setRounds(4); }} />{MODES[m].label}</label>)}</div></fieldset>{mode === 'misto' && <p className="entry-note">Uma rodada de cada formato. Depois do quarteto, a sequência recomeça.{rounds < 4 ? ' Com menos de 4 rodadas, você não passa por todos os formatos.' : ''}</p>}<label className="label" htmlFor="rounds">Rodadas: {rounds}</label><input id="rounds" className="slider" type="range" min={1} max={12} value={rounds} onChange={(e) => setRounds(+e.target.value)} /><label className="label" htmlFor="pace">Tempo: {pace}×</label><input id="pace" className="slider" type="range" min={PACE_MIN} max={PACE_MAX} step="0.1" value={pace} onChange={(e) => setPace(+e.target.value)} /></details>
          <button className="btn" disabled={busy}>{busy ? 'Criando sala…' : 'Criar sala'}</button>
        </form> : <>
          {!preview && !previewError && <p role="status">Consultando sala…</p>}
          {previewError && <><p role="alert">{previewError}</p><button className="btn" onClick={() => setRetry(retry + 1)}>Tentar novamente</button></>}
          {preview && (preview.phase === 'finished' ? <><p>Essa partida terminou.</p><button className="btn" onClick={() => setStep('setup')}>Criar nova sala</button><button className="btn" data-variant="ghost" disabled={busy} onClick={() => onCreate('termo', 1, 1, true)}>Treinar agora</button></> : <form onSubmit={(e) => { e.preventDefault(); onJoin(code); }}><p className="entry-summary">{preview.mode ? MODES[preview.mode]?.label : 'Sala de amigos'} · {preview.online ?? 0} participantes</p>{preview.phase === 'playing' && <p>Você entra na rodada em andamento, com o tempo restante. A próxima começa junto para todos.</p>}{nick}<button className="btn" disabled={busy}>{busy ? 'Entrando…' : 'Entrar na sala'}</button></form>)}
        </>}
      </>}
      {error && <p className="err" role="alert">{error}</p>}
    </section><aside className="entry-example"><p className="entry-eyebrow">CADA PALPITE, UMA PISTA</p><div className="example-board" aria-label="Exemplo ilustrativo: letra certa, posição diferente e letra ausente">{[...'TURMA'].map((ch, i) => <span className="ex-t" data-state={i === 0 ? 2 : i === 2 ? 1 : 0} key={i}>{ch}</span>)}</div><h2>Encontre as cinco letras.</h2><p>Verde: letra no lugar certo.<br />Areia: letra em outra posição.<br />Escuro: letra ausente.</p><p className="entry-note">Exemplo ilustrativo. Ative símbolos em “Como jogar” se preferir pistas além das cores.</p></aside></div>
    <footer className="entry-footer"><p>Acertos, tentativas, velocidade e sequência compõem sua pontuação. Um palpite vale para todos os tabuleiros da rodada.</p><nav><a href="/como-jogar/">Regras e pontuação</a><a href="/jogar-com-amigos/">Como jogar com amigos</a></nav></footer>
  </main>;
}
