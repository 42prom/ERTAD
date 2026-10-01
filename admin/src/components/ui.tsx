import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} className={`button ${variant} ${className}`} {...props} />;
}
export function Field({ label, error, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const generated = useId();
  const fieldId = id ?? generated;
  return <div className="field"><label htmlFor={fieldId}>{label}</label><input {...props} id={fieldId} aria-invalid={!!error} aria-describedby={error ? `${fieldId}-error` : undefined} />{error && <span className="error" id={`${fieldId}-error`}>{error}</span>}</div>;
}
export function Dialog({ open, onClose, title, closeLabel, children, footer }: { open: boolean; onClose: () => void; title: string; closeLabel: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><Button variant="ghost" onClick={onClose} aria-label={closeLabel}><X size={20} /></Button></header>
    <div className="dialog-content">{children}</div>{footer && <footer>{footer}</footer>}
  </dialog>;
}
