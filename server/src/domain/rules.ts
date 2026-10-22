import { z } from 'zod';
import { OFFER_TYPES, SEGMENTS } from './types';

/**
 * Rule-type catalogue. Marketing users edit params and the enabled flag; new rule *types* need code,
 * which keeps enforcement exact. Labels are the plain-language text shown in the dashboard.
 */
export const RULE_CATALOG = {
  MAX_DISCOUNT_PERCENT: {
    params: z.object({ maxPercent: z.number().int().min(1).max(90) }).strict(),
    label: (p: { maxPercent: number }) => `No offer may give more than ${p.maxPercent}% off`,
    help: 'Caps percentage discounts. Offers above this are never sent.',
  },
  MAX_DISCOUNT_AMOUNT: {
    params: z.object({ maxPaise: z.number().int().min(100) }).strict(),
    label: (p: { maxPaise: number }) => `No single offer may be worth more than ₹${p.maxPaise / 100}`,
    help: 'Caps the rupee value of a discount (flat amount, or the maximum of a % discount).',
  },
  MIN_ORDER_FOR_DISCOUNT: {
    params: z.object({ minPaise: z.number().int().min(0) }).strict(),
    label: (p: { minPaise: number }) => `Discounts need a minimum basket of ₹${p.minPaise / 100}`,
    help: "An offer's minimum order must be at least this amount.",
  },
  FREQUENCY_CAP: {
    params: z.object({ maxOffers: z.number().int().min(1).max(20), windowDays: z.number().int().min(1).max(90) }).strict(),
    label: (p: { maxOffers: number; windowDays: number }) => `At most ${p.maxOffers} offers per customer every ${p.windowDays} days`,
    help: 'Prevents over-messaging the same customer.',
  },
  PURCHASE_COOLDOWN: {
    params: z.object({ days: z.number().int().min(0).max(60) }).strict(),
    label: (p: { days: number }) => `Don't send discounts within ${p.days} days of a purchase`,
    help: 'Someone who just bought does not need a discount to buy.',
  },
  NO_STACKING: {
    params: z
      .object({ maxActiveGrants: z.number().int().min(1).max(5), stackableTypes: z.array(z.enum(OFFER_TYPES)) })
      .strict(),
    label: (p: { maxActiveGrants: number }) => `A customer can hold at most ${p.maxActiveGrants} unused offer(s)`,
    help: 'Offers marked stackable whose type is listed here may be held alongside another offer.',
  },
  LIKELY_BUYER_SUPPRESSION: {
    params: z
      .object({ maxPurchaseProbability: z.number().min(0).max(1), appliesToTypes: z.array(z.enum(OFFER_TYPES)) })
      .strict(),
    label: (p: { maxPurchaseProbability: number }) =>
      `Don't give discounts to customers already ${Math.round(p.maxPurchaseProbability * 100)}%+ likely to buy`,
    help: 'Avoids lost margin on customers who would buy anyway.',
  },
  RETURN_ABUSE_EXCLUSION: {
    params: z.object({ maxReturnRate: z.number().min(0).max(1) }).strict(),
    label: (p: { maxReturnRate: number }) => `Skip customers who return more than ${Math.round(p.maxReturnRate * 100)}% of orders`,
    help: 'Protects against serial returners.',
  },
  SEGMENT_EXCLUSION: {
    params: z.object({ segments: z.array(z.enum(SEGMENTS)) }).strict(),
    label: (p: { segments: string[] }) => (p.segments.length ? `Never send offers to: ${p.segments.join(', ')}` : 'No excluded segments'),
    help: 'Segments that must never receive offers.',
  },
  OFFER_EXPIRY_BUFFER: {
    params: z.object({ minHoursRemaining: z.number().min(0).max(168) }).strict(),
    label: (p: { minHoursRemaining: number }) => `Don't send an offer that ends in under ${p.minHoursRemaining} hours`,
    help: 'Avoids sending offers that expire before the customer can use them.',
  },
  COPY_POLICY: {
    params: z
      .object({
        maxHeadline: z.number().int().min(10).max(120),
        maxBody: z.number().int().min(20).max(600),
        bannedPhrases: z.array(z.string().min(1).max(60)).max(50),
      })
      .strict(),
    label: (p: { maxHeadline: number; maxBody: number }) => `Message wording: headline ≤ ${p.maxHeadline} chars, body ≤ ${p.maxBody} chars, no banned phrases`,
    help: 'AI wording rules. Prices, percentages, dates, codes and links are always forbidden in AI wording.',
  },
} as const;

export type RuleType = keyof typeof RULE_CATALOG;
export const RULE_TYPES = Object.keys(RULE_CATALOG) as RuleType[];

export type RuleParams<T extends RuleType> = z.infer<(typeof RULE_CATALOG)[T]['params']>;

export interface Rule<T extends RuleType = RuleType> {
  key: string;
  type: T;
  enabled: boolean;
  params: RuleParams<T>;
}

export interface RuleSetRecord {
  version: number;
  rules: Rule[];
}

const RuleInputSchema = z
  .object({ key: z.string().min(1).max(60), type: z.enum(RULE_TYPES as [RuleType, ...RuleType[]]), enabled: z.boolean(), params: z.unknown() })
  .strict();

/** Validates a whole rule list: known types, params matching each type's schema, unique keys and types. */
export function parseRules(input: unknown): { ok: true; rules: Rule[] } | { ok: false; errors: { path: string; message: string }[] } {
  const list = z.array(RuleInputSchema).min(1).max(50).safeParse(input);
  if (!list.success) {
    return { ok: false, errors: list.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const errors: { path: string; message: string }[] = [];
  const seenKeys = new Set<string>();
  const seenTypes = new Set<string>();
  const rules: Rule[] = [];
  list.data.forEach((r, idx) => {
    if (seenKeys.has(r.key)) errors.push({ path: `${idx}.key`, message: 'Duplicate rule key' });
    if (seenTypes.has(r.type)) errors.push({ path: `${idx}.type`, message: 'Each rule type may appear once' });
    seenKeys.add(r.key);
    seenTypes.add(r.type);
    const params = RULE_CATALOG[r.type].params.safeParse(r.params);
    if (!params.success) {
      for (const i of params.error.issues) errors.push({ path: `${idx}.params.${i.path.join('.')}`, message: i.message });
    } else {
      rules.push({ key: r.key, type: r.type, enabled: r.enabled, params: params.data } as Rule);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, rules };
}

/** Returns the params of an enabled rule of this type, or undefined when absent or disabled. */
export function ruleParams<T extends RuleType>(ruleSet: RuleSetRecord, type: T): RuleParams<T> | undefined {
  const r = ruleSet.rules.find((x) => x.type === type && x.enabled);
  return r ? (r.params as RuleParams<T>) : undefined;
}

export function describeRule(rule: Rule): string {
  const entry = RULE_CATALOG[rule.type] as { label: (p: never) => string };
  return entry.label(rule.params as never);
}
