import { AlertTriangle, Ban, BookOpen, CircleSlash, Cpu, Eye, Filter, HandCoins, Info, MousePointerClick, RotateCcw, Send, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { api, rupees, SEGMENTS, type AnalyticsOrigin, type AnalyticsRange, type AnalyticsReport, type OfferItem, type Rate } from '../api';
import { dayLabel, DailyChart } from '../charts';
import { Badge, Button, Card, EmptyState, ErrorState, Field, inputClass, KpiTile, PageHeader, SegmentedControl, segmentLabel, Skeleton, SortHeader, tdClass, thClass, useAsync } from '../ui';

// ---------------------------------------------------------------- labels

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

const ORIGINS: { value: AnalyticsOrigin; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'classmate', label: 'Bot requests (classmates)' },
  { value: 'admin', label: 'Dashboard decisions' },
];

/** Plain-language names for stored reason, rule and failure codes. Unknown codes fall back to a readable form. */
const CODE_LABEL: Record<string, string> = {
  NO_ELIGIBLE_OFFERS: 'No offer passed the business rules',
  AI_CHOSE_NO_OFFER: 'Claude decided no offer was needed',
  NO_CANDIDATE_PASSED_VALIDATION: 'Every candidate failed validation',
  PRESEND_CHECK_FAILED: 'Final check before sending failed',
  DELIVERY_INTERRUPTED: 'Delivery interrupted (voided, not resent)',
  DELIVERY_FAILED_BLOCKED: 'Telegram: user had blocked the bot',
  DELIVERY_FAILED_NETWORK: 'Telegram: network failure',
  DELIVERY_FAILED_RATE_LIMITED: 'Telegram: rate limited',
  ABANDONED: 'Interrupted by a server restart',
  FREQUENCY_CAP: 'Contacted too often recently',
  NO_STACKING: 'Already holds an unused offer',
  PURCHASE_COOLDOWN: 'Bought very recently',
  LIKELY_BUYER_SUPPRESSION: 'Likely to buy without a discount',
  RETURN_ABUSE_EXCLUSION: 'High return rate',
  SEGMENT_EXCLUSION: 'Segment excluded from discounts',
  OPTED_OUT: 'Opted out',
  OFFER_TARGETING: "Outside the offer's target group",
  PER_CUSTOMER_LIMIT: 'Per-customer limit reached',
  MIN_ORDER_FOR_DISCOUNT: 'Minimum basket below the rule',
  MAX_DISCOUNT_PERCENT: 'Discount % above the cap',
  MAX_DISCOUNT_AMOUNT: 'Discount value above the cap',
  OFFER_EXPIRY_BUFFER: 'Offer ends too soon',
  OFFER_EXPIRED: 'Offer expired',
  OFFER_NOT_STARTED: 'Offer not started yet',
  OFFER_INACTIVE: 'Offer not active',
  OFFER_NOT_FOUND: 'Offer not found',
  OFFER_CHANGED: 'Offer changed after approval',
  BUDGET_EXHAUSTED: 'Budget used up',
  USAGE_LIMIT: 'Usage limit reached',
  NOT_A_CANDIDATE: 'Claude picked an ineligible offer',
  NO_OFFER_SELECTED: 'No offer selected',
  SCHEMA_INVALID: "Claude's output was malformed",
  COPY_POLICY: 'Wording broke the copy policy',
  COPY_MISREPRESENTS_OFFER: 'Wording misstated the terms',
  COPY_CONTAINS_TERMS: 'Wording restated the terms',
  COPY_REQUIRED: 'Wording missing',
  VALIDATOR_ERROR: 'Validator error (failed closed)',
  GRANT_NOT_ACTIVE: 'Offer no longer active at send time',
  NOT_DELIVERABLE: 'No active Telegram link',
  TELEGRAM_NOT_CONFIGURED: 'Telegram not configured',
  CUSTOMER_NOT_FOUND: 'Customer not found',
  PRESEND_CHECK_ERROR: 'Final check could not run (failed closed)',
  INTERRUPTED: 'Interrupted mid-send (not resent)',
  blocked: 'User had blocked the bot',
  network: 'Network failure',
  rate_limited: 'Rate limited by Telegram',
};
const label = (code: string) => CODE_LABEL[code] ?? code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const pct = (r: Rate) => (r.value === null ? '—' : `${Math.round(r.value * 100)}%`);
const count = (n: number) => n.toLocaleString('en-IN');

// ---------------------------------------------------------------- page

interface Filters {
  range: AnalyticsRange;
  from: string;
  to: string;
  segment: string;
  offer: string;
  origin: AnalyticsOrigin;
}

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const DEFAULTS: Filters = { range: '30d', from: shiftDay(todayIst(), -13), to: todayIst(), segment: '', offer: '', origin: 'all' };

function customError(f: Filters): string | null {
  if (f.range !== 'custom') return null;
  if (!f.from || !f.to) return 'Choose both dates.';
  if (f.from > f.to) return 'The start date must be on or before the end date.';
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 + 1 > 366) return 'Choose at most 366 days.';
  return null;
}

function toQuery(f: Filters): string {
  const p = new URLSearchParams({ range: f.range });
  if (f.range === 'custom') {
    p.set('from', f.from);
    p.set('to', f.to);
  }
  if (f.segment) p.set('segment', f.segment);
  if (f.offer) p.set('offer', f.offer);
  if (f.origin !== 'all') p.set('origin', f.origin);
  return p.toString();
}

export function Analytics() {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const invalid = customError(filters);
  // Only valid filter combinations reach the server; an invalid custom range keeps the last result.
  const lastValid = useRef(toQuery(DEFAULTS));
  if (!invalid) lastValid.current = toQuery(filters);
  const applied = lastValid.current;

  const { data, error, loading, reload } = useAsync(() => api.get<AnalyticsReport>(`/analytics?${applied}`), [applied]);
  const offers = useAsync(() => api.get<{ items: OfferItem[] }>('/offers'));
  const filtered = filters.segment || filters.offer || filters.origin !== 'all';

  return (
    <div>
      <PageHeader
        title="Campaign results"
        description="What happened to the offers the engine decided: delivery, customer responses, budget and why offers were withheld. Computed on the server from stored records."
      />

      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-surface/60 p-3.5" role="group" aria-label="Filters">
        <div className="overflow-x-auto">
          <SegmentedControl label="Time range" options={RANGES} value={filters.range} onChange={(v) => set('range', v)} />
        </div>
        {filters.range === 'custom' && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From" htmlFor="an-from">
              <input id="an-from" type="date" className={`${inputClass} w-40`} value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} aria-invalid={Boolean(invalid)} />
            </Field>
            <Field label="To" htmlFor="an-to">
              <input id="an-to" type="date" className={`${inputClass} w-40`} value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} aria-invalid={Boolean(invalid)} />
            </Field>
          </div>
        )}
        <div className="w-full sm:w-44">
          <select className={inputClass} aria-label="Segment" value={filters.segment} onChange={(e) => set('segment', e.target.value)}>
            <option value="">All segments</option>
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {segmentLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:w-56">
          <select className={inputClass} aria-label="Offer" value={filters.offer} onChange={(e) => set('offer', e.target.value)}>
            <option value="">All offers</option>
            {(offers.data?.items ?? []).map((o) => (
              <option key={o.code} value={o.code}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:w-56">
          <select className={inputClass} aria-label="Source" value={filters.origin} onChange={(e) => set('origin', e.target.value as AnalyticsOrigin)}>
            {ORIGINS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {(filtered || filters.range !== '30d') && (
          <Button variant="ghost" size="sm" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setFilters(DEFAULTS)}>
            Reset
          </Button>
        )}
        {invalid && (
          <p className="w-full text-[0.8rem] text-bad-ink" role="alert">
            {invalid} Showing the previous result.
          </p>
        )}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} rows={1} className="h-32" />
            ))}
          </div>
          <Skeleton rows={1} className="h-72" />
        </div>
      ) : (
        <Report data={data} loading={loading} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- report

function windowText(r: AnalyticsReport) {
  const f = r.filters;
  if (!f.fromDay) return 'All time (no decisions yet)';
  const span = f.fromDay === f.toDay ? dayLabel(f.fromDay, { day: 'numeric', month: 'short', year: 'numeric' }) : `${dayLabel(f.fromDay, { day: 'numeric', month: 'short' })} – ${dayLabel(f.toDay, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${span} · India time`;
}

function Report({ data, loading }: { data: AnalyticsReport; loading: boolean }) {
  const t = data.totals;
  const scope = [data.filters.segment && segmentLabel(data.filters.segment), data.filters.offer, data.filters.origin !== 'all' && ORIGINS.find((o) => o.value === data.filters.origin)?.label].filter(Boolean).join(' · ');

  return (
    <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-ink-3">
        <Filter size={13} aria-hidden />
        <span>
          Decisions made <b className="font-medium text-ink-2">{windowText(data)}</b>
          {scope && (
            <>
              {' '}
              · <b className="font-medium text-ink-2">{scope}</b>
            </>
          )}
          . Later deliveries and taps count toward the day the decision was made.
        </span>
      </div>

      <Provenance data={data} />

      {data.empty ? (
        <Card>
          <EmptyState
            icon={<Sparkles size={18} aria-hidden />}
            title="No decisions match these filters"
            hint="Widen the time range or clear a filter. New results appear when a classmate sends /offer to the bot or you decide an offer from Customers."
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiTile
              label="Offers issued"
              value={count(t.issued)}
              accent="good"
              icon={<ShieldCheck size={16} aria-hidden />}
              hint={`${pct(data.rates.approval)} of ${count(t.decisions)} decisions · ${t.paths.ai + t.paths.aiRetry} by Claude, ${t.paths.fallback} by fallback`}
            />
            <KpiTile label="Delivered on Telegram" value={count(t.delivered)} accent="teal" icon={<Send size={16} aria-hidden />} hint={<RateHint r={data.rates.deliverySuccess} what="of send attempts succeeded" />} />
            <KpiTile label="Claims (observed)" value={count(t.claimed)} accent="violet" icon={<MousePointerClick size={16} aria-hidden />} hint={<RateHint r={data.rates.claim} what="of delivered offers · a tap, not a purchase" />} />
            <KpiTile
              label="Budget released"
              value={rupees(data.budget.cohort.releasedPaise)}
              accent="neutral"
              icon={<HandCoins size={16} aria-hidden />}
              hint={`of ${rupees(data.budget.cohort.reservedPaise)} reserved · ${rupees(data.budget.cohort.heldPaise)} still held`}
            />
            <KpiTile label="Withheld or stopped" value={count(t.noOffer + t.rejected + t.cancelled + t.errors)} accent="bad" icon={<Ban size={16} aria-hidden />} hint={`${t.noOffer} no offer · ${t.rejected} rejected · ${t.cancelled} cancelled · ${t.errors} errors`} />
          </div>

          <div className="grid gap-6 xl:grid-cols-5">
            <Card className="xl:col-span-2" title="From decision to claim" subtitle="Each step counts each decision once">
              <Funnel data={data} />
            </Card>
            <Card className="xl:col-span-3" title="Decisions per day" subtitle={`Outcome of each decision, by the day it was made${data.daily.truncated ? ' · showing the last 366 days' : ''}`}>
              <DailyChart
                points={data.daily.points}
                mode="stack"
                caption="Decision outcomes per day"
                emptyText="No decisions in this period."
                series={[
                  { key: 'issued', label: 'Offer issued', color: 'var(--color-good)', icon: <ShieldCheck size={13} aria-hidden /> },
                  { key: 'noOffer', label: 'No offer', color: 'var(--color-neutral-mark)', icon: <CircleSlash size={13} aria-hidden /> },
                  { key: 'blocked', label: 'Rejected or errored', color: 'var(--color-bad)', icon: <ShieldAlert size={13} aria-hidden /> },
                ]}
              />
              <p className="mt-3 text-[0.75rem] text-ink-3">“Offer issued” includes offers later cancelled before or during sending.</p>
            </Card>
          </div>

          <Card title="Delivered and claimed per day" subtitle="By the day the decision was made. Claims are a subset of deliveries, so the bars are side by side, not stacked.">
            <DailyChart
              points={data.daily.points}
              mode="group"
              caption="Delivered and claimed offers per day"
              emptyText="Nothing was delivered in this period."
              series={[
                { key: 'delivered', label: 'Delivered', color: 'var(--color-chart-1)', icon: <Send size={13} aria-hidden /> },
                { key: 'claimed', label: 'Claimed (observed)', color: 'var(--color-chart-2)', icon: <MousePointerClick size={13} aria-hidden /> },
              ]}
            />
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <DeliveryCard data={data} />
            <BudgetCard data={data} />
          </div>

          <OfferTable data={data} />
          <SegmentTable data={data} />
          <ReasonsCard data={data} />
        </>
      )}

      <Unsupported data={data} />
      <Definitions data={data} />
    </div>
  );
}

function RateHint({ r, what }: { r: Rate; what: string }) {
  if (r.value === null) return <>No attempts yet</>;
  return (
    <span>
      {pct(r)} {what} ({r.numerator}/{r.denominator})
      {r.smallSample && (
        <span className="ml-1.5 inline-block align-middle">
          <SmallSample />
        </span>
      )}
    </span>
  );
}

function SmallSample() {
  return (
    <Badge tone="warn" title="Fewer than 10 observations: too few to compare reliably">
      small sample
    </Badge>
  );
}

function RateCell({ r }: { r: Rate }) {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={`tabular-nums ${r.value === null ? 'text-ink-3' : 'text-ink'}`}>{pct(r)}</span>
      <span className="text-[0.7rem] text-ink-3 tabular-nums">{r.denominator ? `${r.numerator} of ${r.denominator}${r.smallSample ? ' · small' : ''}` : 'none yet'}</span>
    </span>
  );
}

// ---------------------------------------------------------------- provenance

function Provenance({ data }: { data: AnalyticsReport }) {
  const items: { icon: ReactNode; tone: 'neutral' | 'teal' | 'warn'; title: string; text: string }[] = [
    { icon: <Cpu size={14} aria-hidden />, tone: 'neutral', title: 'Generated', text: data.provenance.generated },
    { icon: <Eye size={14} aria-hidden />, tone: 'teal', title: 'Observed', text: data.provenance.observed },
    { icon: <Info size={14} aria-hidden />, tone: 'warn', title: 'Not simulated, not causal', text: `${data.provenance.simulated} No figure here shows that an offer caused a purchase.` },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {items.map((i) => (
        <div key={i.title} className="rounded-2xl border border-line bg-surface/70 p-4">
          <Badge tone={i.tone} icon={i.icon}>
            {i.title}
          </Badge>
          <p className="mt-2 text-[0.8rem] leading-relaxed text-ink-3">{i.text}</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- funnel

function Funnel({ data }: { data: AnalyticsReport }) {
  const t = data.totals;
  const steps = [
    { label: 'Decisions made', value: t.decisions, note: `${t.customers} customer${t.customers === 1 ? '' : 's'}`, kind: 'Generated' },
    { label: 'Offers issued', value: t.issued, note: 'passed validation, budget reserved', kind: 'Generated' },
    { label: 'Delivered on Telegram', value: t.delivered, note: `${t.customersReached} customer${t.customersReached === 1 ? '' : 's'} reached`, kind: 'Observed' },
    { label: 'Claimed', value: t.claimed, note: `${t.declined} declined · ${t.expiredUnanswered} expired unanswered`, kind: 'Observed' },
  ];
  const max = Math.max(1, t.decisions);
  return (
    <ol className="space-y-3.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        return (
          <li key={s.label}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-[0.82rem]">
              <span className="flex items-center gap-2 text-ink-2">
                {s.label}
                <span className="text-[0.68rem] tracking-wider text-ink-3 uppercase">{s.kind}</span>
              </span>
              <span className="tabular-nums text-ink">
                {count(s.value)}
                {prev !== null && <span className="ml-2 text-[0.75rem] text-ink-3">{prev ? `${Math.round((s.value / prev) * 100)}% of previous` : '—'}</span>}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent/80 transition-[width] duration-700" style={{ width: `${(s.value / max) * 100}%` }} />
            </div>
            <p className="mt-1 text-[0.72rem] text-ink-3">{s.note}</p>
          </li>
        );
      })}
      <li className="flex items-start gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3 py-2 text-[0.75rem] text-warn-ink">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span>The funnel stops at the claim. There is no purchase or redemption data, so no conversion to sales is shown.</span>
      </li>
    </ol>
  );
}

// ---------------------------------------------------------------- delivery and budget

function ReasonList({ rows, empty }: { rows: { key: string; count: number }[]; empty: string }) {
  if (!rows.length) return <p className="text-[0.8rem] text-ink-3">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-0.5 flex items-baseline justify-between gap-3 text-[0.8rem]">
            <span className="text-ink-2" title={r.key}>
              {label(r.key)}
            </span>
            <span className="tabular-nums text-ink">{r.count}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-ink-3/70" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label: l, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 px-3.5 py-3">
      <p className="text-[0.72rem] text-ink-3">{l}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[0.7rem] text-ink-3">{hint}</p>}
    </div>
  );
}

function DeliveryCard({ data }: { data: AnalyticsReport }) {
  const d = data.delivery;
  return (
    <Card title="Telegram delivery" subtitle="Observed · one delivery per issued offer; automatic retries stay inside it">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Success rate" value={pct(data.rates.deliverySuccess)} hint={`${d.sent} of ${d.attempted} attempted`} />
        <Stat label="Failed" value={count(d.failed)} hint="Telegram refused or errored" />
        <Stat label="Stopped by final check" value={count(d.precheckCancelled)} hint="never sent to Telegram" />
        <Stat label="Not sent" value={count(d.notSent + d.inFlight)} hint={d.inFlight ? `${d.inFlight} still sending` : 'decided without sending'} />
      </div>
      <div className="mt-4 rounded-xl border border-line px-3.5 py-3 text-[0.8rem] text-ink-2">
        <p className="flex items-center gap-1.5 font-medium text-ink">
          <RotateCcw size={13} aria-hidden /> Retry activity
        </p>
        <p className="mt-1">
          {d.retried === 0
            ? 'No send needed a retry.'
            : `${d.retried} send${d.retried === 1 ? '' : 's'} needed a retry (${d.extraAttempts} extra attempt${d.extraAttempts === 1 ? '' : 's'}); ${d.recoveredByRetry} then succeeded.`}{' '}
          <span className="text-ink-3">Only network errors and rate limits are retried, automatically. There is no manual retry yet.</span>
        </p>
      </div>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-[0.72rem] font-medium tracking-wider text-ink-3 uppercase">Failure reasons</p>
          <ReasonList rows={d.failureReasons.map((r) => ({ key: r.reason, count: r.count }))} empty="No failed sends." />
        </div>
        <div>
          <p className="mb-2 text-[0.72rem] font-medium tracking-wider text-ink-3 uppercase">Final-check stops</p>
          <ReasonList rows={d.precheckRules.map((r) => ({ key: r.rule, count: r.count }))} empty="No sends were stopped." />
        </div>
      </div>
    </Card>
  );
}

function BudgetCard({ data }: { data: AnalyticsReport }) {
  const c = data.budget.cohort;
  const now = data.budget.current;
  const releasedShare = c.reservedPaise ? (c.releasedPaise / c.reservedPaise) * 100 : 0;
  const heldShare = c.reservedPaise ? (c.heldPaise / c.reservedPaise) * 100 : 0;
  return (
    <Card title="Budget" subtitle="Worst-case reservations — the most each offer could cost, not money spent">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Reserved" value={rupees(c.reservedPaise)} hint="by offers issued" />
        <Stat label="Released" value={rupees(c.releasedPaise)} hint="declined, expired or cancelled" />
        <Stat label="Still held" value={rupees(c.heldPaise)} hint="issued or claimed, not expired" />
      </div>
      {c.reservedPaise > 0 && (
        <div className="mt-4">
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${Math.round(releasedShare)}% released, ${Math.round(heldShare)}% still held`}>
            <div className="h-full bg-neutral-mark" style={{ width: `${releasedShare}%` }} />
            <div className="h-full bg-accent/80" style={{ width: `${heldShare}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 text-[0.72rem] text-ink-3">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-neutral-mark" aria-hidden /> Released {Math.round(releasedShare)}%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-accent/80" aria-hidden /> Held {Math.round(heldShare)}%
            </span>
          </div>
        </div>
      )}
      <p className="mt-3 text-[0.75rem] text-ink-3">Redeemed: not tracked — there is no checkout, so no offer is ever marked as used.</p>
      <div className="mt-4 rounded-xl border border-line px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[0.8rem] font-medium text-ink">Remaining right now</p>
          <Badge>current state · not filtered by date or segment</Badge>
        </div>
        <p className="mt-1 text-xl font-semibold text-ink tabular-nums">{rupees(now.remainingPaise)}</p>
        <p className="text-[0.75rem] text-ink-3">
          of {rupees(now.totalPaise)} across {now.offers} live offer{now.offers === 1 ? '' : 's'}
          {data.filters.offer ? ` (${data.filters.offer})` : ''} · {rupees(now.reservedPaise)} reserved
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- comparison tables

type OfferRow = AnalyticsReport['byOffer'][number];
type OfferSort = 'issued' | 'delivered' | 'claimed' | 'claimRate' | 'reserved' | 'remaining';

function useSort<K extends string>(initial: K) {
  const [sort, setSort] = useState<{ key: K; dir: 'asc' | 'desc' }>({ key: initial, dir: 'desc' });
  const toggle = (key: K) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  return { sort, toggle };
}

/** Rates with no observations sort last in either direction. */
const rateKey = (r: Rate, dir: 'asc' | 'desc') => (r.value === null ? (dir === 'desc' ? -1 : 2) : r.value);

function OfferTable({ data }: { data: AnalyticsReport }) {
  const { sort, toggle } = useSort<OfferSort>('issued');
  const rows = useMemo(() => {
    const v = (o: OfferRow): number =>
      ({
        issued: o.issued,
        delivered: o.delivered,
        claimed: o.claimed,
        claimRate: rateKey(o.claimRate, sort.dir),
        reserved: o.cohortBudget.reservedPaise,
        remaining: o.currentBudget.remainingPaise,
      })[sort.key];
    return [...data.byOffer].sort((a, b) => (sort.dir === 'desc' ? v(b) - v(a) : v(a) - v(b)) || a.code.localeCompare(b.code));
  }, [data.byOffer, sort]);
  const head = (key: OfferSort, text: string) => (
    <th className={`${thClass} text-right`} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <SortHeader label={text} active={sort.key === key} direction={sort.dir} onClick={() => toggle(key)} align="right" />
    </th>
  );

  return (
    <Card title="Offer comparison" subtitle="Live offers and any offer issued in this period. Claim rate = claims ÷ deliveries." padded={false}>
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No offers to compare" hint="No offer was issued in this period and none is live." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-215 text-sm">
            <caption className="sr-only">Results per offer</caption>
            <thead className="border-y border-line bg-surface-2/50">
              <tr>
                <th className={thClass}>Offer</th>
                {head('issued', 'Issued')}
                {head('delivered', 'Delivered')}
                {head('claimed', 'Claimed')}
                {head('claimRate', 'Claim rate')}
                <th className={`${thClass} text-right`}>Declined · no reply</th>
                {head('reserved', 'Reserved')}
                <th className={`${thClass} text-right`}>Released</th>
                {head('remaining', 'Remaining now')}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((o) => (
                <tr key={o.code} className="hover:bg-surface-2/40">
                  <td className={tdClass}>
                    <p className="font-medium text-ink">{o.name}</p>
                    <p className="flex items-center gap-1.5 font-mono text-[0.72rem] text-ink-3">
                      {o.code}
                      <Badge tone={o.status === 'active' ? 'good' : o.status === 'expired' ? 'bad' : 'neutral'}>{o.status}</Badge>
                    </p>
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>
                    {o.issued}
                    {o.cancelled > 0 && <span className="block text-[0.7rem] text-ink-3">{o.cancelled} cancelled</span>}
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>
                    {o.delivered}
                    {o.deliveryFailed > 0 && <span className="block text-[0.7rem] text-bad-ink">{o.deliveryFailed} failed</span>}
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>{o.claimed}</td>
                  <td className={`${tdClass} text-right`}>
                    <RateCell r={o.claimRate} />
                  </td>
                  <td className={`${tdClass} text-right tabular-nums text-ink-2`}>
                    {o.declined} · {o.expiredUnanswered}
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>{rupees(o.cohortBudget.reservedPaise)}</td>
                  <td className={`${tdClass} text-right tabular-nums text-ink-2`}>{rupees(o.cohortBudget.releasedPaise)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>
                    {rupees(o.currentBudget.remainingPaise)}
                    <span className="block text-[0.7rem] text-ink-3">of {rupees(o.currentBudget.totalPaise)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type SegRow = AnalyticsReport['bySegment'][number];
type SegSort = 'decisions' | 'approvalRate' | 'delivered' | 'claimed' | 'claimRate' | 'reserved';

function SegmentTable({ data }: { data: AnalyticsReport }) {
  const { sort, toggle } = useSort<SegSort>('decisions');
  const rows = useMemo(() => {
    const v = (s: SegRow): number =>
      ({
        decisions: s.decisions,
        approvalRate: rateKey(s.approvalRate, sort.dir),
        delivered: s.delivered,
        claimed: s.claimed,
        claimRate: rateKey(s.claimRate, sort.dir),
        reserved: s.reservedPaise,
      })[sort.key];
    return [...data.bySegment].sort((a, b) => (sort.dir === 'desc' ? v(b) - v(a) : v(a) - v(b)) || a.segment.localeCompare(b.segment));
  }, [data.bySegment, sort]);
  const head = (key: SegSort, text: string) => (
    <th className={`${thClass} text-right`} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <SortHeader label={text} active={sort.key === key} direction={sort.dir} onClick={() => toggle(key)} align="right" />
    </th>
  );

  return (
    <Card title="Segment comparison" subtitle="Segment as it was when each decision was made. Differences describe what happened, not why." padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-190 text-sm">
          <caption className="sr-only">Results per customer segment</caption>
          <thead className="border-y border-line bg-surface-2/50">
            <tr>
              <th className={thClass}>Segment</th>
              {head('decisions', 'Decisions')}
              {head('approvalRate', 'Offer issued')}
              <th className={`${thClass} text-right`}>No offer · blocked</th>
              {head('delivered', 'Delivered')}
              {head('claimed', 'Claimed')}
              {head('claimRate', 'Claim rate')}
              {head('reserved', 'Reserved')}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((s) => (
              <tr key={s.segment} className="hover:bg-surface-2/40">
                <td className={`${tdClass} font-medium text-ink`}>{segmentLabel(s.segment)}</td>
                <td className={`${tdClass} text-right tabular-nums`}>{s.decisions}</td>
                <td className={`${tdClass} text-right`}>
                  <RateCell r={s.approvalRate} />
                </td>
                <td className={`${tdClass} text-right tabular-nums text-ink-2`}>
                  {s.noOffer} · {s.blocked}
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{s.delivered}</td>
                <td className={`${tdClass} text-right tabular-nums`}>{s.claimed}</td>
                <td className={`${tdClass} text-right`}>
                  <RateCell r={s.claimRate} />
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{rupees(s.reservedPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- reasons

function ReasonsCard({ data }: { data: AnalyticsReport }) {
  const r = data.reasons;
  const groups = [
    { title: 'Why no offer', hint: 'Outcome of decisions with no offer', rows: r.noOffer.map((x) => ({ key: x.reason, count: x.count })), empty: 'Every decision produced an offer.' },
    { title: 'Rules that excluded offers', hint: 'Decisions affected, counted once per rule', rows: r.exclusionRules.map((x) => ({ key: x.rule, count: x.count })), empty: 'No rule excluded an offer.' },
    { title: 'Validator rejections', hint: 'Rules broken by proposals that were rejected', rows: r.rejectionRules.map((x) => ({ key: x.rule, count: x.count })), empty: 'Nothing was rejected.' },
    {
      title: 'Cancellations and errors',
      hint: 'Approved offers stopped later, and failed decisions',
      rows: [...r.cancellations.map((x) => ({ key: x.reason, count: x.count })), ...r.errors.map((x) => ({ key: x.reason, count: x.count }))],
      empty: 'No cancellations or errors.',
    },
  ];
  return (
    <Card title="Why offers were withheld or stopped" subtitle="From the stored audit trail of each decision">
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="text-[0.82rem] font-medium text-ink">{g.title}</p>
            <p className="mb-3 text-[0.72rem] text-ink-3">{g.hint}</p>
            <ReasonList rows={g.rows} empty={g.empty} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- not measured + definitions

function Unsupported({ data }: { data: AnalyticsReport }) {
  return (
    <Card title="Not measured" subtitle="These need data the system does not collect. They are listed instead of being estimated.">
      <ul className="grid gap-3 md:grid-cols-2">
        {data.unsupported.map((u) => (
          <li key={u.metric} className="rounded-xl border border-line bg-surface-2/50 p-3.5">
            <p className="flex items-center gap-1.5 text-[0.85rem] font-medium text-ink">
              <AlertTriangle size={14} className="text-warn-ink" aria-hidden /> {u.metric}
            </p>
            <p className="mt-1 text-[0.8rem] text-ink-2">{u.reason}</p>
            <p className="mt-1 text-[0.75rem] text-ink-3">
              <span className="font-medium">Would need:</span> {u.needed}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Definitions({ data }: { data: AnalyticsReport }) {
  const defs: [string, string, string][] = [
    ['Period', 'Generated', `Decisions made between the start of the first day and the end of the last day, ${data.filters.timezone} time. Deliveries, taps and budget releases that came later are counted with their decision, so every filter applies to every figure.`],
    ['Decisions made', 'Generated', 'Offer evaluations for a customer. Dashboard previews and automated-test data are excluded. A repeated request with the same idempotency key is the same decision.'],
    ['Offers issued', 'Generated', 'Decisions that passed independent validation and reserved budget. Includes offers later cancelled. Approval rate = issued ÷ decisions made.'],
    ['Delivered on Telegram', 'Observed', 'Issued offers Telegram accepted. Each offer has one delivery record however many times sending is retried.'],
    ['Delivery success rate', 'Observed', 'Delivered ÷ (delivered + failed). Offers stopped by the final pre-send check never reached Telegram and are shown separately.'],
    ['Retry activity', 'Observed', 'Sends that needed more than one attempt, the extra attempts made, and how many then succeeded. Only network errors and rate limits are retried.'],
    ['Claims (observed)', 'Observed', 'Delivered offers where the classmate tapped “Claim”. Counted once per offer, even if the button was tapped again. A claim is interest, not a purchase.'],
    ['Claim rate', 'Observed', 'Claims ÷ deliveries. Shown as “—” when nothing was delivered. Rates from fewer than 10 deliveries are marked as a small sample.'],
    ['Declined · no reply', 'Observed', 'Delivered offers marked “Not interested”, and delivered offers that expired without either tap.'],
    ['Budget reserved / released / held', 'Generated', 'Each issued offer reserves its worst-case cost. Declined, expired and cancelled offers release it; the rest is still held. Not money spent.'],
    ['Remaining now', 'Current state', 'Total budget minus what is currently reserved or redeemed, for live offers. A snapshot — not affected by the date or segment filter.'],
    ['Segment', 'Generated', "The synthetic customer's segment when the decision was made (it can change later)."],
  ];
  return (
    <Card title="Metric definitions" subtitle="How each figure on this page is calculated">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg text-sm text-accent hover:text-accent-strong">
          <BookOpen size={15} aria-hidden /> <span className="group-open:hidden">Show definitions</span>
          <span className="hidden group-open:inline">Hide definitions</span>
        </summary>
        <dl className="mt-4 grid gap-x-8 gap-y-4 md:grid-cols-2">
          {defs.map(([term, kind, def]) => (
            <div key={term}>
              <dt className="flex items-center gap-2 text-[0.85rem] font-medium text-ink">
                {term} <Badge tone={kind === 'Observed' ? 'teal' : kind === 'Current state' ? 'warn' : 'neutral'}>{kind}</Badge>
              </dt>
              <dd className="mt-1 text-[0.8rem] leading-relaxed text-ink-3">{def}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
}
