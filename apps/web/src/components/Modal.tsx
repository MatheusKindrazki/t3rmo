import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current!;
    node.showModal();
    return () => { node.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="mdl native-modal" aria-label={title} onCancel={(e) => { e.preventDefault(); close.current(); }} onKeyDown={(e) => e.stopPropagation()} onClick={(e) => { if (e.target === dialog.current) close.current(); }}>
    <div className="mdl-inner"><div className="mdl-hd"><span className="mdl-t">{title}</span><button className="mdl-x" onClick={onClose} aria-label="fechar">✕</button></div><div className="mdl-b">{children}</div></div>
  </dialog>;
}
