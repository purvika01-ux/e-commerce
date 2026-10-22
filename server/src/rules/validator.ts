import { ruleParams, type RuleSetRecord } from '../domain/rules';
import { DISCOUNT_TYPES, type ContactStats, type CustomerContext, type OfferRecord, type OfferSnapshot } from '../domain/types';
import { checkCopy } from './copy';
import { VALIDATOR_VERSION, type ValidationResult, type Violation } from './violations';

export interface ValidationInput {
  /** The proposed offer id and wording — from the AI, the fallback, or a stored decision. */
  proposal: { offerId: string | null; headline: string | null; body: string | null };
  /** decision phase: the eligible candidate ids. presend phase: the approved snapshot. */
  candidateIds?: string[];
  snapshot?: OfferSnapshot;
  /** The offer as freshly loaded from the database (null if it no longer exists). */
  offer: OfferRecord | null;
  customer: CustomerContext;
  stats: ContactStats;
  ruleSet: RuleSetRecord;
  now: Date;
  phase: 'decision' | 'presend';
}

type Check = (i: ValidationInput, o: OfferRecord) => Violation | Violation[] | null;

const HOUR = 3_600_000;
const v = (rule: string, message: string): Violation => ({ rule, message });

// Each check is written independently of eligibility.ts so that a bug in one is caught by the other.
const OFFER_CHECKS: Check[] = [
  (_, o) => (o.status === 'active' ? null : v('OFFER_INACTIVE', `Offer status is "${o.status}"`)),
  (i, o) => (i.now.getTime() >= o.validFrom.getTime() ? null : v('OFFER_NOT_STARTED', 'Offer validity has not started')),
  (i, o) => (i.now.getTime() < o.validTo.getTime() ? null : v('OFFER_EXPIRED', 'Offer validity has ended')),
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'OFFER_EXPIRY_BUFFER');
    if (!p || i.now.getTime() >= o.validTo.getTime()) return null;
    return (o.validTo.getTime() - i.now.getTime()) / HOUR >= p.minHoursRemaining ? null : v('OFFER_EXPIRY_BUFFER', `Offer ends in under ${p.minHoursRemaining}h`);
  },
  (i, o) => {
    if (i.phase !== 'presend' || !i.snapshot) return null;
    return o.version === i.snapshot.version ? null : v('OFFER_CHANGED', 'Offer terms changed after approval');
  },
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'MAX_DISCOUNT_PERCENT');
    if (!p || o.type !== 'percent_off') return null;
    const pct = o.terms.percentOff;
    return typeof pct === 'number' && pct <= p.maxPercent ? null : v('MAX_DISCOUNT_PERCENT', `Discount of ${pct}% is above the ${p.maxPercent}% limit`);
  },
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'MAX_DISCOUNT_AMOUNT');
    if (!p) return null;
    const worst = o.type === 'percent_off' ? o.terms.maxDiscountPaise : o.type === 'flat_off' ? o.terms.flatOffPaise : 0;
    if (worst === undefined) return v('MAX_DISCOUNT_AMOUNT', 'Percentage discount has no rupee cap');
    return worst <= p.maxPaise ? null : v('MAX_DISCOUNT_AMOUNT', 'Discount value is above the rupee limit');
  },
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'MIN_ORDER_FOR_DISCOUNT');
    if (!p || !DISCOUNT_TYPES.includes(o.type)) return null;
    return o.terms.minOrderPaise >= p.minPaise ? null : v('MIN_ORDER_FOR_DISCOUNT', 'Minimum order is below the rule');
  },
  // Budget and usage are reserved atomically at approval, so they are checked before approval only.
  (i, o) => {
    if (i.phase !== 'decision') return null;
    const remaining = o.budget.totalPaise - o.budget.reservedPaise - o.budget.redeemedPaise;
    return remaining >= o.estimatedCostPaise ? null : v('BUDGET_EXHAUSTED', 'Not enough budget left for this offer');
  },
  (i, o) => (i.phase !== 'decision' || o.usage.grantsIssued < o.usage.maxGrants ? null : v('USAGE_LIMIT', 'Usage limit reached')),
  (i, o) => ((i.stats.grantsByOffer[o.id] ?? 0) < o.usage.maxGrantsPerCustomer ? null : v('PER_CUSTOMER_LIMIT', 'Customer already holds this offer')),
];

const TARGETING_CHECKS: Check[] = [
  (i, o) => {
    const segs = o.eligibility.segments;
    return !segs?.length || segs.includes(i.customer.segment) ? null : v('OFFER_TARGETING', 'Customer segment is not targeted');
  },
  (i, o) =>
    o.eligibility.minChurnRisk === undefined || i.customer.features.churnRisk >= o.eligibility.minChurnRisk ? null : v('OFFER_TARGETING', 'Churn risk too low'),
  (i, o) =>
    o.eligibility.maxPurchaseProbability === undefined || i.customer.features.purchaseProbability7d <= o.eligibility.maxPurchaseProbability
      ? null
      : v('OFFER_TARGETING', 'Purchase probability too high'),
  (i, o) => {
    if (!o.eligibility.requiresOpenCart) return null;
    const cart = i.customer.features.openCart;
    if (!cart) return v('OFFER_TARGETING', 'No open cart');
    const cats = o.terms.categories;
    return !cats?.length || cart.categories.some((x) => cats.includes(x)) ? null : v('OFFER_TARGETING', 'Cart categories do not match');
  },
  (i, o) => (!o.eligibility.newCustomersOnly || i.customer.features.lastOrderAt === null ? null : v('OFFER_TARGETING', 'Customer has already ordered')),
  (i, o) =>
    o.eligibility.minRewardPoints === undefined || i.customer.rewardPoints.balance >= o.eligibility.minRewardPoints ? null : v('OFFER_TARGETING', 'Too few reward points'),
];

const CUSTOMER_CHECKS: Check[] = [
  (i) => (i.customer.optedOut ? v('OPTED_OUT', 'Customer opted out') : null),
  (i) => {
    const p = ruleParams(i.ruleSet, 'SEGMENT_EXCLUSION');
    return p && p.segments.includes(i.customer.segment) ? v('SEGMENT_EXCLUSION', 'Customer segment is excluded') : null;
  },
  (i) => {
    const p = ruleParams(i.ruleSet, 'RETURN_ABUSE_EXCLUSION');
    return p && i.customer.features.returnRate > p.maxReturnRate ? v('RETURN_ABUSE_EXCLUSION', 'Return rate above the limit') : null;
  },
  (i) => {
    const p = ruleParams(i.ruleSet, 'FREQUENCY_CAP');
    return p && i.stats.approvedInWindow >= p.maxOffers ? v('FREQUENCY_CAP', `Frequency cap of ${p.maxOffers} per ${p.windowDays} days reached`) : null;
  },
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'PURCHASE_COOLDOWN');
    const r = i.customer.features.recencyDays;
    return p && DISCOUNT_TYPES.includes(o.type) && r !== null && r < p.days ? v('PURCHASE_COOLDOWN', 'Customer purchased too recently') : null;
  },
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'LIKELY_BUYER_SUPPRESSION');
    return p && p.appliesToTypes.includes(o.type) && i.customer.features.purchaseProbability7d >= p.maxPurchaseProbability
      ? v('LIKELY_BUYER_SUPPRESSION', 'Customer is likely to buy without a discount')
      : null;
  },
  (i, o) => {
    const p = ruleParams(i.ruleSet, 'NO_STACKING');
    if (!p) return null;
    const isStackable = (type: string, stackable: boolean) => stackable && (p.stackableTypes as string[]).includes(type);
    if (isStackable(o.type, o.stackable)) return null;
    const held = i.stats.activeGrants.filter((g) => !isStackable(g.type, g.stackable)).length;
    return held < p.maxActiveGrants ? null : v('NO_STACKING', 'Customer already holds an unused offer');
  },
];

/**
 * Independent validator. Every AI proposal, every fallback and every pre-send recheck goes through
 * here. It ignores the AI's rationale and confidence entirely, and fails closed on any exception.
 */
export function validateDecision(input: ValidationInput): ValidationResult {
  const result = (violations: Violation[]): ValidationResult => ({
    ok: violations.length === 0,
    phase: input.phase,
    violations,
    checkedAt: input.now,
    validatorVersion: VALIDATOR_VERSION,
  });
  try {
    const { proposal } = input;
    if (!proposal.offerId) return result([v('NO_OFFER_SELECTED', 'No offer id was proposed')]);
    if (input.phase === 'decision' && !(input.candidateIds ?? []).includes(proposal.offerId)) {
      return result([v('NOT_A_CANDIDATE', 'Proposed offer is not one of the eligible candidates')]);
    }
    if (input.phase === 'presend' && proposal.offerId !== input.snapshot?.offerId) {
      return result([v('NOT_A_CANDIDATE', 'Offer does not match the approved decision')]);
    }
    const o = input.offer;
    if (!o || o.id !== proposal.offerId) return result([v('OFFER_NOT_FOUND', 'Offer does not exist')]);

    const violations: Violation[] = [];
    for (const check of [...OFFER_CHECKS, ...TARGETING_CHECKS, ...CUSTOMER_CHECKS]) {
      const r = check(input, o);
      if (r) violations.push(...(Array.isArray(r) ? r : [r]));
    }
    violations.push(...checkCopy(proposal.headline, proposal.body, o.type, input.ruleSet));
    return result(violations);
  } catch (err) {
    return result([v('VALIDATOR_ERROR', `Validator could not complete: ${err instanceof Error ? err.message : 'unknown error'}`)]);
  }
}
