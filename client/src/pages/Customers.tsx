import { Eye, Search, Send, ShoppingCart, UserRound, Zap } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, pct, rupees, when, type CustomerDetail, type CustomerRow, type DecisionSummary } from '../api';
import { DecisionCard } from '../DecisionCard';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PathBadge, SectionTitle, segmentLabel, Skeleton, StatusBadge, useAsync } from '../ui';

const SEGMENTS = ['', 'champion', 'loyal', 'promising', 'new', 'at_risk', 'hibernating', 'price_sensitive', 'window_shopper'];

interface RecResponse {
  decision: DecisionSummary | null;
  delivery: { status: string; failureReason?: string | null } | null;
  replayed: boolean;
}

export function Customers({ telegramEnabled }: { telegramEnabled: boolean }) {
  const [segment, setSegment] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAsync(
    () => api.get<{ items: CustomerRow[]; total: number }>(`/customers?pageSize=100${segment ? `&segment=${segment}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    [segment, q],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <Card className="h-fit p-4">
        <div className="space-y-2">
          <label className="relative block">
            <span className="sr-only">Search customers</span>
            <Search size={16} className="absolute top-2.5 left-3 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search CUST-0001 or name"
              className="w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="sr-only">Segment</span>
            <select value={segment} onChange={(e) => setSegment(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s ? segmentLabel(s) : 'All segments'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 max-h-[65vh] overflow-y-auto">
          {list.error ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.loading ? (
            <Skeleton rows={8} />
          ) : !list.data?.items.length ? (
            <EmptyState title="No customers found" hint="Run `npm run seed` in server/ or clear the filters." />
          ) : (
            <ul className="space-y-1">
              {list.data.items.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c.id)}
                    aria-current={selected === c.id}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${selected === c.id ? 'bg-brand-50 ring-1 ring-brand-100' : 'hover:bg-slate-50'}`}
                  >
                    <span>
                      <span className="block font-medium">{c.displayName}</span>
                      <span className="font-mono text-xs text-ink-500">{c.externalRef}</span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <Badge tone="brand">{segmentLabel(c.segment)}</Badge>
                      {c.telegramLinked && <span className="text-[11px] text-emerald-700">● Telegram</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {selected ? <CustomerPanel key={selected} id={selected} telegramEnabled={telegramEnabled} /> : (
        <Card>
          <EmptyState icon={<UserRound size={22} />} title="Select a synthetic customer" hint="See their behaviour, which offers the rules allow, and preview or send a personalised offer." />
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function CustomerPanel({ id, telegramEnabled }: { id: string; telegramEnabled: boolean }) {
  const detail = useAsync(() => api.get<CustomerDetail>(`/customers/${id}`), [id]);
  const [result, setResult] = useState<RecResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'decide' | 'send' | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  async function run(kind: 'preview' | 'decide' | 'send') {
    setBusy(kind);
    setActionError(null);
    try {
      const body = { customerId: id, dryRun: kind === 'preview', channel: kind === 'send' ? 'telegram' : 'none' };
      const r = await api.post<RecResponse>('/recommendations', body, { 'Idempotency-Key': `ui-${crypto.randomUUID()}` });
      setResult(r);
      if (kind !== 'preview') void detail.reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    } finally {
      setBusy(null);
    }
  }

  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (detail.loading || !detail.data) return <Card><Loading label="Loading customer…" /></Card>;
  const { customer: c, eligibility, decisions, recentEvents, telegram } = detail.data;
  const f = c.features;
  const linked = telegram?.status === 'active';

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{c.displayName}</h2>
            <p className="text-sm text-ink-500">
              <span className="font-mono">{c.externalRef}</span> · {c.city} · synthetic profile
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="brand">{segmentLabel(c.segment)}</Badge>
              <Badge tone="slate">Persona (ground truth): {segmentLabel(c.persona)}</Badge>
              {linked ? <Badge tone="green">Telegram linked</Badge> : <Badge tone="slate">Not on Telegram</Badge>}
              {c.optedOut && <Badge tone="red">Opted out</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Eye size={16} />} busy={busy === 'preview'} onClick={() => run('preview')}>
              Preview
            </Button>
            <Button variant="secondary" icon={<Zap size={16} />} busy={busy === 'decide'} onClick={() => run('decide')}>
              Decide (no send)
            </Button>
            <Button
              icon={<Send size={16} />}
              busy={busy === 'send'}
              disabled={!linked || !telegramEnabled}
              title={!telegramEnabled ? 'Telegram bot token not configured' : !linked ? 'This customer is not linked to a Telegram chat' : undefined}
              onClick={() => run('send')}
            >
              Decide &amp; send
            </Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Last order" value={f.recencyDays === null ? 'never' : `${f.recencyDays} days ago`} />
          <Stat label="Orders (90 days)" value={f.frequency90d} />
          <Stat label="Avg order" value={rupees(f.aovPaise)} />
          <Stat label="Reward points" value={c.rewardPoints.balance} />
          <Stat label="Churn risk" value={pct(f.churnRisk)} />
          <Stat label="Buy prob. (7 days)" value={pct(f.purchaseProbability7d)} />
          <Stat label="Discount sensitivity" value={pct(f.discountSensitivity)} />
          <Stat label="Return rate" value={pct(f.returnRate)} />
        </div>
        {f.openCart && (
          <p className="mt-3 flex items-center gap-2 text-sm text-ink-700">
            <ShoppingCart size={16} className="text-amber-600" /> Open cart worth {rupees(f.openCart.valuePaise)} ({f.openCart.categories.join(', ')}), last updated {when(f.openCart.updatedAt)}
          </p>
        )}
        <p className="mt-2 text-xs text-ink-500">Preview runs the full pipeline including validation but reserves no budget and sends nothing. The persona badge is generator ground truth and is never shown to the AI.</p>
      </Card>

      {(actionError || result) && (
        <Card>
          <SectionTitle title="Recommendation result" subtitle={result?.decision?.status === 'dry_run' ? 'Preview only — nothing reserved or sent' : undefined} />
          {actionError ? <ErrorState error={actionError} /> : result?.decision ? <DecisionCard d={result.decision} delivery={result.delivery} /> : null}
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <SectionTitle title="Offer eligibility" subtitle="Deterministic rules decide what the AI may choose from" />
          {eligibility.eligible.length === 0 ? (
            <p className="mb-3 text-sm text-ink-500">No offers are currently allowed for this customer.</p>
          ) : (
            <ul className="mb-3 space-y-1.5">
              {eligibility.eligible.map((o) => (
                <li key={o.id} className="flex items-start gap-2 text-sm">
                  <Badge tone="green">Eligible</Badge>
                  <span>
                    <span className="font-medium">{o.code}</span> — {o.terms}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-700">Why other offers are excluded ({eligibility.excluded.length})</summary>
            <ul className="mt-2 space-y-2">
              {eligibility.excluded.map((e) => (
                <li key={e.offerId}>
                  <span className="font-medium">{e.code}</span>
                  <ul className="ml-4 list-disc text-ink-500">
                    {e.reasons.map((r, i) => (
                      <li key={i}>{r.message}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        </Card>

        <Card>
          <SectionTitle title="Decision history" />
          {decisions.length === 0 ? (
            <EmptyState title="No decisions for this customer yet" />
          ) : (
            <ul className="space-y-2">
              {decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={d.status} />
                  <PathBadge path={d.path} />
                  <span className="text-ink-700">{d.offer?.code ?? '—'}</span>
                  <span className="ml-auto text-xs text-ink-500">{when(d.decidedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <SectionTitle title="Recent activity" />
          <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
            {recentEvents.map((e, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {e.type.replace(/_/g, ' ')}
                  {e.payload?.totalPaise ? ` · ${rupees(e.payload.totalPaise)}` : ''}
                  {e.payload?.category ? ` · ${e.payload.category}` : ''}
                </span>
                <span className="shrink-0 text-xs text-ink-500">{when(e.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
