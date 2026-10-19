import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/format';
import { Button, Icon } from './primitives';

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export function Modal({ open, onClose, title, sub, children, foot, size, busy }: {
  open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children?: ReactNode; foot?: ReactNode;
  size?: 'wide' | 'full'; busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Tab' && ref.current) {
        // Keep focus inside the dialog
        const f = ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => {
      const target = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea') ?? ref.current;
      target?.focus();
    }, 0);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose, busy]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} className={cx('modal', size && `modal--${size}`)} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Dialog'} tabIndex={-1}>
        <div className="modal__head">
          <div className="grow">
            <div className="modal__title">{title}</div>
            {sub && <div className="card__sub">{sub}</div>}
          </div>
          <button type="button" className="iconbtn" aria-label="Close dialog" onClick={onClose} disabled={busy}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {foot && <div className="modal__foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog (promise-based)
// ---------------------------------------------------------------------------
interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  icon?: string;
}

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title ?? ''}
        foot={
          <>
            <Button onClick={() => close(false)}>{state?.cancelLabel ?? 'Cancel'}</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} icon={state?.icon} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {typeof state?.body === 'string' ? <p className="t-sm">{state.body}</p> : state?.body}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type ToastTone = 'success' | 'critical' | 'warning' | 'info';
interface ToastItem { id: number; msg: string; tone: ToastTone; icon?: string; leaving?: boolean }

const ToastCtx = createContext<(msg: string, tone?: ToastTone, icon?: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const toast = useCallback((msg: string, tone: ToastTone = 'success', icon?: string) => {
    const id = ++seq.current;
    setItems((x) => [...x.slice(-3), { id, msg, tone, icon }]);
    setTimeout(() => setItems((x) => x.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 3600);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 3950);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {createPortal(
        <div className="toast-root" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={cx('toast', t.tone !== 'info' && `toast--${t.tone}`)} role="status"
              style={t.leaving ? { opacity: 0, transform: 'translateY(6px)', transition: 'opacity .3s, transform .3s' } : undefined}>
              <Icon name={t.icon ?? (t.tone === 'success' ? 'check' : t.tone === 'critical' ? 'alert' : 'info')} size={17} />
              <span>{t.msg}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

// ---------------------------------------------------------------------------
// Anchored dropdown menu (flips above when there is no room below)
// ---------------------------------------------------------------------------
export function Dropdown({ anchor, open, onClose, children, label, align = 'right' }: {
  anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode; label: string; align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const el = ref.current;
    const w = el.offsetWidth, h = el.offsetHeight, gap = 8, edge = 12;
    let left = align === 'left' ? r.left : r.right - w;
    left = Math.max(edge, Math.min(left, window.innerWidth - w - edge));
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - edge) {
      const above = r.top - gap - h;
      top = above >= edge ? above : Math.max(edge, window.innerHeight - h - edge);
    }
    setPos({ left: Math.round(left), top: Math.round(top) });
    el.querySelector<HTMLElement>('button:not([disabled]), a')?.focus();
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="dropdown-backdrop" onMouseDown={onClose} />
      <div ref={ref} className="menu menu--panel" role="menu" aria-label={label}
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }} onClick={(e) => { if ((e.target as HTMLElement).closest('[data-close]')) onClose(); }}>
        {children}
      </div>
    </>,
    document.body,
  );
}
