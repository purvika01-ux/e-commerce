import { z } from 'zod';

export const CATEGORIES = ['electronics', 'fashion', 'grocery', 'home', 'beauty'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PERSONAS = [
  'loyal_high_value',
  'deal_seeker',
  'new_customer',
  'at_risk',
  'dormant',
  'cart_abandoner',
  'window_shopper',
  'occasional',
] as const;
export type Persona = (typeof PERSONAS)[number];

export const SEGMENTS = [
  'champion',
  'loyal',
  'promising',
  'new',
  'at_risk',
  'hibernating',
  'price_sensitive',
  'window_shopper',
] as const;
export type Segment = (typeof SEGMENTS)[number];

export const OFFER_TYPES = ['percent_off', 'flat_off', 'free_shipping', 'bonus_points'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
export const DISCOUNT_TYPES: OfferType[] = ['percent_off', 'flat_off'];

export const OFFER_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export interface OpenCart {
  cartId: string;
  valuePaise: number;
  categories: Category[];
  updatedAt: Date;
}

export interface CustomerFeatures {
  recencyDays: number | null;
  frequency90d: number;
  monetary90dPaise: number;
  aovPaise: number;
  churnRisk: number;
  purchaseProbability7d: number;
  discountSensitivity: number;
  returnRate: number;
  cartAbandonRate: number;
  daysSinceSignup: number;
  lastOrderAt: Date | null;
  lastActiveAt: Date | null;
  openCart: OpenCart | null;
}

/** The customer view used by eligibility and validation. It never includes name, city or age. */
export interface CustomerContext {
  id: string;
  externalRef: string;
  segment: Segment;
  features: CustomerFeatures;
  rewardPoints: { balance: number; expiringPoints: number; expiresAt: Date | null };
  preferredCategories: Category[];
  optedOut: boolean;
}

/** Commercial terms are edited by humans only; the AI never sees an editable form of these. */
export const OfferTermsSchema = z
  .object({
    percentOff: z.number().int().min(1).max(90).optional(),
    maxDiscountPaise: z.number().int().positive().optional(),
    flatOffPaise: z.number().int().positive().optional(),
    bonusPoints: z.number().int().positive().optional(),
    minOrderPaise: z.number().int().min(0),
    categories: z.array(z.enum(CATEGORIES)).optional(),
  })
  .strict();
export type OfferTerms = z.infer<typeof OfferTermsSchema>;

export const OfferEligibilitySchema = z
  .object({
    segments: z.array(z.enum(SEGMENTS)).optional(),
    minChurnRisk: z.number().min(0).max(1).optional(),
    maxPurchaseProbability: z.number().min(0).max(1).optional(),
    requiresOpenCart: z.boolean().optional(),
    newCustomersOnly: z.boolean().optional(),
    minRewardPoints: z.number().int().min(0).optional(),
  })
  .strict();
export type OfferEligibility = z.infer<typeof OfferEligibilitySchema>;

export interface OfferRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  status: OfferStatus;
  version: number;
  type: OfferType;
  terms: OfferTerms;
  eligibility: OfferEligibility;
  validFrom: Date;
  validTo: Date;
  grantValidityHours: number;
  priority: number;
  estimatedCostPaise: number;
  stackable: boolean;
  budget: { totalPaise: number; reservedPaise: number; redeemedPaise: number };
  usage: { maxGrants: number; grantsIssued: number; maxGrantsPerCustomer: number; redemptions: number };
}

/** Snapshot stored with an approved decision: what the customer is promised. */
export interface OfferSnapshot {
  offerId: string;
  code: string;
  name: string;
  version: number;
  type: OfferType;
  terms: OfferTerms;
  estimatedCostPaise: number;
  stackable: boolean;
}

export function snapshotOf(o: OfferRecord): OfferSnapshot {
  return {
    offerId: o.id,
    code: o.code,
    name: o.name,
    version: o.version,
    type: o.type,
    terms: o.terms,
    estimatedCostPaise: o.estimatedCostPaise,
    stackable: o.stackable,
  };
}

/** Worst-case liability of one grant, used for budget reservation. */
export function estimateCostPaise(type: OfferType, terms: OfferTerms, assumedBasketPaise = 200000): number {
  switch (type) {
    case 'percent_off': {
      const raw = Math.round((assumedBasketPaise * (terms.percentOff ?? 0)) / 100);
      return terms.maxDiscountPaise ? Math.min(raw, terms.maxDiscountPaise) : raw;
    }
    case 'flat_off':
      return terms.flatOffPaise ?? 0;
    case 'free_shipping':
      return 6000; // ₹60 average shipping cost absorbed
    case 'bonus_points':
      return Math.round((terms.bonusPoints ?? 0) * 25); // 1 point ≈ ₹0.25 liability
  }
}

/** Facts about past offers for one customer, computed fresh from the database under the customer lease. */
export interface ContactStats {
  approvedInWindow: number;
  activeGrants: { offerId: string; type: OfferType; stackable: boolean }[];
  grantsByOffer: Record<string, number>;
}

export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
