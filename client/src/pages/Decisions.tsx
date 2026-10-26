import { CheckCircle2, CircleDot, Filter, Search, Send, ShieldCheck, Sparkles, Ticket, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, when, type DecisionSummary, type Paged } from '../api';
import { AI_OUTCOME, DecisionCard } from '../DecisionCard';
import { Drawer } from '../overlays';
import { Badge, Card, EmptyState, ErrorState, inputClass, PageHeader, Pagination, PathBadge, SegmentedControl, Skeleton, SortHeader, StatusBadge, tdClass, thClass, useAsync, useDebounced } from '../ui';

interface DecisionDetail {
  summary: DecisionSummary;
  detail: Record<string, any>;
  deliveries: { status: string; failureReason?: string | null; attempts: { n: number; outcome: string; errorKind?: string; at?: string }[]; createdAt: string }[];
  engagement: { type: string; occurredAt: string }[];
}

type Range = '7' | '30' | '90' | 'all';
const PAGE_SIZE = 20;

export function Decisions({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [path, setPath] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());

  const list = useAsync(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort });
    if (status) p.set('status', status);
    if (path) p.set('path', path);
    if (range !== 'all') p.set('days', range);
    if (search) p.set('q', search);
    return api.get<Paged<DecisionSummary>>(`/decisions?${p}`);
  }, [page, status, path, range, search, sort]);

  const reset = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };
  const filtered = Boolean(status || path || search || range !== 'all');

  return (
    <div>
      <PageHeader title="Decision log" description="Every decision with its full audit trail: what was eligible, what the AI proposed, every validation run and what was delivered." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4 sm:px-5">
          <label className="relative min-w-48 flex-1">
            <span className="sr-only">Search by customer</span>
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
            <input value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Customer, e.g. CUST-0005" className={`${inputClass} pl-9`} />
          </label>
          <label>
            <span className="sr-only">Outcome</span>
            <select value={status} onChange={(e) => reset(setStatus)(e.target.value)} className={`${inputClass} w-auto pr-8`}>
              <option value="">All outcomes</option>
              <option value="approved">Approved</option>
              <option value="no_offer">No offer</option>
              <option value="rejected">Blocked by validator</option>
              <option value="cancelled">Cancelled before send</option>
              <option value="error">Errors</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Decided by</span>
            <select value={path} onChange={(e) => reset(setPath)(e.target.value)} className={`${inputClass} w-auto pr-8`}>
              <option value="">Claude or fallback</option>
              <option value="ai">Claude</option>
              <option value="ai_retry">Claude (retry)</option>
              <option value="fallback">Rule-based fallback</option>
              <option value="none">No AI needed</option>
            </select>
          </label>
          <SegmentedControl
            label="Time range"
            value={range}
            onChange={reset(setRange)}
            options={[
              { value: '7', label: '7d' },
              { value: '30', label: '30d' },
              { value: '90', label: '90d' },
              { value: 'all', label: 'All' },
            ]}
          />
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
            <EmptyState
              icon={filtered ? <Filter size={18} aria-hidden /> : undefined}
              title={filtered ? 'No decisions match these filters' : 'No decisions yet'}
              hint={filtered ? 'Widen the time range or clear a filter.' : 'Decisions appear here when you decide from the Customers page or a classmate sends /offer to the bot.'}
            />
          </div>
        ) : (
          <>
            <div className={`overflow-x-auto transition-opacity ${list.loading ? 'opacity-60' : ''}`}>
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-line bg-surface-2/50">
                  <tr>
                    <th className={thClass} aria-sort={sort === 'newest' ? 'descending' : 'ascending'}>
                      <SortHeader label="When" active direction={sort === 'newest' ? 'desc' : 'asc'} onClick={() => reset(setSort)(sort === 'newest' ? 'oldest' : 'newest')} />
                    </th>
                    <th className={thClass}>Customer</th>
                    <th className={thClass}>Outcome</th>
                    <th className={thClass}>Decided by</th>
                    <th className={thClass}>Offer</th>
                    <th className={thClass}>Validation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => onOpen(d.id)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(d.id))}
                      tabIndex={0}
                      className="cursor-pointer transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
                    >
                      <td className={`${tdClass} whitespace-nowrap text-ink-3`}>{when(d.decidedAt)}</td>
                      <td className={`${tdClass} font-mono text-[0.8rem] text-ink-2`}>{d.customerRef}</td>
                      <td className={tdClass}>
                        <StatusBadge status={d.status} />
                      </td>
                      <td className={tdClass}>
                        <PathBadge path={d.path} />
                      </td>
                      <td className={`${tdClass} text-ink-2`}>{d.offer?.code ?? '—'}</td>
                      <td className={tdClass}>
                        {d.lastValidation ? (
                          d.lastValidation.ok ? (
                            <Badge tone="good" icon={<CheckCircle2 size={12} aria-hidden />}>passed</Badge>
                          ) : (
                            <Badge tone="bad" icon={<XCircle size={12} aria-hidden />}>{d.lastValidation.violations[0]?.rule}</Badge>
                          )
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Drawer open={Boolean(openId)} onClose={() => onOpen(null)} title="Decision audit" subtitle={openId ? <span className="font-mono">{openId}</span> : undefined}>
        {openId && <DecisionAudit id={openId} />}
      </Drawer>
    </div>
  );
}

function Step({ icon, title, tone = 'neutral', children }: { icon: ReactNode; title: string; tone?: 'neutral' | 'good' | 'bad' | 'ai'; children?: ReactNode }) {
  const color = { neutral: 'text-ink-3 bg-surface-3', good: 'text-good-ink bg-good-soft', bad: 'text-bad-ink bg-bad-soft', ai: 'text-ai bg-ai-soft' }[tone];
  return (
    <li className="relative pb-6 pl-10 last:pb-0">
      <span className="absolute top-8 bottom-0 left-[0.9rem] w-px bg-line [li:last-child>&]:hidden" aria-hidden />
      <span className={`absolute top-0 left-0 grid h-7 w-7 place-items-center rounded-lg ${color}`}>{icon}</span>
      <p className="pt-1 text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1.5 text-[0.82rem] text-ink-2">{children}</div>}
    </li>
  );
}

function DecisionAudit({ id }: { id: string }) {
  const { data, error } = useAsync(() => api.get<DecisionDetail>(`/decisions/${id}`), [id]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton rows={5} className="h-16" />;
  const d = data.detail;
  const attempts: any[] = d.ai?.attempts ?? [];
  const history: any[] = d.validationHistory ?? [];

  return (
    <div className="space-y-6">
      <p className="text-[0.8rem] text-ink-3">
        Customer <span className="font-mono text-ink-2">{data.summary.customerRef}</span> · rule set v{d.ruleSetVersion} · correlation <span className="font-mono">{d.correlationId}</span>
      </p>
      <Card>
        <DecisionCard d={data.summary} delivery={data.deliveries[0] ?? null} />
      </Card>

      <Card title="Timeline" subtitle="Each step, in order">
        <ol>
          <Step icon={<CircleDot size={14} aria-hidden />} title={`Eligibility: ${(d.candidates ?? []).length} of ${(d.candidates ?? []).length + (d.excluded ?? []).length} offers allowed`}>
            <p>Eligible: {(d.candidates ?? []).map((c: any) => c.code).join(', ') || 'none'}</p>
            {(d.excluded ?? []).length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-ink-3 hover:text-ink-2">Excluded ({d.excluded.length})</summary>
                <ul className="mt-1.5 space-y-1">
                  {d.excluded.map((e: any) => (
                    <li key={e.offerId}>
                      <span className="font-medium text-ink-2">{e.code}</span>: <span className="text-ink-3">{e.reasons.map((r: any) => r.rule).join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Step>
          {attempts.length === 0 ? (
            <Step icon={<Sparkles size={14} aria-hidden />} title="Claude not called" tone="neutral">
              {(d.candidates ?? []).length === 0 ? 'Nothing was eligible, so no AI call was needed.' : 'Claude is not configured; the rule-based choice was used.'}
            </Step>
          ) : (
            attempts.map((a) => (
              <Step key={a.n} icon={<Sparkles size={14} aria-hidden />} title={`Claude attempt ${a.n}: ${AI_OUTCOME[a.outcome] ?? a.outcome}`} tone={a.outcome === 'ok' || a.outcome === 'no_offer' ? 'ai' : 'bad'}>
                {d.ai?.model} · {(a.latencyMs / 1000).toFixed(1)} s{a.usage ? ` · ${a.usage.inputTokens} in / ${a.usage.outputTokens} out tokens` : ''}
              </Step>
            ))
          )}
          {history.map((v, i) => (
            <Step key={i} icon={v.ok ? <ShieldCheck size={14} aria-hidden /> : <XCircle size={14} aria-hidden />} title={`${v.source === 'presend' ? 'Final pre-send check' : v.source === 'reservation' ? 'Budget reservation' : `Validator (${v.source})`}: ${v.ok ? 'passed' : 'failed'}${v.offerCode ? ` · ${v.offerCode}` : ''}`} tone={v.ok ? 'good' : 'bad'}>
              {!v.ok && (
                <ul className="list-disc pl-4 text-bad-ink">
                  {v.violations.map((x: any, j: number) => (
                    <li key={j}>
                      {x.rule}: {x.message}
                    </li>
                  ))}
                </ul>
              )}
            </Step>
          ))}
          {d.grant?.code && (
            <Step icon={<Ticket size={14} aria-hidden />} title={`Grant ${d.grant.code} issued · now ${d.grant.status}`} tone="good">
              Expires {when(d.grant.expiresAt)}
            </Step>
          )}
          {data.deliveries.map((dl, i) => (
            <Step key={i} icon={<Send size={14} aria-hidden />} title={`Telegram delivery: ${dl.status.replace(/_/g, ' ')}`} tone={dl.status === 'sent' ? 'good' : 'bad'}>
              {dl.attempts?.length ?? 0} attempt(s){dl.failureReason ? ` · ${dl.failureReason}` : ''} · {when(dl.createdAt)}
            </Step>
          ))}
          {data.engagement
            .filter((e) => e.type !== 'delivered')
            .map((e, i) => (
              <Step key={i} icon={<CheckCircle2 size={14} aria-hidden />} title={`Customer ${e.type}`} tone={e.type === 'claimed' ? 'good' : 'neutral'}>
                {when(e.occurredAt)}
              </Step>
            ))}
        </ol>
      </Card>

      {d.proposal?.rationale && (
        <Card title="AI rationale" subtitle="Shown for transparency — the validator never uses it">
          <p className="rounded-xl bg-ai-soft px-4 py-3 text-sm leading-relaxed text-ink">{d.proposal.rationale}</p>
        </Card>
      )}

      <Card title="Context given to the AI" subtitle="Synthetic, permitted fields only — no name, city, age or persona">
        <pre className="overflow-x-auto rounded-xl bg-canvas p-4 font-mono text-[0.75rem] leading-relaxed text-ink-2">{JSON.stringify(d.contextSnapshot, null, 2)}</pre>
      </Card>
    </div>
  );
}
