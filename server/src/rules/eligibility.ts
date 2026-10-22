import { ruleParams, type RuleSetRecord } from '../domain/rules';
import { DISCOUNT_TYPES, type ContactStats, type CustomerContext, type OfferRecord } from '../domain/types';
import type { Violation } from './violations';

export interface EligibilityInput {
  customer: CustomerContext;
  stats: ContactStats;
  ruleSet: RuleSetRecord;
  now: Date;
}

export interface Exclusion {
  offerId: string;
  code: string;
  reasons: Violation[];
}

const HOUR = 3_600_000;

/**
 * Deterministic candidate filter: decides which offers the AI may even see.
 * The independent validator (validator.ts) re-checks everything separately and never trusts this result.
 */
export function filterEligible(offers: OfferRecord[], input: EligibilityInput): { eligible: OfferRecord[]; excluded: Exclusion[] } {
  const { customer: c, stats, ruleSet, now } = input;
  const f = c.features;

  // Customer-level blockers apply to every offer.
  const customerReasons: Violation[] = [];
  if (c.optedOut) customerReasons.push({ rule: 'OPTED_OUT', message: 'Customer has opted out of offers' });
  const segEx = ruleParams(ruleSet, 'SEGMENT_EXCLUSION');
  if (segEx?.segments.includes(c.segment)) customerReasons.push({ rule: 'SEGMENT_EXCLUSION', message: `Segment "${c.segment}" is excluded` });
  const ret = ruleParams(ruleSet, 'RETURN_ABUSE_EXCLUSION');
  if (ret && f.returnRate > ret.maxReturnRate) customerReasons.push({ rule: 'RETURN_ABUSE_EXCLUSION', message: `Return rate ${Math.round(f.returnRate * 100)}% is above the limit` });
  const cap = ruleParams(ruleSet, 'FREQUENCY_CAP');
  if (cap && stats.approvedInWindow >= cap.maxOffers) customerReasons.push({ rule: 'FREQUENCY_CAP', message: `Already received ${stats.approvedInWindow} offer(s) in the last ${cap.windowDays} days` });

  const eligible: OfferRecord[] = [];
  const excluded: Exclusion[] = [];

  for (const o of offers) {
    const reasons: Violation[] = [...customerReasons];
    const add = (rule: string, message: string) => reasons.push({ rule, message });
    const isDiscount = DISCOUNT_TYPES.includes(o.type);

    if (o.status !== 'active') add('OFFER_INACTIVE', `Offer is ${o.status}`);
    if (o.validFrom > now) add('OFFER_NOT_STARTED', 'Offer has not started yet');
    if (o.validTo <= now) add('OFFER_EXPIRED', 'Offer has expired');
    else {
      const buffer = ruleParams(ruleSet, 'OFFER_EXPIRY_BUFFER');
      if (buffer && o.validTo.getTime() - now.getTime() < buffer.minHoursRemaining * HOUR) add('OFFER_EXPIRY_BUFFER', 'Offer ends too soon to send');
    }

    const maxPct = ruleParams(ruleSet, 'MAX_DISCOUNT_PERCENT');
    if (maxPct && o.type === 'percent_off' && (o.terms.percentOff ?? 0) > maxPct.maxPercent) add('MAX_DISCOUNT_PERCENT', `${o.terms.percentOff}% exceeds the ${maxPct.maxPercent}% cap`);
    const maxAmt = ruleParams(ruleSet, 'MAX_DISCOUNT_AMOUNT');
    if (maxAmt && o.type === 'percent_off' && !(o.terms.maxDiscountPaise && o.terms.maxDiscountPaise <= maxAmt.maxPaise)) add('MAX_DISCOUNT_AMOUNT', 'Maximum discount is missing or above the cap');
    if (maxAmt && o.type === 'flat_off' && (o.terms.flatOffPaise ?? 0) > maxAmt.maxPaise) add('MAX_DISCOUNT_AMOUNT', 'Flat discount is above the cap');
    const minOrder = ruleParams(ruleSet, 'MIN_ORDER_FOR_DISCOUNT');
    if (minOrder && isDiscount && o.terms.minOrderPaise < minOrder.minPaise) add('MIN_ORDER_FOR_DISCOUNT', 'Minimum order is below the required floor');

    if (o.budget.reservedPaise + o.budget.redeemedPaise + o.estimatedCostPaise > o.budget.totalPaise) add('BUDGET_EXHAUSTED', 'Offer budget is used up');
    if (o.usage.grantsIssued >= o.usage.maxGrants) add('USAGE_LIMIT', 'Offer usage limit reached');
    if ((stats.grantsByOffer[o.id] ?? 0) >= o.usage.maxGrantsPerCustomer) add('PER_CUSTOMER_LIMIT', 'Customer already received this offer');

    const e = o.eligibility;
    if (e.segments?.length && !e.segments.includes(c.segment)) add('OFFER_TARGETING', `Offer targets ${e.segments.join(', ')}`);
    if (e.minChurnRisk !== undefined && f.churnRisk < e.minChurnRisk) add('OFFER_TARGETING', 'Churn risk below the offer threshold');
    if (e.maxPurchaseProbability !== undefined && f.purchaseProbability7d > e.maxPurchaseProbability) add('OFFER_TARGETING', 'Purchase probability above the offer threshold');
    if (e.requiresOpenCart && !f.openCart) add('OFFER_TARGETING', 'Offer requires an open cart');
    if (e.requiresOpenCart && f.openCart && o.terms.categories?.length && !f.openCart.categories.some((x) => o.terms.categories!.includes(x)))
      add('OFFER_TARGETING', 'Cart categories do not match the offer');
    if (e.newCustomersOnly && f.lastOrderAt !== null) add('OFFER_TARGETING', 'Offer is for customers who have not ordered yet');
    if (e.minRewardPoints !== undefined && c.rewardPoints.balance < e.minRewardPoints) add('OFFER_TARGETING', 'Not enough reward points');

    const cooldown = ruleParams(ruleSet, 'PURCHASE_COOLDOWN');
    if (cooldown && isDiscount && f.recencyDays !== null && f.recencyDays < cooldown.days) add('PURCHASE_COOLDOWN', `Purchased ${f.recencyDays} day(s) ago`);
    const likely = ruleParams(ruleSet, 'LIKELY_BUYER_SUPPRESSION');
    if (likely && likely.appliesToTypes.includes(o.type) && f.purchaseProbability7d >= likely.maxPurchaseProbability)
      add('LIKELY_BUYER_SUPPRESSION', `Already ${Math.round(f.purchaseProbability7d * 100)}% likely to buy`);
    const stacking = ruleParams(ruleSet, 'NO_STACKING');
    if (stacking) {
      const stackableOk = o.stackable && stacking.stackableTypes.includes(o.type);
      const blocking = stats.activeGrants.filter((g) => !(g.stackable && stacking.stackableTypes.includes(g.type))).length;
      if (!stackableOk && blocking >= stacking.maxActiveGrants) add('NO_STACKING', 'Customer already holds an unused offer');
    }

    if (reasons.length) excluded.push({ offerId: o.id, code: o.code, reasons });
    else eligible.push(o);
  }
  return { eligible, excluded };
}
