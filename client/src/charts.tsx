import { CircleSlash, ShieldAlert, ShieldCheck, Table2, BarChart3 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/*
 * Charts are hand-written SVG (no chart library). Rules followed:
 * one axis, recessive grid, thin marks with 2px surface gaps, a legend with icon + label
 * (never colour alone), a hover tooltip per mark, and a table view of the same data.
 * Outcome colours are the fixed status palette: approved = good, blocked = critical,
 * no offer = neutral slate (deliberately grey: "nothing happened").
 * Two unrelated measures use the validated chart pair (--color-chart-1 / --color-chart-2).
 */

export interface OutcomePoint {
  date: string; // YYYY-MM-DD (IST)
  approved: number;
  noOffer: number;
  blocked: number;
}

export interface ChartSeries<K extends string> {
  key: K;
  label: string;
  color: string;
  icon: ReactNode;
}

const OUTCOME_SERIES: ChartSeries<'approved' | 'noOffer' | 'blocked'>[] = [
  { key: 'approved', label: 'Approved', color: 'var(--color-good)', icon: <ShieldCheck size={13} aria-hidden /> },
  { key: 'noOffer', label: 'No offer', color: 'var(--color-neutral-mark)', icon: <CircleSlash size={13} aria-hidden /> },
  { key: 'blocked', label: 'Blocked or cancelled', color: 'var(--color-bad)', icon: <ShieldAlert size={13} aria-hidden /> },
];

export const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

function niceMax(v: number) {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

export function ChartLegend({ items }: { items: { label: string; color: string; icon?: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.78rem] text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          <span className="text-ink-3">{i.icon}</span>
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export function OutcomeChart({ points }: { points: OutcomePoint[] }) {
  return <DailyChart points={points} series={OUTCOME_SERIES} mode="stack" caption="Decision outcomes per day" emptyText="No decisions in this period yet." />;
}

/**
 * Daily bars for one or more counts. "stack" for parts of a whole (outcomes of the same decisions);
 * "group" for measures that overlap (e.g. delivered vs claimed — claims are a subset, so never stacked).
 */
export function DailyChart<K extends string>({
  points,
  series,
  mode,
  caption,
  emptyText,
}: {
  points: ({ date: string } & Record<K, number>)[];
  series: ChartSeries<K>[];
  mode: 'stack' | 'group';
  caption: string;
  emptyText: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Draw in real pixels so axis text keeps its size in narrow cards and on phones.
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  const value = (p: Record<K, number>, k: K) => p[k] ?? 0;
  const heights = points.map((p) => (mode === 'stack' ? series.reduce((s, x) => s + value(p, x.key), 0) : Math.max(0, ...series.map((x) => value(p, x.key)))));
  const max = niceMax(Math.max(0, ...heights));
  const H = 224;
  const pad = { l: 34, r: 8, t: 10, b: 26 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(1, points.length);
  const groupW = Math.max(3, Math.min(mode === 'group' ? 30 : 22, slot * 0.62));
  const barW = mode === 'group' ? Math.max(2, (groupW - 2 * (series.length - 1)) / series.length) : groupW;
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(W / 80)));
  const any = heights.some((t) => t > 0);
  const sum = Object.fromEntries(series.map((s) => [s.key, points.reduce((acc, p) => acc + value(p, s.key), 0)])) as Record<K, number>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ChartLegend items={series.map((s) => ({ label: `${s.label} · ${sum[s.key]}`, color: s.color, icon: s.icon }))} />
        <button
          onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[0.78rem] text-ink-3 hover:bg-surface-3 hover:text-ink"
          aria-pressed={view === 'table'}
        >
          {view === 'chart' ? <Table2 size={14} aria-hidden /> : <BarChart3 size={14} aria-hidden />}
          {view === 'chart' ? 'View as table' : 'View as chart'}
        </button>
      </div>

      {view === 'table' ? (
        <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="sticky top-0 bg-surface-2 text-left text-[0.72rem] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-4 py-2">Day</th>
                {series.map((s) => (
                  <th key={s.key} className="px-4 py-2 text-right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...points].reverse().map((p) => (
                <tr key={p.date}>
                  <td className="px-4 py-2 text-ink-2">{dayLabel(p.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-4 py-2 text-right tabular-nums">
                      {value(p, s.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative" onMouseLeave={() => setHover(null)}>
          {!any && <p className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-sm text-ink-3">{emptyText}</p>}
          <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label={`${caption}: ${series.map((s) => `${sum[s.key]} ${s.label.toLowerCase()}`).join(', ')}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeDasharray={t === 0 ? undefined : '3 4'} />
                <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="var(--color-ink-3)">
                  {Number.isInteger(t) ? t : t.toFixed(1)}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx = pad.l + slot * i + slot / 2;
              let marks: ReactNode[];
              if (mode === 'stack') {
                let acc = 0;
                const segs = series
                  .map((s) => {
                    const v = value(p, s.key);
                    const y0 = y(acc);
                    acc += v;
                    return { s, v, top: y(acc), h: Math.max(0, y0 - y(acc)) };
                  })
                  .filter((x) => x.v > 0);
                // 2px surface gap between stacked segments
                marks = segs.map((seg, k) => (
                  <rect key={seg.s.key} className="chart-bar" x={cx - barW / 2} y={seg.top} width={barW} height={Math.max(1, seg.h - (k > 0 ? 2 : 0))} rx={Math.min(4, barW / 3)} fill={seg.s.color} />
                ));
              } else {
                const left = cx - groupW / 2;
                marks = series.map((s, k) => {
                  const v = value(p, s.key);
                  if (v <= 0) return null;
                  return <rect key={s.key} className="chart-bar" x={left + k * (barW + 2)} y={y(v)} width={barW} height={Math.max(1, y(0) - y(v))} rx={Math.min(4, barW / 3)} fill={s.color} />;
                });
              }
              return (
                <g key={p.date}>
                  {hover === i && <rect x={cx - slot / 2} y={pad.t} width={slot} height={plotH} fill="#ffffff08" rx={6} />}
                  {marks}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-ink-3)">
                      {dayLabel(p.date)}
                    </text>
                  )}
                  {/* hit target larger than the mark */}
                  <rect x={cx - slot / 2} y={pad.t} width={slot} height={plotH + 4} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
                </g>
              );
            })}
          </svg>
          {hover !== null && points[hover] && (
            <div
              className="pointer-events-none absolute top-2 z-20 min-w-44 rounded-xl border border-line-strong bg-surface-2 px-3 py-2.5 text-[0.78rem] shadow-[var(--shadow-pop)]"
              style={{ left: `clamp(0px, calc(${((pad.l + slot * hover + slot / 2) / W) * 100}% - 88px), calc(100% - 180px))` }}
            >
              <p className="mb-1.5 font-medium text-ink">{dayLabel(points[hover].date, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
                    {s.label}
                  </span>
                  <span className="tabular-nums text-ink">{value(points[hover], s.key)}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars for one measure (single hue — identity is the row label). */
export function BarList({ items, format = (v) => v.toLocaleString('en-IN'), onSelect }: { items: { key: string; label: string; value: number }[]; format?: (v: number) => string; onSelect?: (key: string) => void }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => {
        const content = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[0.82rem]">
              <span className="text-ink-2">{i.label}</span>
              <span className="tabular-nums text-ink">{format(i.value)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent/80 transition-[width] duration-700" style={{ width: `${(i.value / max) * 100}%` }} />
            </div>
          </>
        );
        return (
          <li key={i.key}>
            {onSelect ? (
              <button onClick={() => onSelect(i.key)} className="block w-full rounded-lg text-left hover:opacity-90">
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}
