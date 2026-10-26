import { Ban, ChevronRight, HandCoins, MousePointerClick, Send, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, rupees, when, type Overview as OverviewData } from '../api';
import { BarList, OutcomeChart } from '../charts';
import { Badge, Card, EmptyState, ErrorState, KpiTile, Meter, PageHeader, PathBadge, SegmentedControl, segmentLabel, Skeleton, StatusBadge, useAsync } from '../ui';

type Range = '7' | '30' | '90' | 'all';
const RANGES: { value: Range; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
];

export function Overview({ onOpenDecision }: { onOpenDecision: (id: string) => void }) {
  const [range, setRange] = useState<Range>('30');
  const { data, error, loading, reload } = useAsync(() => api.get<OverviewData>(`/overview${range === 'all' ? '' : `?days=${range}`}`), [range]);
  const rangeText = range === 'all' ? 'all time' : `the last ${range} days`;

  return (
    <div>
      <PageHeader
        title="Overview"
        description="How offers are being decided, checked and delivered. Every figure comes from stored decisions and events."
        actions={<SegmentedControl label="Time range" options={RANGES} value={range} onChange={setRange} />}
      />
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Skeleton rows={1} className="h-32" />
          <Skeleton rows={1} className="h-32" />
          <Skeleton rows={1} className="h-32" />
          <Skeleton rows={1} className="h-32" />
          <Skeleton rows={1} className="h-32" />
        </div>
      ) : (
        <OverviewBody data={data} rangeText={rangeText} loading={loading} onOpenDecision={onOpenDecision} />
      )}
    </div>
  );
}

function OverviewBody({ data, rangeText, loading, onOpenDecision }: { data: OverviewData; rangeText: string; loading: boolean; onOpenDecision: (id: string) => void }) {
  const d = data.decisions;
  const approved = d.approved ?? 0;
  const blocked = (d.rejected ?? 0) + (d.cancelled ?? 0) + (d.error ?? 0);
  const byClaude = (data.paths.ai ?? 0) + (data.paths.ai_retry ?? 0);
  const sent = data.deliveries.sent ?? 0;
  const notSent = (data.deliveries.failed_permanent ?? 0) + (data.deliveries.cancelled_precheck ?? 0) + (data.deliveries.failed_retryable ?? 0);
  const claimed = data.engagement.claimed ?? 0;
  const declined = data.engagement.declined ?? 0;
  const maxSeg = Math.max(...data.segments.map((s) => s.count), 1);

  return (
    <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiTile label="Offers approved" value={approved} accent="good" icon={<ShieldCheck size={16} aria-hidden />} hint={`${byClaude} by Claude · ${data.paths.fallback ?? 0} by rule-based fallback · ${rangeText}`} />
        <KpiTile label="Delivered on Telegram" value={sent} accent="teal" icon={<Send size={16} aria-hidden />} hint={notSent ? `${notSent} not sent (failed or cancelled by a final check)` : `None failed · ${rangeText}`} />
        <KpiTile label="Claims (observed)" value={claimed} accent="violet" icon={<MousePointerClick size={16} aria-hidden />} hint={`${declined} not interested. Button taps by classmates on synthetic profiles — not purchases.`} />
        <KpiTile
          label="Available budget"
          value={rupees(data.budget.availablePaise)}
          accent="neutral"
          icon={<HandCoins size={16} aria-hidden />}
          hint={`of ${rupees(data.budget.totalPaise)} across ${data.budget.liveOffers} live offer${data.budget.liveOffers === 1 ? '' : 's'} · right now`}
        />
        <KpiTile label="Blocked by guardrails" value={blocked} accent="bad" icon={<Ban size={16} aria-hidden />} hint={`Rejected, cancelled before send or errored — never delivered · ${rangeText}`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Decision outcomes" subtitle={`Per day, last ${data.daily.days} days (India time). No offer means no offer was allowed or needed.`}>
          <OutcomeChart points={data.daily.points} />
        </Card>
        <Card title="Customer segments" subtitle={`${data.customers} synthetic customers · derived from behaviour`}>
          <BarList items={data.segments.map((s) => ({ key: s.segment, label: segmentLabel(s.segment), value: s.count }))} />
          <p className="mt-4 text-[0.75rem] text-ink-3">
            {data.telegramLinked} linked to a Telegram chat · bar length relative to the largest segment ({maxSeg}).
          </p>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Recent decisions" subtitle="Newest first · open one for its full audit trail" padded={false}>
          {data.recentDecisions.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No decisions yet" hint="Open Customers, pick a shopper and preview or decide an offer — or ask a classmate to send /offer to the bot." />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.recentDecisions.map((dec) => (
                <li key={dec.id}>
                  <button onClick={() => onOpenDecision(dec.id)} className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3 text-left transition-colors hover:bg-surface-2 sm:px-6">
                    <span className="w-24 font-mono text-[0.78rem] text-ink-3">{dec.customerRef}</span>
                    <StatusBadge status={dec.status} />
                    <PathBadge path={dec.path} />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{dec.offer ? dec.offer.terms : '—'}</span>
                    <span className="text-[0.75rem] text-ink-3">{when(dec.decidedAt)}</span>
                    <ChevronRight size={15} className="text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-2" title="Offer budgets" subtitle="Committed = reserved for issued offers + redeemed">
          {data.offers.length === 0 ? (
            <EmptyState title="No offers" hint="Create one on the Offers page." />
          ) : (
            <ul className="space-y-4">
              {data.offers
                .filter((o) => o.status !== 'archived')
                .map((o) => {
                  const used = o.budget.reservedPaise + o.budget.redeemedPaise;
                  return (
                    <li key={o.code}>
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm text-ink-2">{o.name}</span>
                        <Badge tone={o.status === 'active' ? 'good' : o.status === 'expired' ? 'bad' : 'neutral'}>{o.status}</Badge>
                      </div>
                      <Meter value={used} max={o.budget.totalPaise} label={`${o.name} budget used`} />
                      <p className="mt-1 text-[0.75rem] text-ink-3 tabular-nums">
                        {rupees(used)} of {rupees(o.budget.totalPaise)} · {o.usage.grantsIssued}/{o.usage.maxGrants} issued
                      </p>
                    </li>
                  );
                })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
