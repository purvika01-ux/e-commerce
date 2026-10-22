import { Activity, Ban, Send, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, rupees, type Overview as OverviewData } from '../api';
import { Badge, Card, EmptyState, ErrorState, Meter, PathBadge, SectionTitle, segmentLabel, Skeleton, StatusBadge, useAsync } from '../ui';

function Kpi({ label, value, hint, icon }: { label: string; value: number | string; hint?: string; icon: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">{label}</p>
        <span className="text-brand-600">{icon}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </Card>
  );
}

export function Overview({ onOpenDecision }: { onOpenDecision: (id: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api.get<OverviewData>('/overview'));
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton rows={6} />;

  const approved = data.decisions.approved ?? 0;
  const blocked = (data.decisions.rejected ?? 0) + (data.decisions.cancelled ?? 0);
  const maxSeg = Math.max(...data.segments.map((s) => s.count), 1);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Synthetic customers" value={data.customers} hint={`${data.telegramLinked} linked to Telegram`} icon={<Users size={18} />} />
        <Kpi label="Offers approved" value={approved} hint={`${(data.paths.ai ?? 0) + (data.paths.ai_retry ?? 0)} by Claude · ${data.paths.fallback ?? 0} by fallback`} icon={<ShieldCheck size={18} />} />
        <Kpi label="Delivered on Telegram" value={data.deliveries.sent ?? 0} hint={`${(data.deliveries.failed_permanent ?? 0) + (data.deliveries.cancelled_precheck ?? 0)} not sent`} icon={<Send size={18} />} />
        <Kpi label="Claimed" value={data.engagement.claimed ?? 0} hint={`${data.engagement.declined ?? 0} not interested`} icon={<Activity size={18} />} />
        <Kpi label="Blocked by guardrails" value={blocked} hint="Rejected or cancelled before send" icon={<Ban size={18} />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="Recent decisions" subtitle="Every decision is validated independently before anything is sent." />
          {data.recentDecisions.length === 0 ? (
            <EmptyState title="No decisions yet" hint="Open Customers, pick someone and preview or send a recommendation." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentDecisions.map((d) => (
                <li key={d.id}>
                  <button onClick={() => onOpenDecision(d.id)} className="flex w-full flex-wrap items-center gap-2 py-2.5 text-left hover:bg-slate-50">
                    <span className="w-24 font-mono text-xs text-ink-500">{d.customerRef}</span>
                    <StatusBadge status={d.status} />
                    <PathBadge path={d.path} />
                    <span className="flex-1 truncate text-sm">{d.offer ? d.offer.terms : '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle title="Customer segments" subtitle="Derived from synthetic behaviour" />
          <ul className="space-y-2.5">
            {data.segments.map((s) => (
              <li key={s.segment} className="text-sm">
                <div className="mb-1 flex justify-between">
                  <span>{segmentLabel(s.segment)}</span>
                  <span className="tabular-nums text-ink-500">{s.count}</span>
                </div>
                <Meter value={s.count} max={maxSeg} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <SectionTitle title="Offer budgets" subtitle="Reserved budget is worst-case liability for issued offers" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.offers.map((o) => (
            <div key={o.code} className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{o.name}</span>
                <Badge tone={o.status === 'active' ? 'green' : o.status === 'expired' ? 'red' : 'slate'}>{o.status}</Badge>
              </div>
              <Meter value={o.budget.reservedPaise + o.budget.redeemedPaise} max={o.budget.totalPaise} tone="amber" />
              <p className="mt-1.5 text-xs text-ink-500">
                {rupees(o.budget.reservedPaise + o.budget.redeemedPaise)} of {rupees(o.budget.totalPaise)} · {o.usage.grantsIssued}/{o.usage.maxGrants} issued
              </p>
            </div>
          ))}
        </div>
      </Card>
      <p className="text-xs text-ink-500">{data.dataNotice}</p>
    </div>
  );
}
