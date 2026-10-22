import { AlertTriangle, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, rupees, when, type OfferItem } from '../api';
import { Badge, Button, Card, EmptyState, ErrorState, Meter, Skeleton, segmentLabel, useAsync } from '../ui';

function eligibilityText(e: Record<string, any>): string[] {
  const out: string[] = [];
  if (e.segments?.length) out.push(`Segments: ${e.segments.map(segmentLabel).join(', ')}`);
  if (e.minChurnRisk !== undefined) out.push(`Churn risk ≥ ${Math.round(e.minChurnRisk * 100)}%`);
  if (e.maxPurchaseProbability !== undefined) out.push(`Purchase probability ≤ ${Math.round(e.maxPurchaseProbability * 100)}%`);
  if (e.requiresOpenCart) out.push('Has an open cart');
  if (e.newCustomersOnly) out.push('Has not ordered yet');
  if (e.minRewardPoints !== undefined) out.push(`≥ ${e.minRewardPoints} reward points`);
  return out.length ? out : ['Anyone the global rules allow'];
}

export function Offers() {
  const { data, error, loading, reload } = useAsync(() => api.get<{ items: OfferItem[] }>('/offers'));
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; error: ApiError } | null>(null);

  async function setStatus(o: OfferItem, action: 'activate' | 'pause') {
    setBusy(o.id);
    setActionError(null);
    try {
      await api.post(`/offers/${o.id}/status`, { action });
      await reload();
    } catch (e) {
      setActionError({ id: o.id, error: e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)) });
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton rows={6} />;
  if (!data?.items.length) return <EmptyState title="No offers" hint="Run `npm run seed` in server/ to load the default offers." />;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">
        Offer terms are defined here (seeded from <code className="rounded bg-slate-100 px-1">server/src/data/catalog.ts</code>). The AI can only choose among eligible offers and write wording — it can never change these terms.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.items.map((o) => {
          const status = o.isExpired ? 'expired' : o.status;
          const used = o.budget.reservedPaise + o.budget.redeemedPaise;
          return (
            <Card key={o.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{o.name}</h3>
                  <p className="font-mono text-xs text-ink-500">
                    {o.code} · v{o.version} · priority {o.priority}
                  </p>
                </div>
                <Badge tone={status === 'active' ? 'green' : status === 'expired' ? 'red' : 'slate'}>{status}</Badge>
              </div>
              <p className="mt-2 text-sm text-ink-700">{o.description}</p>
              <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700">{o.termsSummary}</p>
              <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Who can get it</p>
                  <ul className="mt-1 space-y-0.5">
                    {eligibilityText(o.eligibility).map((t) => (
                      <li key={t}>• {t}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Validity &amp; budget</p>
                  <p className="mt-1">
                    {when(o.validFrom)} → {when(o.validTo)}
                  </p>
                  <div className="mt-2">
                    <Meter value={used} max={o.budget.totalPaise} tone="amber" />
                    <p className="mt-1 text-xs text-ink-500">
                      {rupees(used)} of {rupees(o.budget.totalPaise)} · {o.usage.grantsIssued}/{o.usage.maxGrants} issued · ~{rupees(o.estimatedCostPaise)} per grant
                    </p>
                  </div>
                </div>
              </div>
              {o.ruleIssues.length > 0 && (
                <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle size={14} /> Blocked by current rules
                  </p>
                  <ul className="mt-1 list-disc pl-5">
                    {o.ruleIssues.map((v, i) => (
                      <li key={i}>{v.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {actionError?.id === o.id && (
                <div className="mt-3">
                  <ErrorState error={actionError.error} />
                </div>
              )}
              <div className="mt-4 flex gap-2">
                {o.status === 'active' && !o.isExpired && (
                  <Button variant="secondary" icon={<Pause size={14} />} busy={busy === o.id} onClick={() => setStatus(o, 'pause')}>
                    Pause
                  </Button>
                )}
                {(o.status === 'paused' || o.status === 'draft') && !o.isExpired && (
                  <Button icon={<Play size={14} />} busy={busy === o.id} onClick={() => setStatus(o, 'activate')}>
                    Activate
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
