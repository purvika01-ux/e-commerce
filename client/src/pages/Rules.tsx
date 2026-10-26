import { ArrowRight, History, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, SEGMENTS, when, type RuleItem } from '../api';
import { FormAlert, Modal, useToast } from '../overlays';
import { Badge, Button, Card, ErrorState, Field, inputClass, PageHeader, segmentLabel, Skeleton, Toggle, useAsync } from '../ui';

interface RulesResponse {
  version: number;
  rules: RuleItem[];
  history: { version: number; changeNote: string; createdAt: string; active: boolean }[];
}

const OFFER_TYPES = ['percent_off', 'flat_off', 'free_shipping', 'bonus_points'];
type Kind = 'int' | 'rupees' | 'percent01' | 'hours' | 'chips' | 'phrases';
interface ParamSpec {
  label: string;
  kind: Kind;
  min?: number;
  max?: number;
  options?: readonly string[];
  suffix?: string;
}

/** Plain-language labels, units and ranges per parameter (mirrors the server's rule catalogue). */
const PARAMS: Record<string, ParamSpec> = {
  maxPercent: { label: 'Maximum discount', kind: 'int', min: 1, max: 90, suffix: '%' },
  maxPaise: { label: 'Maximum value', kind: 'rupees', min: 1, max: 1_000_000, suffix: '₹' },
  minPaise: { label: 'Minimum basket', kind: 'rupees', min: 0, max: 1_000_000, suffix: '₹' },
  maxOffers: { label: 'Offers allowed', kind: 'int', min: 1, max: 20 },
  windowDays: { label: 'Per this many days', kind: 'int', min: 1, max: 90, suffix: 'days' },
  days: { label: 'Days after a purchase', kind: 'int', min: 0, max: 60, suffix: 'days' },
  maxActiveGrants: { label: 'Unused offers a customer may hold', kind: 'int', min: 1, max: 5 },
  stackableTypes: { label: 'Offer types that may be held alongside', kind: 'chips', options: OFFER_TYPES },
  maxPurchaseProbability: { label: 'Purchase probability threshold', kind: 'percent01', min: 0, max: 100, suffix: '%' },
  appliesToTypes: { label: 'Applies to offer types', kind: 'chips', options: OFFER_TYPES },
  maxReturnRate: { label: 'Maximum return rate', kind: 'percent01', min: 0, max: 100, suffix: '%' },
  segments: { label: 'Excluded segments', kind: 'chips', options: SEGMENTS },
  minHoursRemaining: { label: 'Minimum hours left', kind: 'hours', min: 0, max: 168, suffix: 'h' },
  maxHeadline: { label: 'Max headline characters', kind: 'int', min: 10, max: 120 },
  maxBody: { label: 'Max body characters', kind: 'int', min: 20, max: 600 },
  bannedPhrases: { label: 'Banned phrases (comma-separated)', kind: 'phrases' },
};

const GROUPS: { title: string; description: string; types: string[] }[] = [
  { title: 'Discount limits', description: 'The most any single offer may be worth.', types: ['MAX_DISCOUNT_PERCENT', 'MAX_DISCOUNT_AMOUNT', 'MIN_ORDER_FOR_DISCOUNT'] },
  { title: 'Contact and timing', description: 'How often customers hear from you, and when.', types: ['FREQUENCY_CAP', 'PURCHASE_COOLDOWN', 'NO_STACKING', 'OFFER_EXPIRY_BUFFER'] },
  { title: 'Who should not get discounts', description: 'Protect margin and avoid abuse.', types: ['LIKELY_BUYER_SUPPRESSION', 'RETURN_ABUSE_EXCLUSION', 'SEGMENT_EXCLUSION'] },
  { title: 'Message wording', description: 'Rules for the AI-written text. Prices, dates, codes and links are always forbidden in it.', types: ['COPY_POLICY'] },
];

type Draft = Record<string, { enabled: boolean; fields: Record<string, string | string[]> }>;

function toField(key: string, v: unknown): string | string[] {
  const kind = PARAMS[key]?.kind;
  if (kind === 'rupees') return String((v as number) / 100);
  if (kind === 'percent01') return String(Math.round((v as number) * 100));
  if (kind === 'chips') return [...(v as string[])];
  if (kind === 'phrases') return (v as string[]).join(', ');
  return String(v);
}

function fromField(key: string, v: string | string[]): unknown {
  const kind = PARAMS[key]?.kind;
  if (kind === 'chips') return v;
  if (kind === 'phrases') return (v as string).split(',').map((s) => s.trim()).filter(Boolean);
  const n = Number(v);
  if (kind === 'rupees') return Math.round(n * 100);
  if (kind === 'percent01') return n / 100;
  return n;
}

function fieldError(key: string, v: string | string[]): string | undefined {
  const spec = PARAMS[key];
  if (!spec || spec.kind === 'chips') return undefined;
  if (spec.kind === 'phrases') {
    const list = (v as string).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 50) return 'At most 50 phrases';
    if (list.some((p) => p.length > 60)) return 'Each phrase can be at most 60 characters';
    return undefined;
  }
  if ((v as string).trim() === '') return 'Required';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'Enter a number';
  if (spec.kind !== 'percent01' && spec.kind !== 'hours' && !Number.isInteger(n) && spec.kind !== 'rupees') return 'Whole numbers only';
  if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return `Between ${spec.min} and ${spec.max}`;
  return undefined;
}

/** Live plain-language sentence for a rule as currently edited (mirrors the server's descriptions). */
function sentence(type: string, f: Record<string, string | string[]>): string {
  const s = (k: string) => f[k] as string;
  switch (type) {
    case 'MAX_DISCOUNT_PERCENT': return `No offer may give more than ${s('maxPercent')}% off`;
    case 'MAX_DISCOUNT_AMOUNT': return `No single offer may be worth more than ₹${s('maxPaise')}`;
    case 'MIN_ORDER_FOR_DISCOUNT': return `Discounts need a minimum basket of ₹${s('minPaise')}`;
    case 'FREQUENCY_CAP': return `At most ${s('maxOffers')} offers per customer every ${s('windowDays')} days`;
    case 'PURCHASE_COOLDOWN': return `Don't send discounts within ${s('days')} days of a purchase`;
    case 'NO_STACKING': return `A customer can hold at most ${s('maxActiveGrants')} unused offer(s)`;
    case 'LIKELY_BUYER_SUPPRESSION': return `Don't give discounts to customers already ${s('maxPurchaseProbability')}%+ likely to buy`;
    case 'RETURN_ABUSE_EXCLUSION': return `Skip customers who return more than ${s('maxReturnRate')}% of orders`;
    case 'SEGMENT_EXCLUSION': return (f.segments as string[]).length ? `Never send offers to: ${(f.segments as string[]).map(segmentLabel).join(', ')}` : 'No excluded segments';
    case 'OFFER_EXPIRY_BUFFER': return `Don't send an offer that ends in under ${s('minHoursRemaining')} hours`;
    case 'COPY_POLICY': return `Headline ≤ ${s('maxHeadline')} chars, body ≤ ${s('maxBody')} chars, no banned phrases`;
    default: return type;
  }
}

export function Rules() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<RulesResponse>('/rules'));
  const [draft, setDraft] = useState<Draft>({});
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ title: string; items: string[] } | null>(null);

  const initial = useMemo<Draft>(
    () => Object.fromEntries((data?.rules ?? []).map((r) => [r.key, { enabled: r.enabled, fields: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, toField(k, v)])) }])),
    [data],
  );
  useEffect(() => setDraft(initial), [initial]);

  const changes = useMemo(
    () =>
      (data?.rules ?? []).flatMap((r) => {
        const d = draft[r.key];
        if (!d) return [];
        const before = initial[r.key];
        const paramsChanged = JSON.stringify(d.fields) !== JSON.stringify(before.fields);
        const toggled = d.enabled !== before.enabled;
        return paramsChanged || toggled ? [{ rule: r, from: sentence(r.type, before.fields), to: sentence(r.type, d.fields), toggled, enabled: d.enabled, paramsChanged }] : [];
      }),
    [data, draft, initial],
  );
  const invalid = useMemo(() => Object.values(draft).some((d) => Object.entries(d.fields).some(([k, v]) => fieldError(k, v))), [draft]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data || Object.keys(draft).length === 0) {
    return (
      <div>
        <PageHeader title="Business rules" />
        <Skeleton rows={4} className="h-40" />
      </div>
    );
  }

  const setField = (key: string, field: string, v: string | string[]) => setDraft((all) => ({ ...all, [key]: { ...all[key], fields: { ...all[key].fields, [field]: v } } }));
  const setEnabled = (key: string, v: boolean) => setDraft((all) => ({ ...all, [key]: { ...all[key], enabled: v } }));

  async function save() {
    setSaving(true);
    setServerError(null);
    try {
      const rules = data!.rules.map((r) => ({
        key: r.key,
        type: r.type,
        enabled: draft[r.key].enabled,
        params: Object.fromEntries(Object.keys(r.params).map((k) => [k, fromField(k, draft[r.key].fields[k])])),
      }));
      const res = await api.put<{ version: number }>('/rules', { expectedVersion: data!.version, changeNote: note.trim(), rules });
      toast({ tone: 'success', title: `Rules saved as version ${res.version}`, description: 'They apply to the next decision and to every pre-send check from now on.' });
      setReviewing(false);
      setNote('');
      await reload();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      const items = Array.isArray(err?.details) ? (err!.details as { path?: string; message?: string }[]).map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`) : [];
      setServerError({ title: err?.status === 409 ? 'Someone else changed the rules. Reload to see their version, then re-apply your changes.' : (err?.message ?? 'Could not save'), items });
    } finally {
      setSaving(false);
    }
  }

  const byType = Object.fromEntries(data.rules.map((r) => [r.type, r]));

  return (
    <div className="pb-24">
      <PageHeader
        title="Business rules"
        description="Limits every offer must respect. They're checked before the AI sees any offer, again on its answer, and once more just before a message is sent."
        actions={<Badge tone="teal" icon={<ShieldCheck size={12} aria-hidden />}>Active: version {data.version}</Badge>}
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="space-y-8">
          {GROUPS.map((g) => (
            <section key={g.title} aria-labelledby={`group-${g.title}`}>
              <h2 id={`group-${g.title}`} className="text-[0.95rem] font-semibold text-ink">
                {g.title}
              </h2>
              <p className="mb-3 text-[0.8rem] text-ink-3">{g.description}</p>
              <div className="space-y-3">
                {g.types
                  .map((t) => byType[t])
                  .filter(Boolean)
                  .map((r) => {
                    const d = draft[r.key];
                    const changed = changes.some((c) => c.rule.key === r.key);
                    return (
                      <Card key={r.key} className={`p-5! ${changed ? 'ring-1 ring-accent/40' : ''} ${d.enabled ? '' : 'opacity-75'}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 max-w-xl">
                            <p className="font-medium text-ink">{sentence(r.type, d.fields)}</p>
                            <p className="mt-0.5 text-[0.8rem] text-ink-3">{r.help}</p>
                          </div>
                          <div className="flex items-center gap-2.5">
                            {changed && <Badge tone="teal">Changed</Badge>}
                            {!d.enabled && <Badge tone="warn">Off</Badge>}
                            <Toggle checked={d.enabled} onChange={(v) => setEnabled(r.key, v)} label={`${d.enabled ? 'Disable' : 'Enable'}: ${sentence(r.type, d.fields)}`} />
                          </div>
                        </div>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                          {Object.keys(r.params).map((k) => {
                            const spec = PARAMS[k] ?? { label: k, kind: 'int' as Kind };
                            const v = d.fields[k];
                            const err = fieldError(k, v);
                            const id = `rule-${r.key}-${k}`;
                            if (spec.kind === 'chips') {
                              const values = v as string[];
                              return (
                                <div key={k} className={k === 'segments' ? 'sm:col-span-2' : ''}>
                                  <p className="mb-1.5 text-sm font-medium text-ink-2">{spec.label}</p>
                                  <div role="group" aria-label={spec.label} className="flex flex-wrap gap-1.5">
                                    {spec.options!.map((o) => {
                                      const on = values.includes(o);
                                      return (
                                        <button
                                          key={o}
                                          type="button"
                                          aria-pressed={on}
                                          onClick={() => setField(r.key, k, on ? values.filter((x) => x !== o) : [...values, o])}
                                          className={`rounded-full px-2.5 py-1 text-[0.78rem] ring-1 ring-inset transition-colors ${on ? 'bg-accent-soft text-accent-strong ring-accent/40' : 'bg-surface-3/60 text-ink-3 ring-line-strong hover:text-ink-2'}`}
                                        >
                                          {segmentLabel(o)}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div key={k} className={spec.kind === 'phrases' ? 'sm:col-span-2' : ''}>
                                <Field label={spec.label} htmlFor={id} error={err}>
                                  <div className="relative">
                                    {spec.suffix === '₹' && <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-3">₹</span>}
                                    <input
                                      id={id}
                                      value={v as string}
                                      onChange={(e) => setField(r.key, k, e.target.value)}
                                      inputMode={spec.kind === 'phrases' ? 'text' : 'decimal'}
                                      aria-invalid={Boolean(err) || undefined}
                                      className={`${inputClass} ${spec.suffix === '₹' ? 'pl-7' : ''} ${spec.suffix && spec.suffix !== '₹' ? 'pr-12' : ''}`}
                                    />
                                    {spec.suffix && spec.suffix !== '₹' && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[0.8rem] text-ink-3">{spec.suffix}</span>}
                                  </div>
                                </Field>
                              </div>
                            );
                          })}
                        </div>
                      </Card>
                    );
                  })}
              </div>
            </section>
          ))}
        </div>

        <aside className="xl:sticky xl:top-8 xl:self-start">
          <Card title={<span className="flex items-center gap-1.5"><History size={15} aria-hidden /> Version history</span>} subtitle="Every save creates a new version">
            <ol className="space-y-3">
              {data.history.map((h) => (
                <li key={h.version} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">v{h.version}</span>
                    {h.active && <Badge tone="good">active</Badge>}
                  </div>
                  <p className="text-[0.8rem] text-ink-2">{h.changeNote || '—'}</p>
                  <p className="text-[0.72rem] text-ink-3">{when(h.createdAt)}</p>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>

      {/* Sticky save bar */}
      <AnimatePresence>
        {changes.length > 0 && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4 sm:px-6">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-surface-2/95 px-4 py-3 shadow-[var(--shadow-pop)] backdrop-blur">
              <p className="text-sm text-ink-2">
                <b className="text-ink">{changes.length}</b> unsaved change{changes.length === 1 ? '' : 's'}
                {invalid && <span className="ml-2 text-bad-ink">· fix the highlighted values</span>}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setDraft(initial)}>
                  Discard
                </Button>
                <Button size="sm" icon={<Save size={14} aria-hidden />} disabled={invalid} onClick={() => (setServerError(null), setReviewing(true))}>
                  Review &amp; save
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={reviewing}
        onClose={saving ? () => undefined : () => setReviewing(false)}
        title={`Save as version ${data.version + 1}?`}
        description="The new rules apply to the next decision and to every pre-send check, including offers already approved but not yet sent."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviewing(false)} disabled={saving}>
              Back to editing
            </Button>
            <Button onClick={() => void save()} busy={saving} disabled={!note.trim()}>
              Save version {data.version + 1}
            </Button>
          </>
        }
      >
        {serverError && <FormAlert title={serverError.title} items={serverError.items} />}
        <ul className="mb-5 space-y-3">
          {changes.map((c) => (
            <li key={c.rule.key} className="rounded-xl border border-line bg-surface-2/60 p-3.5 text-sm">
              {c.toggled && <p className="mb-1.5 font-medium text-ink">{c.enabled ? 'Turned on' : 'Turned off'}</p>}
              {c.paramsChanged && (
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                  <span className="text-ink-3 line-through decoration-ink-3/60">{c.from}</span>
                  <ArrowRight size={14} className="shrink-0 text-accent" aria-hidden />
                  <span className="text-ink">{c.to}</span>
                </div>
              )}
              {!c.paramsChanged && <p className="text-ink-2">{c.to}</p>}
            </li>
          ))}
        </ul>
        <Field label="What changed and why?" htmlFor="rules-note" hint="Required · shown in the version history" error={note.length > 200 ? 'At most 200 characters' : undefined}>
          <input id="rules-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Tighten discounts for Diwali week" className={inputClass} data-autofocus />
        </Field>
      </Modal>
    </div>
  );
}
