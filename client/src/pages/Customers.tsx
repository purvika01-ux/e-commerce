import { CheckCircle2, Eye, Search, Send, ShoppingCart, UserRound, XCircle, Zap } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, pct, rupees, SEGMENTS, when, type CustomerDetail, type CustomerRow, type DecisionSummary, type Paged } from '../api';
import { DecisionCard, REASON } from '../DecisionCard';
import { ConfirmDialog, Drawer, useToast } from '../overlays';
import { Badge, Button, Card, EmptyState, ErrorState, inputClass, PageHeader, Pagination, PathBadge, segmentLabel, Skeleton, SortHeader, StatusBadge, tdClass, thClass, useAsync, useDebounced } from '../ui';

type SortKey = 'ref' | 'name' | 'churn' | 'buyProbability' | 'spend' | 'recency';
const PAGE_SIZE = 20;

export function Customers({ telegramEnabled, aiLive }: { telegramEnabled: boolean; aiLive: boolean }) {
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; order: 'asc' | 'desc' }>({ key: 'ref', order: 'asc' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const search = useDebounced(q.trim());

  const list = useAsync(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: sort.key, order: sort.order });
    if (segment) p.set('segment', segment);
    if (search) p.set('q', search);
    return api.get<Paged<CustomerRow>>(`/customers?${p}`);
  }, [page, segment, search, sort.key, sort.order]);

  const toggleSort = (key: SortKey, firstOrder: 'asc' | 'desc' = 'desc') => {
    setPage(1);
    setSort((s) => (s.key === key ? { key, order: s.order === 'asc' ? 'desc' : 'asc' } : { key, order: firstOrder }));
  };
  const header = (key: SortKey, label: string, firstOrder: 'asc' | 'desc' = 'desc', align: 'left' | 'right' = 'left') => (
    <th className={`${thClass} ${align === 'right' ? 'text-right' : ''}`} aria-sort={sort.key === key ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <SortHeader label={label} active={sort.key === key} direction={sort.order} onClick={() => toggleSort(key, firstOrder)} align={align} />
    </th>
  );

  return (
    <div>
      <PageHeader title="Customers" description="Synthetic shoppers with behaviour-derived features. Open one to see which offers the rules allow and to preview or decide an offer." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4 sm:px-5">
          <label className="relative min-w-56 flex-1">
            <span className="sr-only">Search customers</span>
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search by name or CUST-0001"
              className={`${inputClass} pl-9`}
            />
          </label>
          <label>
            <span className="sr-only">Segment</span>
            <select
              value={segment}
              onChange={(e) => {
                setSegment(e.target.value);
                setPage(1);
              }}
              className={`${inputClass} w-auto pr-8`}
            >
              <option value="">All segments</option>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {segmentLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {list.error ? (
          <div className="p-5">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <div className="p-5">
            <Skeleton rows={8} />
          </div>
        ) : list.data.items.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No customers match" hint="Clear the search or segment filter. If the list is empty everywhere, run npm run seed in server/." />
          </div>
        ) : (
          <>
            <div className={`overflow-x-auto transition-opacity ${list.loading ? 'opacity-60' : ''}`}>
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b border-line bg-surface-2/50">
                  <tr>
                    {header('name', 'Customer', 'asc')}
                    <th className={thClass}>Segment</th>
                    {header('churn', 'Churn risk', 'desc', 'right')}
                    {header('buyProbability', 'Buy prob. 7d', 'desc', 'right')}
                    {header('spend', '90-day spend', 'desc', 'right')}
                    {header('recency', 'Last order', 'asc', 'right')}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelected(c.id)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(c.id))}
                      tabIndex={0}
                      className="cursor-pointer transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
                    >
                      <td className={tdClass}>
                        <span className="flex items-center gap-2 font-medium text-ink">
                          {c.displayName}
                          {c.telegramLinked && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Linked to Telegram" aria-label="Linked to Telegram" />}
                        </span>
                        <span className="font-mono text-[0.75rem] text-ink-3">{c.externalRef}</span>
                      </td>
                      <td className={tdClass}>
                        <Badge tone="teal">{segmentLabel(c.segment)}</Badge>
                      </td>
                      <td className={`${tdClass} text-right tabular-nums text-ink-2`}>{pct(c.features.churnRisk)}</td>
                      <td className={`${tdClass} text-right tabular-nums text-ink-2`}>{pct(c.features.purchaseProbability7d)}</td>
                      <td className={`${tdClass} text-right tabular-nums text-ink-2`}>{rupees(c.features.monetary90dPaise)}</td>
                      <td className={`${tdClass} text-right tabular-nums text-ink-3`}>{c.features.recencyDays === null ? 'never' : `${c.features.recencyDays} d ago`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Customer" subtitle="Synthetic profile">
        {selected && <CustomerPanel key={selected} id={selected} telegramEnabled={telegramEnabled} aiLive={aiLive} />}
      </Drawer>
    </div>
  );
}

interface RecResponse {
  decision: DecisionSummary | null;
  delivery: { status: string; failureReason?: string | null } | null;
  replayed: boolean;
}

type Action = 'preview' | 'decide' | 'send';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5">
      <p className="text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">{label}</p>
      <p className="mt-0.5 text-[0.95rem] font-semibold text-ink tabular-nums">{value}</p>
    </div>
  );
}

function CustomerPanel({ id, telegramEnabled, aiLive }: { id: string; telegramEnabled: boolean; aiLive: boolean }) {
  const toast = useToast();
  const detail = useAsync(() => api.get<CustomerDetail>(`/customers/${id}`), [id]);
  const [result, setResult] = useState<RecResponse | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);

  async function run(kind: Action) {
    setBusy(kind);
    try {
      const body = { customerId: id, dryRun: kind === 'preview', channel: kind === 'send' ? 'telegram' : 'none' };
      const r = await api.post<RecResponse>('/recommendations', body, { 'Idempotency-Key': `ui-${crypto.randomUUID()}` });
      setResult(r);
      const s = r.decision?.status;
      if (kind === 'send') {
        if (r.delivery?.status === 'sent') toast({ tone: 'success', title: 'Offer delivered on Telegram', description: r.decision?.offer?.name });
        else if (s === 'approved' || s === 'cancelled') toast({ tone: 'error', title: 'Approved but not delivered', description: r.delivery?.failureReason ?? 'A final check or Telegram failed — nothing was sent.' });
        else toast({ tone: 'info', title: s === 'no_offer' ? 'No offer for this customer' : 'Offer blocked by the validator', description: r.decision?.outcomeReason ? REASON[r.decision.outcomeReason] : undefined });
      } else if (kind === 'decide') {
        toast(s === 'approved' ? { tone: 'success', title: 'Offer approved and reserved', description: `${r.decision?.offer?.name} · not sent` } : { tone: 'info', title: s === 'no_offer' ? 'No offer for this customer' : 'Offer blocked by the validator' });
      } else {
        toast({ tone: 'info', title: s === 'dry_run' ? 'Preview: this offer would be approved' : 'Preview: no offer would be approved', description: 'Nothing was reserved or sent.' });
      }
      if (kind !== 'preview') void detail.reload();
    } catch (e) {
      toast({ tone: 'error', title: 'Request failed', description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Skeleton rows={6} className="h-16" />;
  const { customer: c, eligibility, decisions, recentEvents, telegram } = detail.data;
  const f = c.features;
  const linked = telegram?.status === 'active';
  const sendBlockedReason = !telegramEnabled ? 'Telegram is not configured on the server' : !linked ? 'This customer is not linked to a Telegram chat' : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-accent/25 to-ai/25 text-ink">
            <UserRound size={22} aria-hidden />
          </span>
          <div>
            <p className="text-lg font-semibold text-ink">{c.displayName}</p>
            <p className="text-[0.8rem] text-ink-3">
              <span className="font-mono">{c.externalRef}</span> · {c.city}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="teal">{segmentLabel(c.segment)}</Badge>
          <Badge tone="neutral" title="Generator ground truth — never shown to the AI">
            Persona: {segmentLabel(c.persona)}
          </Badge>
          {linked ? <Badge tone="good">Telegram linked</Badge> : <Badge tone="neutral">Not on Telegram</Badge>}
          {c.optedOut && <Badge tone="bad">Opted out</Badge>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Last order" value={f.recencyDays === null ? 'never' : `${f.recencyDays} d ago`} />
        <Stat label="Orders · 90 d" value={f.frequency90d} />
        <Stat label="Avg order" value={rupees(f.aovPaise)} />
        <Stat label="Reward points" value={c.rewardPoints.balance} />
        <Stat label="Churn risk" value={pct(f.churnRisk)} />
        <Stat label="Buy prob. 7 d" value={pct(f.purchaseProbability7d)} />
        <Stat label="Discount sensitivity" value={pct(f.discountSensitivity)} />
        <Stat label="Return rate" value={pct(f.returnRate)} />
      </div>
      {f.openCart && (
        <p className="flex items-center gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-sm text-warn-ink">
          <ShoppingCart size={15} aria-hidden /> Open cart worth {rupees(f.openCart.valuePaise)} ({f.openCart.categories.join(', ')}), last updated {when(f.openCart.updatedAt)}
        </p>
      )}

      <Card title="Get an offer for this customer" subtitle={aiLive ? 'Claude picks and words the offer from the eligible ones; the validator checks it.' : 'Claude is off, so the deterministic rule-based choice is used — validated the same way.'}>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Eye size={16} aria-hidden />} busy={busy === 'preview'} disabled={Boolean(busy)} onClick={() => run('preview')}>
            Preview
          </Button>
          <Button variant="secondary" icon={<Zap size={16} aria-hidden />} busy={busy === 'decide'} disabled={Boolean(busy)} onClick={() => setConfirm('decide')}>
            Decide (don't send)
          </Button>
          <Button icon={<Send size={16} aria-hidden />} busy={busy === 'send'} disabled={Boolean(busy) || Boolean(sendBlockedReason)} title={sendBlockedReason} onClick={() => setConfirm('send')}>
            Decide &amp; send
          </Button>
        </div>
        <p className="mt-3 text-[0.78rem] text-ink-3">
          Preview reserves no budget and sends nothing.{sendBlockedReason ? ` Sending is unavailable: ${sendBlockedReason.toLowerCase()}.` : ''}
        </p>
        {result?.decision && (
          <div className="mt-5 border-t border-line pt-5">
            <DecisionCard d={result.decision} delivery={result.delivery} />
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Offer eligibility" subtitle="Deterministic rules decide what the AI may choose from">
          {eligibility.eligible.length === 0 ? (
            <p className="mb-3 text-sm text-ink-3">No offer is allowed for this customer right now.</p>
          ) : (
            <ul className="mb-4 space-y-2">
              {eligibility.eligible.map((o) => (
                <li key={o.id} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-good-ink" aria-label="Eligible" />
                  <span>
                    <span className="font-medium text-ink">{o.code}</span> <span className="text-ink-3">— {o.terms}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="group text-sm">
            <summary className="cursor-pointer text-ink-2 select-none hover:text-ink">Why other offers are excluded ({eligibility.excluded.length})</summary>
            <ul className="mt-3 space-y-2.5">
              {eligibility.excluded.map((e) => (
                <li key={e.offerId}>
                  <span className="flex items-center gap-1.5 font-medium text-ink-2">
                    <XCircle size={14} className="text-bad-ink" aria-hidden /> {e.code}
                  </span>
                  <ul className="mt-0.5 ml-5 list-disc text-[0.82rem] text-ink-3">
                    {e.reasons.map((r, i) => (
                      <li key={i}>{r.message}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        </Card>

        <Card title="Decision history">
          {decisions.length === 0 ? (
            <EmptyState title="No decisions for this customer yet" />
          ) : (
            <ul className="space-y-2.5">
              {decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={d.status} />
                  <PathBadge path={d.path} />
                  <span className="text-ink-2">{d.offer?.code ?? '—'}</span>
                  <span className="ml-auto text-[0.75rem] text-ink-3">{when(d.decidedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-6 mb-2 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">Recent activity</h3>
          <ul className="max-h-60 space-y-1.5 overflow-y-auto pr-1 text-sm">
            {recentEvents.map((e, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-ink-2">
                  {e.type.replace(/_/g, ' ')}
                  {e.payload?.totalPaise ? ` · ${rupees(e.payload.totalPaise)}` : ''}
                  {e.payload?.category ? ` · ${e.payload.category}` : ''}
                </span>
                <span className="shrink-0 text-[0.75rem] text-ink-3">{when(e.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm === 'decide'}
        title="Decide an offer now?"
        body={
          <>
            This runs the full decision for <b className="text-ink">{c.displayName}</b>. If an offer is approved, its budget is <b className="text-ink">reserved</b> and a grant is issued (it counts toward the customer's frequency cap), but <b className="text-ink">nothing is sent</b>.
          </>
        }
        confirmLabel="Decide offer"
        busy={busy === 'decide'}
        onConfirm={() => run('decide')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'send'}
        title="Send a real Telegram message?"
        body={
          <>
            If an offer is approved and passes the final pre-send check, a <b className="text-ink">real message is sent</b> to the Telegram chat linked to <b className="text-ink">{c.displayName}</b>, and its budget is reserved. This can't be undone.
          </>
        }
        confirmLabel="Decide & send"
        busy={busy === 'send'}
        onConfirm={() => run('send')}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
