import type { Rule } from '../domain/rules';
import { estimateCostPaise, type OfferEligibility, type OfferStatus, type OfferTerms, type OfferType } from '../domain/types';

const DAY = 86_400_000;

export interface OfferSeed {
  code: string;
  name: string;
  description: string;
  status: OfferStatus;
  type: OfferType;
  terms: OfferTerms;
  eligibility: OfferEligibility;
  validFromDays: number; // relative to seeding time
  validToDays: number;
  grantValidityHours: number;
  priority: number;
  stackable?: boolean;
  budgetPaise: number;
  maxGrants: number;
}

/**
 * Default offers. Edit here (then re-seed) or change status from the dashboard.
 * Commercial terms live only here and in the database — never in AI output.
 */
export const DEFAULT_OFFERS: OfferSeed[] = [
  {
    code: 'WINBACK15',
    name: 'We miss you — 15% off',
    description: 'Win-back discount for customers who have gone quiet.',
    status: 'active',
    type: 'percent_off',
    terms: { percentOff: 15, maxDiscountPaise: 30_000, minOrderPaise: 99_900 },
    eligibility: { segments: ['at_risk', 'hibernating'], minChurnRisk: 0.5 },
    validFromDays: -1,
    validToDays: 30,
    grantValidityHours: 72,
    priority: 70,
    budgetPaise: 2_000_000,
    maxGrants: 100,
  },
  {
    code: 'CARTSAVE10',
    name: 'Finish your cart — 10% off',
    description: 'Nudge for customers with a recently abandoned cart; valid on the cart categories.',
    status: 'active',
    type: 'percent_off',
    terms: { percentOff: 10, maxDiscountPaise: 25_000, minOrderPaise: 79_900 },
    eligibility: { requiresOpenCart: true },
    validFromDays: -1,
    validToDays: 30,
    grantValidityHours: 48,
    priority: 80,
    budgetPaise: 1_500_000,
    maxGrants: 100,
  },
  {
    code: 'WELCOME100',
    name: '₹100 off your first order',
    description: 'Welcome offer for new customers.',
    status: 'active',
    type: 'flat_off',
    terms: { flatOffPaise: 10_000, minOrderPaise: 59_900 },
    eligibility: { segments: ['new'], newCustomersOnly: true },
    validFromDays: -1,
    validToDays: 30,
    grantValidityHours: 168,
    priority: 60,
    budgetPaise: 1_000_000,
    maxGrants: 100,
  },
  {
    code: 'FREESHIP',
    name: 'Free shipping on your next order',
    description: 'Low-cost nudge for browsers and price-sensitive shoppers.',
    status: 'active',
    type: 'free_shipping',
    terms: { minOrderPaise: 49_900 },
    eligibility: { segments: ['promising', 'window_shopper', 'price_sensitive', 'new'] },
    validFromDays: -1,
    validToDays: 30,
    grantValidityHours: 96,
    priority: 40,
    budgetPaise: 600_000,
    maxGrants: 100,
  },
  {
    code: 'LOYALPTS200',
    name: '200 bonus reward points',
    description: 'Thank-you for loyal customers — no discount, so no lost margin.',
    status: 'active',
    type: 'bonus_points',
    terms: { bonusPoints: 200, minOrderPaise: 0 },
    eligibility: { segments: ['champion', 'loyal'] },
    validFromDays: -1,
    validToDays: 30,
    grantValidityHours: 168,
    priority: 50,
    stackable: true,
    budgetPaise: 500_000,
    maxGrants: 200,
  },
  {
    code: 'FESTIVE20',
    name: 'Festive sale — 20% off',
    description: 'Expired seasonal campaign, kept to show that expired offers are never sent.',
    status: 'active',
    type: 'percent_off',
    terms: { percentOff: 20, maxDiscountPaise: 40_000, minOrderPaise: 149_900 },
    eligibility: {},
    validFromDays: -20,
    validToDays: -2,
    grantValidityHours: 48,
    priority: 90,
    budgetPaise: 2_000_000,
    maxGrants: 100,
  },
  {
    code: 'MEGA30',
    name: 'Mega 30% off (draft)',
    description: 'Draft that breaks the 25% discount cap — activation is refused by the rules.',
    status: 'draft',
    type: 'percent_off',
    terms: { percentOff: 30, maxDiscountPaise: 80_000, minOrderPaise: 199_900 },
    eligibility: {},
    validFromDays: -1,
    validToDays: 14,
    grantValidityHours: 48,
    priority: 95,
    budgetPaise: 3_000_000,
    maxGrants: 50,
  },
];

export function offerDocFromSeed(s: OfferSeed, now: Date) {
  return {
    code: s.code,
    name: s.name,
    description: s.description,
    status: s.status,
    version: 1,
    type: s.type,
    terms: s.terms,
    eligibility: s.eligibility,
    validFrom: new Date(now.getTime() + s.validFromDays * DAY),
    validTo: new Date(now.getTime() + s.validToDays * DAY),
    grantValidityHours: s.grantValidityHours,
    priority: s.priority,
    estimatedCostPaise: estimateCostPaise(s.type, s.terms),
    stackable: Boolean(s.stackable),
    budget: { totalPaise: s.budgetPaise, reservedPaise: 0, redeemedPaise: 0 },
    usage: { maxGrants: s.maxGrants, grantsIssued: 0, maxGrantsPerCustomer: 1, redemptions: 0 },
  };
}

export const DEFAULT_RULES: Rule[] = [
  { key: 'max_discount_percent', type: 'MAX_DISCOUNT_PERCENT', enabled: true, params: { maxPercent: 25 } },
  { key: 'max_discount_amount', type: 'MAX_DISCOUNT_AMOUNT', enabled: true, params: { maxPaise: 50_000 } },
  { key: 'min_order_for_discount', type: 'MIN_ORDER_FOR_DISCOUNT', enabled: true, params: { minPaise: 49_900 } },
  { key: 'frequency_cap', type: 'FREQUENCY_CAP', enabled: true, params: { maxOffers: 2, windowDays: 7 } },
  { key: 'purchase_cooldown', type: 'PURCHASE_COOLDOWN', enabled: true, params: { days: 2 } },
  { key: 'no_stacking', type: 'NO_STACKING', enabled: true, params: { maxActiveGrants: 1, stackableTypes: ['bonus_points'] } },
  {
    key: 'likely_buyer_suppression',
    type: 'LIKELY_BUYER_SUPPRESSION',
    enabled: true,
    params: { maxPurchaseProbability: 0.7, appliesToTypes: ['percent_off', 'flat_off'] },
  },
  { key: 'return_abuse_exclusion', type: 'RETURN_ABUSE_EXCLUSION', enabled: true, params: { maxReturnRate: 0.4 } },
  { key: 'segment_exclusion', type: 'SEGMENT_EXCLUSION', enabled: true, params: { segments: [] } },
  { key: 'offer_expiry_buffer', type: 'OFFER_EXPIRY_BUFFER', enabled: true, params: { minHoursRemaining: 2 } },
  {
    key: 'copy_policy',
    type: 'COPY_POLICY',
    enabled: true,
    params: { maxHeadline: 60, maxBody: 280, bannedPhrases: ['guaranteed', 'last chance ever', 'risk-free', 'act now or lose'] },
  },
] as Rule[];
