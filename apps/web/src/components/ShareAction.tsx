import { useState } from 'react';
export function ShareAction({ text, label = 'Compartilhar', native = true }: { text: string; label?: string; native?: boolean }) {
  const [status, setStatus] = useState('');
  const [fallback, setFallback] = useState(false);
  const share = async () => {
    setStatus(''); setFallback(false);
    if (native && navigator.share) {
      try { await navigator.share({ text }); return; }
      catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); setStatus('Copiado!'); }
    catch { setFallback(true); setStatus('Selecione e copie o texto abaixo.'); }
  };
  return <><button className="btn" data-variant="ghost" onClick={share}>{label}</button><span role="status">{status}</span>{fallback && <textarea className="share-fallback" aria-label="Texto para copiar" value={text} readOnly onFocus={(e) => e.target.select()} />}</>;
}
