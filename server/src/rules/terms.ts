import { rupees, type OfferSnapshot, type OfferTerms, type OfferType } from '../domain/types';

/** Human-readable commercial terms, generated deterministically from the offer definition. */
export function termsHeadline(type: OfferType, t: OfferTerms): string {
  switch (type) {
    case 'percent_off':
      return `${t.percentOff}% off${t.maxDiscountPaise ? ` (up to ${rupees(t.maxDiscountPaise)})` : ''}`;
    case 'flat_off':
      return `${rupees(t.flatOffPaise ?? 0)} off`;
    case 'free_shipping':
      return 'Free shipping';
    case 'bonus_points':
      return `${t.bonusPoints} bonus reward points`;
  }
}

export function termsConditions(t: OfferTerms): string {
  const parts: string[] = [];
  if (t.minOrderPaise > 0) parts.push(`Min. order ${rupees(t.minOrderPaise)}`);
  if (t.categories?.length) parts.push(`${t.categories.join(', ')} only`);
  return parts.join(' · ') || 'No minimum order';
}

export function termsSummary(s: Pick<OfferSnapshot, 'type' | 'terms'>): string {
  return `${termsHeadline(s.type, s.terms)} — ${termsConditions(s.terms)}`;
}

export function formatIst(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}
