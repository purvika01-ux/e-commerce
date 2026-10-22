import { AlertTriangle, Bot, CheckCircle2, CircleSlash, Cpu, Loader2, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, type DecisionSummary } from './api';

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}
    >
      {children}
    </motion.section>
  );
}

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const tones = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
} as const;

export function Badge({ tone = 'slate', children, icon }: { tone?: keyof typeof tones; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: DecisionSummary['status'] }) {
  const map: Record<string, [keyof typeof tones, string, ReactNode]> = {
    approved: ['green', 'Approved', <ShieldCheck key="i" size={12} />],
    dry_run: ['green', 'Would be approved', <ShieldCheck key="i" size={12} />],
    rejected: ['red', 'Rejected by validator', <ShieldAlert key="i" size={12} />],
    cancelled: ['amber', 'Cancelled before send', <XCircle key="i" size={12} />],
    no_offer: ['slate', 'No offer', <CircleSlash key="i" size={12} />],
    error: ['red', 'Error — not sent', <AlertTriangle key="i" size={12} />],
    pending: ['slate', 'Pending', <Loader2 key="i" size={12} className="animate-spin" />],
  };
  const [tone, label, icon] = map[status] ?? ['slate', status, null];
  return (
    <Badge tone={tone} icon={icon}>
      {label}
    </Badge>
  );
}

export function PathBadge({ path }: { path: DecisionSummary['path'] }) {
  if (path === 'ai') return <Badge tone="violet" icon={<Cpu size={12} />}>Claude</Badge>;
  if (path === 'ai_retry') return <Badge tone="violet" icon={<Cpu size={12} />}>Claude (retry)</Badge>;
  if (path === 'fallback') return <Badge tone="amber" icon={<Bot size={12} />}>Rule-based fallback</Badge>;
  return <Badge tone="slate">No AI needed</Badge>;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  busy,
  icon,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
    secondary: 'bg-white text-ink-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
    ghost: 'text-ink-700 hover:bg-slate-100',
    danger: 'bg-white text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]}`}
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-ink-500" role="status">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle size={16} /> {error.message}
      </div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} icon={<RefreshCw size={14} />}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 py-10 text-center">
      <div className="text-slate-400">{icon ?? <CheckCircle2 size={22} />}</div>
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Meter({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'amber' }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <motion.div
        className={`h-full rounded-full ${tone === 'amber' ? 'bg-amber-500' : 'bg-brand-500'}`}
        initial={{ width: 0 }}
        animate={{ width: `${ratio * 100}%` }}
        transition={{ duration: 0.5 }}
      />
    </div>
  );
}

export const segmentLabel = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
