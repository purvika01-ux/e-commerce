import type { CustomerContext, OfferRecord, OfferType, Segment } from '../domain/types';

/** Deterministic ordering used when the AI is unavailable or its proposals fail validation. */
export function rankFallback(eligible: OfferRecord[]): OfferRecord[] {
  return [...eligible].sort((a, b) => b.priority - a.priority || a.estimatedCostPaise - b.estimatedCostPaise || a.code.localeCompare(b.code));
}

const HEADLINES: Record<OfferType, string> = {
  percent_off: 'A little something to make your next order sweeter',
  flat_off: 'A welcome treat for your first order',
  free_shipping: 'Your next delivery is on us',
  bonus_points: 'A thank-you from all of us',
};

const SEGMENT_LINES: Partial<Record<Segment, string>> = {
  at_risk: "It's been a while and we've missed you.",
  hibernating: "It's been a while and we've missed you.",
  new: "Thanks for joining us — we're glad you're here.",
  champion: "You're one of our favourite shoppers.",
  loyal: "Thanks for shopping with us so often.",
  window_shopper: 'We noticed you found a few things you liked.',
  price_sensitive: 'We know you love a good deal.',
  promising: 'We think you will love what is new this week.',
};

/** Template copy. Contains no numbers or terms; the renderer appends terms from the offer snapshot. */
export function templateCopy(offer: OfferRecord, customer: CustomerContext): { headline: string; body: string } {
  const opener = customer.features.openCart
    ? 'You left some great picks in your cart.'
    : (SEGMENT_LINES[customer.segment] ?? 'We picked this especially for you.');
  const closer = offer.type === 'bonus_points' ? 'Enjoy your bonus on us.' : 'Tap below to claim it while it lasts.';
  return { headline: HEADLINES[offer.type], body: `${opener} ${closer}` };
}
