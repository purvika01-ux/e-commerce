import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { api, when, type DecisionSummary } from '../api';
import { DecisionCard } from '../DecisionCard';
import { Badge, Card, EmptyState, ErrorState, Loading, PathBadge, Skeleton, StatusBadge, useAsync } from '../ui';

interface DecisionDetail {
  summary: DecisionSummary;
  detail: Record<string, any>;
  deliveries: { status: string; failureReason?: string | null; attempts: { n: number; outcome: string; errorKind?: string }[]; createdAt: string }[];
  engagement: { type: string; occurredAt: string }[];
}

export function Decisions({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [status, setStatus] = useState('');
  const list = useAsync(() => api.get<{ items: DecisionSummary[] }>(`/decisions?limit=100${status ? `&status=${status}` : ''}`), [status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-700" htmlFor="status-filter">
          Show
        </label>
        <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
          <option value="">All decisions</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled before send</option>
          <option value="no_offer">No offer</option>
          <option value="error">Errors</option>
        </select>
      </div>
      <Card className="overflow-x-auto p-0">
        {list.error ? (
          <div className="p-4">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : list.loading ? (
          <div className="p-4">
            <Skeleton rows={6} />
          </div>
        ) : !list.data?.items.length ? (
          <div className="p-4">
            <EmptyState title="No decisions yet" hint="Decisions appear here when you decide or send from the Customers page, or when a classmate uses /offer in Telegram." />
          </div>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Outcome</th>
                <th className="px-4 py-2.5">Decided by</th>
                <th className="px-4 py-2.5">Offer</th>
                <th className="px-4 py-2.5">Validation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.items.map((d) => (
                <tr key={d.id} onClick={() => onOpen(d.id)} className="cursor-pointer hover:bg-slate-50" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(d.id)}>
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-500">{when(d.decidedAt)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{d.customerRef}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    <PathBadge path={d.path} />
                  </td>
                  <td className="px-4 py-2.5">{d.offer?.code ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    {d.lastValidation ? (
                      d.lastValidation.ok ? <Badge tone="green">passed</Badge> : <Badge tone="red">{d.lastValidation.violations[0]?.rule}</Badge>
                    ) : (
                      <span className="text-ink-500">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <AnimatePresence>{openId && <DecisionDrawer id={openId} onClose={() => onOpen(null)} />}</AnimatePresence>
    </div>
  );
}

function DecisionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.get<DecisionDetail>(`/decisions/${id}`), [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-label="Decision details"
        className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl"
        initial={{ x: 40 }}
        animate={{ x: 0 }}
        exit={{ x: 40 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Decision audit</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading />
        ) : (
          <div className="space-y-6 text-sm">
            <p className="text-ink-500">
              Customer <span className="font-mono">{data.summary.customerRef}</span> · rule set v{data.detail.ruleSetVersion} · correlation <span className="font-mono">{data.detail.correlationId}</span>
            </p>
            <DecisionCard d={data.summary} delivery={data.deliveries[0] ?? null} />

            <section>
              <h3 className="mb-2 font-semibold">Validation history</h3>
              {(data.detail.validationHistory ?? []).length === 0 ? (
                <p className="text-ink-500">No validator runs (no eligible candidates).</p>
              ) : (
                <ol className="space-y-2">
                  {data.detail.validationHistory.map((v: any, i: number) => (
                    <li key={i} className="rounded-lg border border-slate-200 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={v.ok ? 'green' : 'red'}>{v.ok ? 'pass' : 'fail'}</Badge>
                        <span className="font-medium">{v.source}</span>
                        {v.offerCode && <span className="text-ink-500">{v.offerCode}</span>}
                        {v.attempt && <span className="text-ink-500">attempt {v.attempt}</span>}
                      </div>
                      {!v.ok && (
                        <ul className="mt-1 list-disc pl-5 text-rose-700">
                          {v.violations.map((x: any, j: number) => (
                            <li key={j}>
                              {x.rule}: {x.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {data.summary.aiAttempts.length > 0 && data.detail.proposal?.rationale && (
              <section>
                <h3 className="mb-1 font-semibold">AI rationale (display only — never used by the validator)</h3>
                <p className="rounded-lg bg-violet-50 p-3 text-violet-900">{data.detail.proposal.rationale}</p>
              </section>
            )}

            <section>
              <h3 className="mb-2 font-semibold">Candidates and exclusions</h3>
              <p className="mb-1">Eligible: {(data.detail.candidates ?? []).map((c: any) => c.code).join(', ') || 'none'}</p>
              <ul className="space-y-1 text-ink-700">
                {(data.detail.excluded ?? []).map((e: any) => (
                  <li key={e.offerId}>
                    <span className="font-medium">{e.code}</span>: {e.reasons.map((r: any) => r.rule).join(', ')}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 font-semibold">Delivery &amp; engagement</h3>
              {data.deliveries.length === 0 ? (
                <p className="text-ink-500">Not sent.</p>
              ) : (
                data.deliveries.map((dl, i) => (
                  <p key={i}>
                    Telegram: <span className="font-medium">{dl.status.replace(/_/g, ' ')}</span>
                    {dl.failureReason ? ` (${dl.failureReason})` : ''} · {dl.attempts?.length ?? 0} attempt(s) · {when(dl.createdAt)}
                  </p>
                ))
              )}
              {data.engagement.map((e, i) => (
                <p key={i} className="text-ink-700">
                  {e.type} · {when(e.occurredAt)}
                </p>
              ))}
            </section>

            <section>
              <h3 className="mb-2 font-semibold">Context given to the AI</h3>
              <pre className="overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(data.detail.contextSnapshot, null, 2)}</pre>
            </section>
          </div>
        )}
      </motion.aside>
    </motion.div>
  );
}
