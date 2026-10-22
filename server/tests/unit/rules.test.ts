import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OFFERS, DEFAULT_RULES, offerDocFromSeed } from '../../src/data/catalog';
import type { RuleSetRecord } from '../../src/domain/rules';
import type { ContactStats, CustomerContext, CustomerFeatures, OfferRecord, Segment } from '../../src/domain/types';
import { toOfferRecord } from '../../src/models';
import { checkCopy } from '../../src/rules/copy';
import { filterEligible } from '../../src/rules/eligibility';
import { rankFallback, templateCopy } from '../../src/rules/fallback';
import { validateDecision, type ValidationInput } from '../../src/rules/validator';

const NOW = new Date('2026-10-22T10:00:00.000Z');
const DAY = 86_400_000;
const rules: RuleSetRecord = { version: 1, rules: DEFAULT_RULES };
const offers: OfferRecord[] = DEFAULT_OFFERS.map((s) => toOfferRecord({ _id: new Types.ObjectId(), ...offerDocFromSeed(s, NOW) }));
const offer = (code: string) => offers.find((o) => o.code === code)!;
const noStats: ContactStats = { approvedInWindow: 0, activeGrants: [], grantsByOffer: {} };

function customer(segment: Segment, f: Partial<CustomerFeatures> = {}): CustomerContext {
  return {
    id: 'c1',
    externalRef: 'T-1',
    segment,
    features: {
      recencyDays: 50, frequency90d: 1, monetary90dPaise: 100_000, aovPaise: 100_000, churnRisk: 0.8, purchaseProbability7d: 0.1,
      discountSensitivity: 0.3, returnRate: 0.05, cartAbandonRate: 0.5, daysSinceSignup: 300,
      lastOrderAt: new Date(NOW.getTime() - 50 * DAY), lastActiveAt: NOW, openCart: null, ...f,
    },
    rewardPoints: { balance: 100, expiringPoints: 0, expiresAt: null },
    preferredCategories: ['fashion'],
    optedOut: false,
  };
}

const goodCopy = { headline: 'We have missed you around here', body: 'Come back and treat yourself to something you love.' };

function input(o: OfferRecord | null, over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    proposal: { offerId: o?.id ?? null, ...goodCopy },
    candidateIds: o ? [o.id] : [],
    offer: o,
    customer: customer('at_risk'),
    stats: noStats,
    ruleSet: rules,
    now: NOW,
    phase: 'decision',
    ...over,
  };
}

const ruleCodes = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);

describe('independent validator', () => {
  it('approves an eligible offer with clean wording', () => {
    const r = validateDecision(input(offer('WINBACK15')));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('rejects an expired offer even if it is passed as a candidate', () => {
    const r = validateDecision(input(offer('FESTIVE20')));
    expect(r.ok).toBe(false);
    expect(ruleCodes(r)).toContain('OFFER_EXPIRED');
  });

  it('rejects a paused or draft offer', () => {
    expect(ruleCodes(validateDecision(input({ ...offer('WINBACK15'), status: 'paused' })))).toContain('OFFER_INACTIVE');
    expect(ruleCodes(validateDecision(input(offer('MEGA30'))))).toContain('OFFER_INACTIVE');
  });

  it('rejects a fabricated offer id that is not a candidate', () => {
    const fake = new Types.ObjectId().toString();
    const r = validateDecision(input(offer('WINBACK15'), { proposal: { offerId: fake, ...goodCopy } }));
    expect(ruleCodes(r)).toEqual(['NOT_A_CANDIDATE']);
  });

  it('rejects an ineligible offer (wrong segment, likely buyer)', () => {
    const r = validateDecision(input(offer('WINBACK15'), { customer: customer('loyal', { purchaseProbability7d: 0.9, recencyDays: 1, churnRisk: 0.1 }) }));
    expect(ruleCodes(r)).toEqual(expect.arrayContaining(['OFFER_TARGETING', 'LIKELY_BUYER_SUPPRESSION', 'PURCHASE_COOLDOWN']));
  });

  it('enforces the discount caps from the current rules', () => {
    const strict: RuleSetRecord = {
      version: 2,
      rules: DEFAULT_RULES.map((r) => (r.type === 'MAX_DISCOUNT_PERCENT' ? { ...r, params: { maxPercent: 10 } } : r)),
    };
    expect(ruleCodes(validateDecision(input(offer('WINBACK15'), { ruleSet: strict })))).toContain('MAX_DISCOUNT_PERCENT');
    const MEGA = { ...offer('MEGA30'), status: 'active' as const };
    expect(ruleCodes(validateDecision(input(MEGA, { customer: customer('promising') })))).toEqual(
      expect.arrayContaining(['MAX_DISCOUNT_PERCENT', 'MAX_DISCOUNT_AMOUNT']),
    );
  });

  it('rejects when budget or usage is exhausted', () => {
    const o = offer('WINBACK15');
    const broke = { ...o, budget: { ...o.budget, reservedPaise: o.budget.totalPaise - o.estimatedCostPaise + 1 } };
    expect(ruleCodes(validateDecision(input(broke)))).toContain('BUDGET_EXHAUSTED');
    const used = { ...o, usage: { ...o.usage, grantsIssued: o.usage.maxGrants } };
    expect(ruleCodes(validateDecision(input(used)))).toContain('USAGE_LIMIT');
  });

  it('enforces frequency cap and stacking', () => {
    const o = offer('WINBACK15');
    expect(ruleCodes(validateDecision(input(o, { stats: { ...noStats, approvedInWindow: 2 } })))).toContain('FREQUENCY_CAP');
    const holding = { ...noStats, activeGrants: [{ offerId: 'x', type: 'flat_off' as const, stackable: false }] };
    expect(ruleCodes(validateDecision(input(o, { stats: holding })))).toContain('NO_STACKING');
  });

  it('rejects AI wording that states terms, links or misrepresents the offer', () => {
    const o = offer('WINBACK15');
    for (const [headline, body, rule] of [
      ['Get 40% off today', 'Come back and shop.', 'COPY_CONTAINS_TERMS'],
      ['Save big', 'Only Rs. one hundred off, visit www.shop.com', 'COPY_CONTAINS_TERMS'],
      ['Treat yourself', 'Enjoy free shipping on us!', 'COPY_MISREPRESENTS_OFFER'],
      ['Guaranteed savings', 'This deal is guaranteed for you.', 'COPY_POLICY'],
      ['x'.repeat(61), 'Nice body copy here.', 'COPY_POLICY'],
    ] as const) {
      expect(ruleCodes(validateDecision(input(o, { proposal: { offerId: o.id, headline, body } })))).toContain(rule);
    }
  });

  it('fails closed when it cannot complete', () => {
    const broken = { ...input(offer('WINBACK15')), customer: null as unknown as CustomerContext };
    const r = validateDecision(broken);
    expect(r.ok).toBe(false);
    expect(ruleCodes(r)).toEqual(['VALIDATOR_ERROR']);
  });

  it('pre-send phase rejects an offer whose terms changed after approval', () => {
    const o = offer('WINBACK15');
    const snapshot = { offerId: o.id, code: o.code, name: o.name, version: 1, type: o.type, terms: o.terms, estimatedCostPaise: o.estimatedCostPaise, stackable: false };
    const r = validateDecision(input({ ...o, version: 2 }, { phase: 'presend', snapshot, candidateIds: undefined }));
    expect(ruleCodes(r)).toContain('OFFER_CHANGED');
  });
});

describe('eligibility filter and validator agree', () => {
  const customers: CustomerContext[] = [
    customer('at_risk'),
    customer('loyal', { purchaseProbability7d: 0.9, recencyDays: 1, churnRisk: 0.05 }),
    customer('new', { lastOrderAt: null, recencyDays: null, daysSinceSignup: 5 }),
    customer('promising', { openCart: { cartId: 'c', valuePaise: 150_000, categories: ['fashion'], updatedAt: NOW }, recencyDays: 20, churnRisk: 0.2 }),
    customer('hibernating', { returnRate: 0.6 }),
    customer('champion', { purchaseProbability7d: 0.8, recencyDays: 3 }),
  ];
  const statsList: ContactStats[] = [noStats, { ...noStats, approvedInWindow: 2 }, { ...noStats, activeGrants: [{ offerId: 'x', type: 'percent_off', stackable: false }] }];

  it('every eligible offer validates, every excluded offer fails', () => {
    let checked = 0;
    for (const c of customers) {
      for (const stats of statsList) {
        const { eligible, excluded } = filterEligible(offers, { customer: c, stats, ruleSet: rules, now: NOW });
        for (const o of offers) {
          const v = validateDecision({ ...input(o), candidateIds: offers.map((x) => x.id), customer: c, stats });
          const isEligible = eligible.some((e) => e.id === o.id);
          expect({ code: o.code, seg: c.segment, ok: v.ok }).toEqual({ code: o.code, seg: c.segment, ok: isEligible });
          if (!isEligible) expect(excluded.find((e) => e.offerId === o.id)!.reasons.length).toBeGreaterThan(0);
          checked++;
        }
      }
    }
    expect(checked).toBe(customers.length * statsList.length * offers.length);
  });
});

describe('deterministic fallback', () => {
  it('ranks by priority then cost, and its template copy always passes the copy policy', () => {
    expect(rankFallback(offers).map((o) => o.code).slice(0, 3)).toEqual(['MEGA30', 'FESTIVE20', 'CARTSAVE10']);
    for (const o of offers) {
      for (const seg of ['at_risk', 'new', 'loyal', 'promising', 'window_shopper'] as Segment[]) {
        const copy = templateCopy(o, customer(seg));
        expect(checkCopy(copy.headline, copy.body, o.type, rules)).toEqual([]);
      }
    }
  });
});
