import type { CustomerContext, OfferRecord } from '../domain/types';
import { termsSummary } from '../rules/terms';
import type { AiCandidate } from './types';

const rupees = (paise: number) => Math.round(paise / 100);

/**
 * The permitted synthetic context for one customer. Deliberately excludes name, city, age band,
 * persona (ground truth) and anything about other customers.
 */
export function permittedContext(c: CustomerContext, now: Date): Record<string, unknown> {
  const f = c.features;
  const pointsExpireInDays = c.rewardPoints.expiresAt ? Math.ceil((c.rewardPoints.expiresAt.getTime() - now.getTime()) / 86_400_000) : null;
  return {
    segment: c.segment,
    daysSinceLastOrder: f.recencyDays,
    ordersLast90Days: f.frequency90d,
    averageOrderValueRupees: rupees(f.aovPaise),
    churnRisk: f.churnRisk,
    purchaseProbabilityNext7Days: f.purchaseProbability7d,
    discountSensitivity: f.discountSensitivity,
    cartAbandonRate: f.cartAbandonRate,
    daysSinceSignup: f.daysSinceSignup,
    openCart: f.openCart ? { valueRupees: rupees(f.openCart.valuePaise), categories: f.openCart.categories } : null,
    rewardPoints: { balance: c.rewardPoints.balance, expiringPoints: c.rewardPoints.expiringPoints, expireInDays: pointsExpireInDays },
    preferredCategories: c.preferredCategories,
  };
}

export function toAiCandidate(o: OfferRecord): AiCandidate {
  return { offerId: o.id, code: o.code, name: o.name, type: o.type, terms: termsSummary(o), purpose: o.description };
}
