import { useEffect, type ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // Capture phase: the game listens for every keystroke on window, and without
    // this an Escape would close the modal AND be read as gameplay input.
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);

  return (
    <div className="mdl-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="mdl" onClick={(e) => e.stopPropagation()}>
        <div className="mdl-hd">
          <span className="mdl-t">{title}</span>
          <button className="mdl-x" onClick={onClose} aria-label="fechar">✕</button>
        </div>
        <div className="mdl-b">{children}</div>
      </div>
    </div>
  );
}
