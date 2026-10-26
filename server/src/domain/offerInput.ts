import { z } from 'zod';
import { OFFER_TYPES, OfferEligibilitySchema, OfferTermsSchema, type OfferTerms, type OfferType } from './types';

/**
 * Fields an admin may set. Counters, status and version are server-owned.
 * Deliberately no defaults here: an edit must never fill in values the admin did not send
 * (a default would silently overwrite e.g. the offer's eligibility). Defaults apply on create only.
 */
const fields = {
  name: z.string().trim().min(3, 'Name needs at least 3 characters').max(80),
  description: z.string().trim().max(500),
  type: z.enum(OFFER_TYPES),
  terms: OfferTermsSchema,
  eligibility: OfferEligibilitySchema,
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  grantValidityHours: z.number().int().min(1).max(720),
  priority: z.number().int().min(0).max(100),
  stackable: z.boolean(),
  budgetTotalPaise: z.number().int().min(100, 'Budget must be at least ₹1'),
  maxGrants: z.number().int().min(1).max(100_000),
  maxGrantsPerCustomer: z.number().int().min(1).max(10),
};
const OfferFieldsSchema = z.object(fields).strict();

/** Commercial terms must match the offer type exactly, so no meaningless or missing value is stored. */
export function termIssues(type: OfferType, terms: OfferTerms): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const need = (field: keyof OfferTerms, message: string) => terms[field] === undefined && out.push({ path: `terms.${field}`, message });
  const forbid = (fields: (keyof OfferTerms)[]) =>
    fields.forEach((f) => terms[f] !== undefined && out.push({ path: `terms.${f}`, message: `Not used by a ${type.replace('_', ' ')} offer` }));
  if (type === 'percent_off') {
    need('percentOff', 'Percentage is required');
    need('maxDiscountPaise', 'A rupee cap is required for percentage discounts');
    forbid(['flatOffPaise', 'bonusPoints']);
  } else if (type === 'flat_off') {
    need('flatOffPaise', 'Discount amount is required');
    forbid(['percentOff', 'maxDiscountPaise', 'bonusPoints']);
  } else if (type === 'bonus_points') {
    need('bonusPoints', 'Number of points is required');
    forbid(['percentOff', 'maxDiscountPaise', 'flatOffPaise']);
  } else {
    forbid(['percentOff', 'maxDiscountPaise', 'flatOffPaise', 'bonusPoints']);
  }
  return out;
}

function refineOffer(o: Partial<z.infer<typeof OfferFieldsSchema>>, ctx: z.RefinementCtx) {
  if (o.validFrom && o.validTo && o.validTo <= o.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'End must be after start' });
  if (o.type && o.terms) for (const i of termIssues(o.type, o.terms)) ctx.addIssue({ code: 'custom', path: i.path.split('.'), message: i.message });
}

export const OfferCreateSchema = z
  .object({
    ...fields,
    code: z.string().regex(/^[A-Z0-9_]{3,24}$/, 'Use 3–24 capital letters, digits or _'),
    description: fields.description.default(''),
    eligibility: fields.eligibility.default({}),
    stackable: fields.stackable.default(false),
    maxGrantsPerCustomer: fields.maxGrantsPerCustomer.default(1),
  })
  .strict()
  .superRefine(refineOffer);
export type OfferCreateInput = z.infer<typeof OfferCreateSchema>;

/** Edits: any subset of fields plus the version being edited (optimistic concurrency). Code is immutable. */
export const OfferUpdateSchema = OfferFieldsSchema.partial()
  .extend({ expectedVersion: z.number().int().min(1) })
  .strict();
export type OfferUpdateInput = z.infer<typeof OfferUpdateSchema>;

/** Changing any of these changes what a customer is promised or who can get it, so the version is bumped. */
export const VERSIONED_FIELDS = ['type', 'terms', 'eligibility', 'validFrom', 'validTo', 'grantValidityHours', 'budgetTotalPaise', 'maxGrants', 'maxGrantsPerCustomer', 'stackable'] as const;
