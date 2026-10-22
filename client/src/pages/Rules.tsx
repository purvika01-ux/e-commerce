import { CheckCircle2, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, type RuleItem } from '../api';
import { Badge, Button, Card, ErrorState, SectionTitle, Skeleton, useAsync } from '../ui';

interface RulesResponse {
  version: number;
  rules: RuleItem[];
  history: { version: number; changeNote: string; createdAt: string; active: boolean }[];
}

/** Labels for parameters, with units, so a marketer never edits raw JSON. Money is shown in rupees. */
const PARAM_LABELS: Record<string, { label: string; unit?: 'rupees' | 'percent01' | 'list' | 'number' }> = {
  maxPercent: { label: 'Maximum discount (%)' },
  maxPaise: { label: 'Maximum value (₹)', unit: 'rupees' },
  minPaise: { label: 'Minimum basket (₹)', unit: 'rupees' },
  maxOffers: { label: 'Offers allowed' },
  windowDays: { label: 'Per this many days' },
  days: { label: 'Days after a purchase' },
  maxActiveGrants: { label: 'Unused offers a customer may hold' },
  stackableTypes: { label: 'Offer types that may be held alongside (comma-separated)', unit: 'list' },
  maxPurchaseProbability: { label: 'Purchase probability threshold (%)', unit: 'percent01' },
  appliesToTypes: { label: 'Applies to offer types (comma-separated)', unit: 'list' },
  maxReturnRate: { label: 'Maximum return rate (%)', unit: 'percent01' },
  segments: { label: 'Excluded segments (comma-separated)', unit: 'list' },
  minHoursRemaining: { label: 'Minimum hours left' },
  maxHeadline: { label: 'Max headline characters' },
  maxBody: { label: 'Max body characters' },
  bannedPhrases: { label: 'Banned phrases (comma-separated)', unit: 'list' },
};

function toDisplay(key: string, v: unknown): string {
  const unit = PARAM_LABELS[key]?.unit;
  if (unit === 'rupees') return String((v as number) / 100);
  if (unit === 'percent01') return String(Math.round((v as number) * 100));
  if (unit === 'list') return (v as string[]).join(', ');
  return String(v);
}

function fromDisplay(key: string, s: string): unknown {
  const unit = PARAM_LABELS[key]?.unit;
  if (unit === 'list') return s.split(',').map((x) => x.trim()).filter(Boolean);
  const n = Number(s);
  if (unit === 'rupees') return Math.round(n * 100);
  if (unit === 'percent01') return n / 100;
  return n;
}

export function Rules() {
  const { data, error, loading, reload } = useAsync(() => api.get<RulesResponse>('/rules'));
  const [draft, setDraft] = useState<Record<string, { enabled: boolean; fields: Record<string, string> }>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    if (!data) return;
    setDraft(Object.fromEntries(data.rules.map((r) => [r.key, { enabled: r.enabled, fields: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, toDisplay(k, v)])) }])));
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton rows={8} />;

  const dirty = data.rules.some((r) => {
    const d = draft[r.key];
    return d && (d.enabled !== r.enabled || Object.entries(r.params).some(([k, v]) => d.fields[k] !== toDisplay(k, v)));
  });

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const rules = data!.rules.map((r) => ({
        key: r.key,
        type: r.type,
        enabled: draft[r.key].enabled,
        params: Object.fromEntries(Object.keys(r.params).map((k) => [k, fromDisplay(k, draft[r.key].fields[k])])),
      }));
      const res = await api.put<{ version: number }>('/rules', { expectedVersion: data!.version, changeNote: note || 'Updated from dashboard', rules });
      setSaved(res.version);
      setNote('');
      await reload();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-3">
        <p className="text-sm text-ink-500">
          These limits apply to every offer. They are checked before the AI sees any offer, again on its answer, and once more just before a message is sent.
        </p>
        {data.rules.map((r) => {
          const d = draft[r.key];
          if (!d) return null;
          return (
            <Card key={r.key} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="max-w-xl">
                  <p className="font-medium">{r.description}</p>
                  <p className="mt-0.5 text-sm text-ink-500">{r.help}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={(e) => setDraft({ ...draft, [r.key]: { ...d, enabled: e.target.checked } })}
                    className="h-4 w-4 accent-brand-600"
                  />
                  Enabled
                </label>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {Object.keys(r.params).map((k) => (
                  <label key={k} className="text-sm">
                    <span className="mb-1 block text-ink-700">{PARAM_LABELS[k]?.label ?? k}</span>
                    <input
                      value={d.fields[k] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [r.key]: { ...d, fields: { ...d.fields, [k]: e.target.value } } })}
                      inputMode={PARAM_LABELS[k]?.unit === 'list' ? 'text' : 'decimal'}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                    />
                  </label>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
      <div className="space-y-4">
        <Card className="sticky top-4">
          <SectionTitle title={`Rule set v${data.version}`} subtitle="Saving creates a new version" />
          <label className="block text-sm">
            <span className="mb-1 block text-ink-700">What changed?</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Tighten discounts for Diwali" className="w-full rounded-lg border border-slate-300 px-3 py-1.5" />
          </label>
          <div className="mt-3">
            <Button icon={<Save size={16} />} busy={saving} disabled={!dirty} onClick={save}>
              Save new version
            </Button>
          </div>
          {saveError && (
            <div className="mt-3">
              <ErrorState error={saveError} />
              {Array.isArray(saveError.details) && (
                <ul className="mt-2 list-disc pl-5 text-xs text-rose-700">
                  {(saveError.details as { path: string; message: string }[]).map((x, i) => (
                    <li key={i}>
                      {x.path}: {x.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {saved && !dirty && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700">
              <CheckCircle2 size={16} /> Saved as version {saved}
            </p>
          )}
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-500">History</p>
          <ul className="mt-1 space-y-1 text-sm">
            {data.history.map((h) => (
              <li key={h.version} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  v{h.version} · {h.changeNote}
                </span>
                {h.active && <Badge tone="green">active</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
