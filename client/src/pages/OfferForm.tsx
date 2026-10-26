import { Info } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, CATEGORIES, fieldErrors, SEGMENTS, type OfferItem, type OfferType } from '../api';
import { ConfirmDialog, FormAlert, Modal, useToast } from '../overlays';
import { Button, Field, inputClass, segmentLabel, Toggle } from '../ui';

const TYPES: { value: OfferType; label: string; help: string }[] = [
  { value: 'percent_off', label: 'Percentage off', help: 'e.g. 15% off, capped at a rupee amount' },
  { value: 'flat_off', label: 'Flat amount off', help: 'e.g. ₹100 off' },
  { value: 'free_shipping', label: 'Free shipping', help: 'Shipping cost absorbed' },
  { value: 'bonus_points', label: 'Bonus reward points', help: 'No discount, so no lost margin' },
];

interface FormState {
  code: string;
  name: string;
  description: string;
  type: OfferType;
  percentOff: string;
  maxDiscountRupees: string;
  flatOffRupees: string;
  bonusPoints: string;
  minOrderRupees: string;
  categories: string[];
  segments: string[];
  minChurnPct: string;
  maxBuyPct: string;
  requiresOpenCart: boolean;
  newCustomersOnly: boolean;
  minRewardPoints: string;
  validFrom: string;
  validTo: string;
  grantValidityHours: string;
  priority: string;
  stackable: boolean;
  budgetRupees: string;
  maxGrants: string;
  maxGrantsPerCustomer: string;
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const str = (v: number | undefined | null, scale = 1) => (v === undefined || v === null ? '' : String(v / scale));

function fromOffer(o: OfferItem | null): FormState {
  const now = new Date();
  if (!o) {
    return {
      code: '', name: '', description: '', type: 'percent_off', percentOff: '10', maxDiscountRupees: '250', flatOffRupees: '', bonusPoints: '', minOrderRupees: '499',
      categories: [], segments: [], minChurnPct: '', maxBuyPct: '', requiresOpenCart: false, newCustomersOnly: false, minRewardPoints: '',
      validFrom: localInput(now), validTo: localInput(new Date(now.getTime() + 30 * 86_400_000)), grantValidityHours: '72', priority: '50', stackable: false,
      budgetRupees: '10000', maxGrants: '100', maxGrantsPerCustomer: '1',
    };
  }
  const e = o.eligibility;
  return {
    code: o.code, name: o.name, description: o.description, type: o.type,
    percentOff: str(o.terms.percentOff), maxDiscountRupees: str(o.terms.maxDiscountPaise, 100), flatOffRupees: str(o.terms.flatOffPaise, 100), bonusPoints: str(o.terms.bonusPoints),
    minOrderRupees: str(o.terms.minOrderPaise, 100), categories: o.terms.categories ?? [],
    segments: e.segments ?? [], minChurnPct: e.minChurnRisk === undefined ? '' : String(Math.round(e.minChurnRisk * 100)), maxBuyPct: e.maxPurchaseProbability === undefined ? '' : String(Math.round(e.maxPurchaseProbability * 100)),
    requiresOpenCart: Boolean(e.requiresOpenCart), newCustomersOnly: Boolean(e.newCustomersOnly), minRewardPoints: str(e.minRewardPoints),
    validFrom: localInput(new Date(o.validFrom)), validTo: localInput(new Date(o.validTo)), grantValidityHours: String(o.grantValidityHours), priority: String(o.priority), stackable: o.stackable,
    budgetRupees: str(o.budget.totalPaise, 100), maxGrants: String(o.usage.maxGrants), maxGrantsPerCustomer: String(o.usage.maxGrantsPerCustomer),
  };
}

/** Server error paths → form field keys, so server validation shows next to the right input. */
const SERVER_FIELD: Record<string, keyof FormState> = {
  'terms.percentOff': 'percentOff', 'terms.maxDiscountPaise': 'maxDiscountRupees', 'terms.flatOffPaise': 'flatOffRupees', 'terms.bonusPoints': 'bonusPoints',
  'terms.minOrderPaise': 'minOrderRupees', budgetTotalPaise: 'budgetRupees', 'eligibility.minChurnRisk': 'minChurnPct', 'eligibility.maxPurchaseProbability': 'maxBuyPct',
};

type Errors = Partial<Record<keyof FormState, string>>;
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

function validate(f: FormState, creating: boolean): Errors {
  const e: Errors = {};
  const intIn = (k: keyof FormState, min: number, max: number, label: string, required = true) => {
    const v = num(f[k] as string);
    if (v === undefined) {
      if (required) e[k] = `${label} is required`;
    } else if (!Number.isFinite(v) || v < min || v > max) e[k] = `${label} must be between ${min} and ${max}`;
  };
  if (creating && !/^[A-Z0-9_]{3,24}$/.test(f.code)) e.code = 'Use 3–24 capital letters, digits or _';
  if (f.name.trim().length < 3) e.name = 'Name needs at least 3 characters';
  if (f.type === 'percent_off') {
    intIn('percentOff', 1, 90, 'Percentage');
    intIn('maxDiscountRupees', 1, 1_000_000, 'Rupee cap');
  }
  if (f.type === 'flat_off') intIn('flatOffRupees', 1, 1_000_000, 'Discount amount');
  if (f.type === 'bonus_points') intIn('bonusPoints', 1, 1_000_000, 'Points');
  intIn('minOrderRupees', 0, 10_000_000, 'Minimum order');
  intIn('minChurnPct', 0, 100, 'Minimum churn risk', false);
  intIn('maxBuyPct', 0, 100, 'Maximum buy probability', false);
  intIn('minRewardPoints', 0, 10_000_000, 'Minimum points', false);
  intIn('grantValidityHours', 1, 720, 'Offer lifetime (hours)');
  intIn('priority', 0, 100, 'Priority');
  intIn('budgetRupees', 1, 100_000_000, 'Budget');
  intIn('maxGrants', 1, 100_000, 'Maximum offers');
  intIn('maxGrantsPerCustomer', 1, 10, 'Per customer');
  if (!f.validFrom) e.validFrom = 'Start is required';
  if (!f.validTo) e.validTo = 'End is required';
  else if (f.validFrom && new Date(f.validTo) <= new Date(f.validFrom)) e.validTo = 'End must be after start';
  return e;
}

function toPayload(f: FormState) {
  const paise = (s: string) => Math.round(Number(s) * 100);
  const terms: Record<string, unknown> = { minOrderPaise: paise(f.minOrderRupees) };
  if (f.type === 'percent_off') Object.assign(terms, { percentOff: Number(f.percentOff), maxDiscountPaise: paise(f.maxDiscountRupees) });
  if (f.type === 'flat_off') terms.flatOffPaise = paise(f.flatOffRupees);
  if (f.type === 'bonus_points') terms.bonusPoints = Number(f.bonusPoints);
  if (f.categories.length) terms.categories = f.categories;
  const eligibility: Record<string, unknown> = {};
  if (f.segments.length) eligibility.segments = f.segments;
  if (f.minChurnPct.trim()) eligibility.minChurnRisk = Number(f.minChurnPct) / 100;
  if (f.maxBuyPct.trim()) eligibility.maxPurchaseProbability = Number(f.maxBuyPct) / 100;
  if (f.requiresOpenCart) eligibility.requiresOpenCart = true;
  if (f.newCustomersOnly) eligibility.newCustomersOnly = true;
  if (f.minRewardPoints.trim()) eligibility.minRewardPoints = Number(f.minRewardPoints);
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    type: f.type,
    terms,
    eligibility,
    validFrom: new Date(f.validFrom).toISOString(),
    validTo: new Date(f.validTo).toISOString(),
    grantValidityHours: Number(f.grantValidityHours),
    priority: Number(f.priority),
    stackable: f.stackable,
    budgetTotalPaise: paise(f.budgetRupees),
    maxGrants: Number(f.maxGrants),
    maxGrantsPerCustomer: Number(f.maxGrantsPerCustomer),
  };
}

function Chips({ options, value, onChange, label }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={`rounded-full px-2.5 py-1 text-[0.78rem] ring-1 ring-inset transition-colors ${on ? 'bg-accent-soft text-accent-strong ring-accent/40' : 'bg-surface-3/60 text-ink-3 ring-line-strong hover:text-ink-2'}`}
          >
            {segmentLabel(o)}
          </button>
        );
      })}
    </div>
  );
}

export function OfferForm({ offer, open, onClose, onSaved }: { offer: OfferItem | null; open: boolean; onClose: () => void; onSaved: (o: OfferItem) => void }) {
  const creating = !offer;
  const toast = useToast();
  const initial = useMemo(() => fromOffer(offer), [offer]);
  const [f, setF] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [serverAlert, setServerAlert] = useState<{ title: string; items: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const input = (k: keyof FormState, props: Record<string, unknown> = {}) => ({
    id: `offer-${k}`,
    value: f[k] as string,
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
    'aria-invalid': Boolean(errors[k]) || undefined,
    className: inputClass,
    ...props,
  });

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const v = validate(f, creating);
    setErrors(v);
    setServerAlert(null);
    if (Object.keys(v).length) {
      document.getElementById(`offer-${Object.keys(v)[0]}`)?.focus();
      return;
    }
    if (!creating && offer!.status === 'active') setConfirmLive(true);
    else void save();
  }

  async function save() {
    setSaving(true);
    try {
      const payload = toPayload(f);
      const res = creating
        ? await api.post<{ offer: OfferItem }>('/offers', { ...payload, code: f.code })
        : await api.patch<{ offer: OfferItem }>(`/offers/${offer!.id}`, { ...payload, expectedVersion: offer!.version });
      toast({
        tone: 'success',
        title: creating ? `Offer ${res.offer.code} created as a draft` : `Offer ${res.offer.code} saved`,
        description: creating ? 'Activate it when it is ready — activation re-checks the business rules.' : res.offer.version !== offer!.version ? `Now version ${res.offer.version}.` : undefined,
      });
      onSaved(res.offer);
    } catch (err) {
      const fe = fieldErrors(err);
      const mapped: Errors = {};
      for (const [path, msg] of Object.entries(fe)) mapped[(SERVER_FIELD[path] ?? path) as keyof FormState] = msg;
      if (err instanceof ApiError && err.code === 'DUPLICATE_CODE') mapped.code = 'Another offer already uses this code';
      setErrors(mapped);
      if (err instanceof ApiError) {
        const rules = Array.isArray(err.details) ? (err.details as { rule?: string; message?: string }[]).filter((d) => d.rule).map((d) => d.message ?? '') : [];
        setServerAlert({ title: err.message, items: rules });
      }
    } finally {
      setSaving(false);
      setConfirmLive(false);
    }
  }

  const sectionTitle = 'mb-3 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase';

  return (
    <>
      <Modal
        open={open}
        onClose={saving ? () => undefined : onClose}
        size="lg"
        title={creating ? 'New offer' : `Edit ${offer!.code}`}
        description={creating ? 'New offers start as drafts. Nothing is offered until you activate them.' : `Version ${offer!.version} · ${offer!.status}`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => submit()} busy={saving} disabled={!creating && !dirty}>
              {creating ? 'Create draft' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form onSubmit={submit} noValidate className="space-y-7">
          {serverAlert && <FormAlert title={serverAlert.title} items={serverAlert.items} />}
          {!creating && (
            <p className="flex gap-2 rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5 text-[0.8rem] text-ink-2">
              <Info size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              Changing terms, eligibility, validity, budget or limits creates a new version. Offers already sent keep the terms they were promised; approved offers not yet sent are cancelled by the final pre-send check.
            </p>
          )}

          <section>
            <h3 className={sectionTitle}>Basics</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Code" htmlFor="offer-code" error={errors.code} hint={creating ? 'Capital letters, digits or _ (cannot be changed later)' : 'Codes cannot be changed'}>
                <input {...input('code', { disabled: !creating, placeholder: 'MONSOON12', onChange: (e: { target: { value: string } }) => set('code', e.target.value.toUpperCase()) })} />
              </Field>
              <Field label="Name" htmlFor="offer-name" error={errors.name}>
                <input {...input('name', { placeholder: 'Monsoon 12% off', maxLength: 80 })} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description" htmlFor="offer-description" hint="Shown to the AI as the offer's purpose, and to your team.">
                  <textarea {...input('description', { rows: 2, maxLength: 500 })} />
                </Field>
              </div>
            </div>
          </section>

          <section>
            <h3 className={sectionTitle}>What the customer gets</h3>
            <div role="radiogroup" aria-label="Offer type" className="mb-4 grid gap-2 sm:grid-cols-2">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={f.type === t.value}
                  onClick={() => set('type', t.value)}
                  className={`rounded-xl px-3.5 py-2.5 text-left ring-1 ring-inset transition-colors ${f.type === t.value ? 'bg-accent-soft ring-accent/50' : 'bg-surface-2/60 ring-line hover:ring-line-strong'}`}
                >
                  <span className={`block text-sm font-medium ${f.type === t.value ? 'text-accent-strong' : 'text-ink'}`}>{t.label}</span>
                  <span className="text-[0.75rem] text-ink-3">{t.help}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {f.type === 'percent_off' && (
                <>
                  <Field label="Percentage off" htmlFor="offer-percentOff" error={errors.percentOff}>
                    <input {...input('percentOff', { type: 'number', min: 1, max: 90, inputMode: 'numeric' })} />
                  </Field>
                  <Field label="Rupee cap (₹)" htmlFor="offer-maxDiscountRupees" error={errors.maxDiscountRupees}>
                    <input {...input('maxDiscountRupees', { type: 'number', min: 1, inputMode: 'numeric' })} />
                  </Field>
                </>
              )}
              {f.type === 'flat_off' && (
                <Field label="Amount off (₹)" htmlFor="offer-flatOffRupees" error={errors.flatOffRupees}>
                  <input {...input('flatOffRupees', { type: 'number', min: 1, inputMode: 'numeric' })} />
                </Field>
              )}
              {f.type === 'bonus_points' && (
                <Field label="Bonus points" htmlFor="offer-bonusPoints" error={errors.bonusPoints}>
                  <input {...input('bonusPoints', { type: 'number', min: 1, inputMode: 'numeric' })} />
                </Field>
              )}
              <Field label="Minimum order (₹)" htmlFor="offer-minOrderRupees" error={errors.minOrderRupees}>
                <input {...input('minOrderRupees', { type: 'number', min: 0, inputMode: 'numeric' })} />
              </Field>
            </div>
            <div className="mt-4">
              <p className="mb-1.5 text-sm font-medium text-ink-2">Limited to categories</p>
              <Chips options={CATEGORIES} value={f.categories} onChange={(v) => set('categories', v)} label="Categories" />
              <p className="mt-1 text-[0.78rem] text-ink-3">None selected = all categories.</p>
            </div>
          </section>

          <section>
            <h3 className={sectionTitle}>Who can get it</h3>
            <p className="mb-1.5 text-sm font-medium text-ink-2">Segments</p>
            <Chips options={SEGMENTS} value={f.segments} onChange={(v) => set('segments', v)} label="Segments" />
            <p className="mt-1 mb-4 text-[0.78rem] text-ink-3">None selected = every segment the global rules allow.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Min. churn risk (%)" htmlFor="offer-minChurnPct" error={errors.minChurnPct} hint="Optional">
                <input {...input('minChurnPct', { type: 'number', min: 0, max: 100 })} />
              </Field>
              <Field label="Max. buy probability (%)" htmlFor="offer-maxBuyPct" error={errors.maxBuyPct} hint="Optional">
                <input {...input('maxBuyPct', { type: 'number', min: 0, max: 100 })} />
              </Field>
              <Field label="Min. reward points" htmlFor="offer-minRewardPoints" error={errors.minRewardPoints} hint="Optional">
                <input {...input('minRewardPoints', { type: 'number', min: 0 })} />
              </Field>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-xl bg-surface-2/60 px-3.5 py-2.5 text-sm text-ink-2 ring-1 ring-line">
                Only customers with an open cart
                <Toggle checked={f.requiresOpenCart} onChange={(v) => set('requiresOpenCart', v)} label="Only customers with an open cart" />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-xl bg-surface-2/60 px-3.5 py-2.5 text-sm text-ink-2 ring-1 ring-line">
                Only customers who haven't ordered
                <Toggle checked={f.newCustomersOnly} onChange={(v) => set('newCustomersOnly', v)} label="Only customers who haven't ordered yet" />
              </label>
            </div>
          </section>

          <section>
            <h3 className={sectionTitle}>Timing, budget and limits</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Starts" htmlFor="offer-validFrom" error={errors.validFrom}>
                <input {...input('validFrom', { type: 'datetime-local' })} />
              </Field>
              <Field label="Ends" htmlFor="offer-validTo" error={errors.validTo}>
                <input {...input('validTo', { type: 'datetime-local' })} />
              </Field>
              <Field label="Each offer lasts (hours)" htmlFor="offer-grantValidityHours" error={errors.grantValidityHours}>
                <input {...input('grantValidityHours', { type: 'number', min: 1, max: 720 })} />
              </Field>
              <Field label="Total budget (₹)" htmlFor="offer-budgetRupees" error={errors.budgetRupees} hint={offer ? `Cannot go below committed (₹${Math.ceil((offer.budget.reservedPaise + offer.budget.redeemedPaise) / 100)})` : undefined}>
                <input {...input('budgetRupees', { type: 'number', min: 1 })} />
              </Field>
              <Field label="Maximum offers issued" htmlFor="offer-maxGrants" error={errors.maxGrants} hint={offer ? `${offer.usage.grantsIssued} issued so far` : undefined}>
                <input {...input('maxGrants', { type: 'number', min: 1 })} />
              </Field>
              <Field label="Per customer" htmlFor="offer-maxGrantsPerCustomer" error={errors.maxGrantsPerCustomer}>
                <input {...input('maxGrantsPerCustomer', { type: 'number', min: 1, max: 10 })} />
              </Field>
              <Field label="Priority (0–100)" htmlFor="offer-priority" error={errors.priority} hint="Higher wins in the rule-based fallback">
                <input {...input('priority', { type: 'number', min: 0, max: 100 })} />
              </Field>
              <div className="sm:col-span-2 lg:col-span-2">
                <label className="mt-6 flex items-center justify-between gap-3 rounded-xl bg-surface-2/60 px-3.5 py-2.5 text-sm text-ink-2 ring-1 ring-line">
                  Can be held alongside another unused offer (if the stacking rule allows this type)
                  <Toggle checked={f.stackable} onChange={(v) => set('stackable', v)} label="Stackable" />
                </label>
              </div>
            </div>
          </section>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmLive}
        title="Change a live offer?"
        body={
          <>
            <b className="text-ink">{offer?.code}</b> is active. If you changed its terms, eligibility, validity, budget or limits, it becomes a new version: customers who already received it keep their terms, and approved offers that haven't been sent yet will be cancelled by the final check. The change is refused if it would break the business rules.
          </>
        }
        confirmLabel="Save live offer"
        busy={saving}
        onConfirm={() => void save()}
        onCancel={() => setConfirmLive(false)}
      />
    </>
  );
}
