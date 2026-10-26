import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';

// ---------------------------------------------------------------- focus handling

/** Open dialogs, innermost last: only the topmost one reacts to Escape and traps Tab. */
const dialogStack: symbol[] = [];

/** Keeps keyboard focus inside an open dialog, closes on Escape and restores focus on close. */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest close handler, read at key time — so the dialog registers once per opening
  // (re-registering on every render would scramble which dialog is on top).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = Symbol('dialog');
    dialogStack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled')) : [];
    requestAnimationFrame(() => (node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0])?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== me) return; // a dialog above this one handles it
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      dialogStack.splice(dialogStack.indexOf(me), 1);
      if (!dialogStack.length) document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);
  return ref;
}

// ---------------------------------------------------------------- modal

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useDialogFocus(open, onClose);
  const titleId = useId();
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' }[size];
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim p-0 backdrop-blur-sm sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={`flex max-h-[92vh] w-full ${width} flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-pop)] sm:rounded-2xl`}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
              <div>
                <h2 id={titleId} className="text-base font-semibold text-ink">
                  {title}
                </h2>
                {description && <div className="mt-1 text-[0.82rem] text-ink-3">{description}</div>}
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close">
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
            {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3.5 sm:px-6">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Confirmation for consequential actions. The confirm button reflects the action (and its risk). */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'primary',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-ink-2">{body}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- slide-over panel

export function Drawer({ open, onClose, title, subtitle, children, width = 'max-w-3xl' }: { open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; children: ReactNode; width?: string }) {
  const ref = useDialogFocus(open, onClose);
  const titleId = useId();
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40 flex justify-end bg-scrim-soft backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ x: 48, opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 48, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className={`flex h-full w-full ${width} flex-col border-l border-line bg-canvas shadow-[var(--shadow-pop)]`}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line bg-surface/80 px-5 py-4 backdrop-blur sm:px-7">
              <div className="min-w-0">
                <h2 id={titleId} className="truncate text-lg font-semibold text-ink">
                  {title}
                </h2>
                {subtitle && <div className="mt-0.5 text-[0.82rem] text-ink-3">{subtitle}</div>}
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close panel">
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-7">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------- toasts

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random();
      setToasts((all) => [...all.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === 'error' ? 7000 : 4500);
    },
    [dismiss],
  );
  const icons = { success: <CheckCircle2 size={18} className="text-good-ink" aria-hidden />, error: <XCircle size={18} className="text-bad-ink" aria-hidden />, info: <Info size={18} className="text-accent" aria-hidden /> };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite" aria-atomic="false">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.22 }}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 shadow-[var(--shadow-pop)]"
            >
              {icons[t.tone]}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{t.title}</p>
                {t.description && <p className="mt-0.5 text-[0.8rem] text-ink-3">{t.description}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} className="rounded p-0.5 text-ink-3 hover:text-ink" aria-label="Dismiss notification">
                <X size={14} aria-hidden />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Inline banner used inside forms (e.g. a server-side validation summary). */
export function FormAlert({ title, items }: { title: string; items?: string[] }) {
  return (
    <div className="mb-4 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad-ink" role="alert">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle size={14} aria-hidden /> {title}
      </p>
      {items && items.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-[0.82rem]">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
