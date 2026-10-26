import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Bot, CheckCircle2, ChevronLeft, ChevronRight, CircleSlash, Inbox, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError, type DecisionSummary } from './api';

// ---------------------------------------------------------------- data loading

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (id === seq.current) setData(result);
    } catch (e) {
      if (id === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}

/** Debounced value for search inputs. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------------------------------------------------------------- layout

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.65rem]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className = '',
  title,
  subtitle,
  action,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  padded?: boolean;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className={`rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] ${padded ? 'p-5 sm:p-6' : ''} ${className}`}
    >
      {(title || action) && (
        <div className={`mb-4 flex flex-wrap items-start justify-between gap-3 ${padded ? '' : 'px-5 pt-5 sm:px-6 sm:pt-6'}`}>
          <div className="min-w-0">
            {title && <h2 className="text-[0.95rem] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[0.8rem] text-ink-3">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </motion.section>
  );
}

// ---------------------------------------------------------------- badges

const tones = {
  neutral: 'bg-surface-3 text-ink-2 ring-line-strong',
  teal: 'bg-accent-soft text-accent-strong ring-accent/30',
  violet: 'bg-ai-soft text-ai ring-ai/30',
  good: 'bg-good-soft text-good-ink ring-good/40',
  warn: 'bg-warn-soft text-warn-ink ring-warn/30',
  bad: 'bg-bad-soft text-bad-ink ring-bad/40',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', children, icon, title }: { tone?: Tone; children: ReactNode; icon?: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.72rem] font-medium ring-1 ring-inset ${tones[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: DecisionSummary['status'] }) {
  const map: Record<string, [Tone, string, ReactNode]> = {
    approved: ['good', 'Approved', <ShieldCheck key="i" size={12} aria-hidden />],
    dry_run: ['good', 'Would be approved', <ShieldCheck key="i" size={12} aria-hidden />],
    rejected: ['bad', 'Blocked by validator', <ShieldAlert key="i" size={12} aria-hidden />],
    cancelled: ['warn', 'Cancelled before send', <XCircle key="i" size={12} aria-hidden />],
    no_offer: ['neutral', 'No offer', <CircleSlash key="i" size={12} aria-hidden />],
    error: ['bad', 'Error — not sent', <AlertTriangle key="i" size={12} aria-hidden />],
    pending: ['neutral', 'Pending', <Loader2 key="i" size={12} className="animate-spin" aria-hidden />],
  };
  const [tone, label, icon] = map[status] ?? ['neutral', status, null];
  return (
    <Badge tone={tone} icon={icon}>
      {label}
    </Badge>
  );
}

export function PathBadge({ path }: { path: DecisionSummary['path'] }) {
  if (path === 'ai') return <Badge tone="violet" icon={<Sparkles size={12} aria-hidden />}>Claude</Badge>;
  if (path === 'ai_retry') return <Badge tone="violet" icon={<Sparkles size={12} aria-hidden />}>Claude · retry</Badge>;
  if (path === 'fallback') return <Badge tone="warn" icon={<Bot size={12} aria-hidden />} title="Claude was unavailable or its proposal failed validation; the deterministic rule-based choice was used and validated">Rule-based fallback</Badge>;
  return <Badge tone="neutral">No AI needed</Badge>;
}

// ---------------------------------------------------------------- buttons

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-strong shadow-[0_6px_20px_-8px_var(--color-accent-glow)]',
  secondary: 'bg-surface-3 text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-4',
  ghost: 'text-ink-2 hover:bg-surface-3 hover:text-ink',
  danger: 'bg-bad-soft text-bad-ink ring-1 ring-inset ring-bad/40 hover:bg-bad/25',
};

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled,
  busy,
  icon,
  type = 'button',
  title,
  className = '',
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: disabled || busy ? 1 : 0.97 }}
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        size === 'sm' ? 'px-2.5 py-1.5 text-[0.8rem]' : 'px-3.5 py-2 text-sm'
      } ${buttonStyles[variant]} ${className}`}
    >
      {busy ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" aria-hidden /> : icon}
      {children}
    </motion.button>
  );
}

// ---------------------------------------------------------------- forms

export const inputClass =
  'w-full rounded-xl border border-line-strong bg-surface-3/70 px-3 py-2 text-sm text-ink placeholder:text-ink-3/80 transition-colors hover:border-ink-3/60 focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/30 aria-[invalid=true]:border-bad aria-[invalid=true]:ring-bad/30';

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="text-sm">
      <label htmlFor={htmlFor} className="mb-1.5 block font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 flex items-center gap-1 text-[0.78rem] text-bad-ink" role="alert">
          <AlertTriangle size={12} aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[0.78rem] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-inset ring-line-strong'}`}
    >
      <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 32 }} className={`inline-block h-4.5 w-4.5 rounded-full bg-white shadow ${checked ? 'ml-[1.4rem]' : 'ml-1'}`} />
    </button>
  );
}

export function SegmentedControl<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  const group = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-line bg-surface-2 p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`relative shrink-0 rounded-lg px-3 py-1.5 text-[0.8rem] font-medium whitespace-nowrap transition-colors ${active ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {active && <motion.span layoutId={`seg-${group}`} className="absolute inset-0 rounded-lg bg-surface-3 ring-1 ring-line-strong" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- states

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-ink-3" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden /> {label}
    </div>
  );
}
export const Loading = Spinner;

export function Skeleton({ rows = 3, className = 'h-11' }: { rows?: number; className?: string }) {
  return (
    <div className="space-y-2.5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`animate-pulse rounded-xl bg-surface-3/70 ${className}`} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-bad/30 bg-bad-soft p-4 text-sm text-bad-ink" role="alert">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle size={16} aria-hidden /> {error.message}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} icon={<RefreshCw size={14} aria-hidden />}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
      <div className="mb-1 grid h-10 w-10 place-items-center rounded-xl bg-surface-3 text-ink-3">{icon ?? <Inbox size={18} aria-hidden />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-[0.8rem] text-ink-3">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-good-ink" role="status">
      <CheckCircle2 size={16} aria-hidden /> {children}
    </p>
  );
}

// ---------------------------------------------------------------- data display

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const tone = ratio >= 0.9 ? 'bg-warn' : 'bg-accent';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <motion.div className={`h-full rounded-full ${tone}`} initial={{ width: 0 }} animate={{ width: `${ratio * 100}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} />
    </div>
  );
}

export function KpiTile({ label, value, hint, icon, accent = 'teal' }: { label: string; value: ReactNode; hint?: ReactNode; icon: ReactNode; accent?: 'teal' | 'violet' | 'good' | 'bad' | 'neutral' }) {
  const ring: Record<string, string> = {
    teal: 'text-accent bg-accent-soft',
    violet: 'text-ai bg-ai-soft',
    good: 'text-good-ink bg-good-soft',
    bad: 'text-bad-ink bg-bad-soft',
    neutral: 'text-ink-2 bg-surface-3',
  };
  return (
    <Card className="p-4! sm:p-5!">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.8rem] font-medium text-ink-3">{label}</p>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ring[accent]}`}>{icon}</span>
      </div>
      <p className="mt-2 text-[1.75rem] leading-none font-semibold tracking-tight text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-2 text-[0.76rem] leading-snug text-ink-3">{hint}</p>}
    </Card>
  );
}

export function SortHeader({ label, active, direction, onClick, align = 'left' }: { label: string; active: boolean; direction: 'asc' | 'desc'; onClick: () => void; align?: 'left' | 'right' }) {
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1 font-medium hover:text-ink ${active ? 'text-ink' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      {label}
      <Icon size={12} aria-hidden className={active ? 'text-accent' : 'opacity-60'} />
      <span className="sr-only">{active ? `sorted ${direction === 'asc' ? 'ascending' : 'descending'}` : 'not sorted'}</span>
    </button>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[0.8rem] text-ink-3 sm:px-5">
      <span>
        {from}–{to} of {total.toLocaleString('en-IN')}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft size={14} aria-hidden />}>
          <span className="sr-only sm:not-sr-only">Previous</span>
        </Button>
        <span className="px-2 tabular-nums text-ink-2">
          {page} / {pages}
        </span>
        <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <span className="sr-only sm:not-sr-only">Next</span>
          <ChevronRight size={14} aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

export const thClass = 'px-4 py-3 text-left text-[0.72rem] font-medium uppercase tracking-wider text-ink-3 sm:px-5';
export const tdClass = 'px-4 py-3 sm:px-5';

export const segmentLabel = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
