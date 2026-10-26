import { AlertTriangle, Archive, CalendarClock, Gift, Pause, Pencil, Play, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, rupees, when, type OfferItem } from '../api';
import { ConfirmDialog, useToast } from '../overlays';
import { Badge, Button, Card, EmptyState, ErrorState, Meter, PageHeader, segmentLabel, SegmentedControl, Skeleton, type Tone, useAsync } from '../ui';
import { OfferForm } from './OfferForm';

type Filter = 'all' | 'active' | 'draft' | 'paused' | 'expired' | 'archived';
type StatusAction = 'activate' | 'pause' | 'archive';

const displayStatus = (o: OfferItem) => (o.isExpired && o.status !== 'archived' ? 'expired' : o.status);
const statusTone: Record<string, Tone> = { active: 'good', draft: 'neutral', paused: 'warn', expired: 'bad', archived: 'neutral' };

function eligibilityChips(o: OfferItem): string[] {
  const e = o.eligibility;
  const out: string[] = [];
  if (e.segments?.length) out.push(...e.segments.map(segmentLabel));
  if (e.minChurnRisk !== undefined) out.push(`Churn ≥ ${Math.round(e.minChurnRisk * 100)}%`);
  if (e.maxPurchaseProbability !== undefined) out.push(`Buy prob. ≤ ${Math.round(e.maxPurchaseProbability * 100)}%`);
  if (e.requiresOpenCart) out.push('Has an open cart');
  if (e.newCustomersOnly) out.push("Hasn't ordered yet");
  if (e.minRewardPoints !== undefined) out.push(`≥ ${e.minRewardPoints} points`);
  return out.length ? out : ['Anyone the global rules allow'];
}

export function Offers() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get<{ items: OfferItem[] }>('/offers'));
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<OfferItem | 'new' | null>(null);
  const [pending, setPending] = useState<{ offer: OfferItem; action: StatusAction } | null>(null);
  const [busy, setBusy] = useState(false);

  async function changeStatus() {
    if (!pending) return;
    setBusy(true);
    try {
      await api.post(`/offers/${pending.offer.id}/status`, { action: pending.action });
      toast({ tone: 'success', title: `${pending.offer.code} ${{ activate: 'activated', pause: 'paused', archive: 'archived' }[pending.action]}` });
      setPending(null);
      await reload();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      const rules = Array.isArray(err?.details) ? (err!.details as { message?: string }[]).map((d) => d.message).filter(Boolean).join(' · ') : '';
      toast({ tone: 'error', title: err?.message ?? 'Could not change the offer', description: rules || undefined });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items ?? [];
  const counts = items.reduce<Record<string, number>>((acc, o) => ((acc[displayStatus(o)] = (acc[displayStatus(o)] ?? 0) + 1), acc), {});
  const visible = filter === 'all' ? items.filter((o) => o.status !== 'archived') : items.filter((o) => displayStatus(o) === filter);
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: `All ${items.filter((o) => o.status !== 'archived').length || ''}`.trim() },
    { value: 'active', label: `Active ${counts.active ?? 0}` },
    { value: 'draft', label: `Draft ${counts.draft ?? 0}` },
    { value: 'paused', label: `Paused ${counts.paused ?? 0}` },
    { value: 'expired', label: `Expired ${counts.expired ?? 0}` },
    { value: 'archived', label: `Archived ${counts.archived ?? 0}` },
  ];

  const confirmCopy: Record<StatusAction, { title: string; body: string; label: string; tone: 'primary' | 'danger' }> = {
    activate: { title: 'Activate this offer?', body: 'It becomes available to the AI and the rule-based fallback immediately. Activation is refused if it breaks the current business rules.', label: 'Activate', tone: 'primary' },
    pause: { title: 'Pause this offer?', body: 'No new decisions will use it. Offers already sent stay valid; approved offers not yet sent are cancelled by the final check.', label: 'Pause offer', tone: 'primary' },
    archive: { title: 'Archive this offer?', body: 'Archived offers are retired permanently: they cannot be activated or edited again. Offers already sent stay valid until they expire.', label: 'Archive', tone: 'danger' },
  };

  return (
    <div>
      <PageHeader
        title="Offers"
        description="What customers can be offered. The AI can only choose among eligible offers and write wording — it can never change these terms."
        actions={
          <Button icon={<Plus size={16} aria-hidden />} onClick={() => setEditing('new')}>
            New offer
          </Button>
        }
      />
      <div className="mb-5 overflow-x-auto">
        <SegmentedControl label="Filter offers by status" options={filters} value={filter} onChange={setFilter} />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton rows={2} className="h-64" />
          <Skeleton rows={2} className="h-64" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Gift size={18} aria-hidden />}
          title={filter === 'all' ? 'No offers yet' : `No ${filter} offers`}
          hint={filter === 'all' ? 'Create your first offer. It starts as a draft until you activate it.' : 'Try another filter.'}
          action={filter === 'all' ? <Button icon={<Plus size={16} aria-hidden />} onClick={() => setEditing('new')}>New offer</Button> : undefined}
        />
      ) : (
        <div className={`grid gap-5 lg:grid-cols-2 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {visible.map((o) => {
            const status = displayStatus(o);
            const used = o.budget.reservedPaise + o.budget.redeemedPaise;
            return (
              <Card key={o.id} className="flex flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-ink">{o.name}</h2>
                    <p className="mt-0.5 font-mono text-[0.75rem] text-ink-3">
                      {o.code} · v{o.version} · priority {o.priority}
                    </p>
                  </div>
                  <Badge tone={statusTone[status]}>{status}</Badge>
                </div>
                {o.description && <p className="mt-2.5 text-sm text-ink-3">{o.description}</p>}
                <p className="mt-4 inline-flex w-fit items-center gap-2 rounded-xl bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent-strong ring-1 ring-accent/25">
                  <Gift size={14} aria-hidden /> {o.termsSummary}
                </p>

                <div className="mt-5 grid gap-5 text-sm sm:grid-cols-2">
                  <div>
                    <p className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">
                      <Users size={12} aria-hidden /> Who can get it
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {eligibilityChips(o).map((c) => (
                        <Badge key={c}>{c}</Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">
                      <CalendarClock size={12} aria-hidden /> Validity & budget
                    </p>
                    <p className="text-[0.8rem] text-ink-2">
                      {when(o.validFrom)} → {when(o.validTo)}
                    </p>
                    <div className="mt-2.5">
                      <Meter value={used} max={o.budget.totalPaise} label={`${o.code} budget used`} />
                      <p className="mt-1.5 text-[0.75rem] text-ink-3 tabular-nums">
                        {rupees(used)} of {rupees(o.budget.totalPaise)} · {o.usage.grantsIssued}/{o.usage.maxGrants} issued · ≈{rupees(o.estimatedCostPaise)} each
                      </p>
                    </div>
                  </div>
                </div>

                {o.ruleIssues.length > 0 && (
                  <div className="mt-5 rounded-xl border border-warn/30 bg-warn-soft p-3 text-sm text-warn-ink">
                    <p className="flex items-center gap-1.5 font-medium">
                      <AlertTriangle size={14} aria-hidden /> Breaks the current business rules
                    </p>
                    <ul className="mt-1 list-disc pl-5 text-[0.8rem]">
                      {o.ruleIssues.map((v, i) => (
                        <li key={i}>{v.message}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {o.status !== 'archived' && (
                  <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4 [&:not(:first-child)]:mt-5">
                    <Button variant="secondary" size="sm" icon={<Pencil size={14} aria-hidden />} onClick={() => setEditing(o)}>
                      Edit
                    </Button>
                    {o.status === 'active' && !o.isExpired && (
                      <Button variant="secondary" size="sm" icon={<Pause size={14} aria-hidden />} onClick={() => setPending({ offer: o, action: 'pause' })}>
                        Pause
                      </Button>
                    )}
                    {(o.status === 'paused' || o.status === 'draft') && !o.isExpired && (
                      <Button size="sm" icon={<Play size={14} aria-hidden />} onClick={() => setPending({ offer: o, action: 'activate' })} disabled={o.ruleIssues.length > 0} title={o.ruleIssues.length ? 'Fix the rule issues first' : undefined}>
                        Activate
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" icon={<Archive size={14} aria-hidden />} onClick={() => setPending({ offer: o, action: 'archive' })} className="ml-auto">
                      Archive
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <OfferForm
          key={editing === 'new' ? 'new' : `${editing.id}-${editing.version}`}
          open
          offer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(pending)}
        title={pending ? confirmCopy[pending.action].title : ''}
        body={
          pending && (
            <>
              <b className="text-ink">{pending.offer.name}</b> ({pending.offer.code}). {confirmCopy[pending.action].body}
            </>
          )
        }
        confirmLabel={pending ? confirmCopy[pending.action].label : ''}
        tone={pending ? confirmCopy[pending.action].tone : 'primary'}
        busy={busy}
        onConfirm={() => void changeStatus()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
