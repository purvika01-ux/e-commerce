import type { Category, CustomerFeatures, Segment } from '../domain/types';

export interface EventLike {
  type: string;
  occurredAt: Date;
  payload: Record<string, any>;
}

const DAY = 86_400_000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Derives behavioural features from raw synthetic events. Pure: same events + now → same features. */
export function buildFeatures(events: EventLike[], signupAt: Date, now: Date): CustomerFeatures {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const orders = sorted.filter((e) => e.type === 'order_placed');
  const returns = sorted.filter((e) => e.type === 'order_returned');
  const ageDays = (d: Date) => (now.getTime() - d.getTime()) / DAY;

  const lastOrder = orders.at(-1)?.occurredAt ?? null;
  const recencyDays = lastOrder ? Math.floor(ageDays(lastOrder)) : null;
  const orders90 = orders.filter((o) => ageDays(o.occurredAt) <= 90);
  const ordersPrior90 = orders.filter((o) => ageDays(o.occurredAt) > 90 && ageDays(o.occurredAt) <= 180);
  const monetary90 = orders90.reduce((s, o) => s + (o.payload.totalPaise ?? 0), 0);
  const aov = orders.length ? Math.round(orders.reduce((s, o) => s + (o.payload.totalPaise ?? 0), 0) / orders.length) : 0;
  const daysSinceSignup = Math.max(0, Math.floor(ageDays(signupAt)));

  // Churn risk: how overdue the customer is relative to their own buying rhythm, plus any slowdown.
  let churnRisk: number;
  if (!orders.length) {
    churnRisk = daysSinceSignup <= 30 ? 0.3 : 0.6;
  } else {
    const observedDays = Math.max(14, Math.min(180, daysSinceSignup));
    const ordersInWindow = orders.filter((o) => ageDays(o.occurredAt) <= 180).length || 1;
    const expectedGap = Math.max(7, observedDays / ordersInWindow);
    const overdue = (recencyDays ?? 0) / expectedGap;
    const slowdown = ordersPrior90.length > 0 ? clamp01(1 - orders90.length / ordersPrior90.length) : 0;
    churnRisk = clamp01(1 / (1 + Math.exp(-1.7 * (overdue - 2))) * 0.85 + slowdown * 0.25);
  }

  // Carts: group cart_add by cartId; a cart converts if an order references it.
  const cartAdds = sorted.filter((e) => e.type === 'cart_add');
  const carts = new Map<string, { valuePaise: number; categories: Set<Category>; updatedAt: Date }>();
  for (const e of cartAdds) {
    const c = carts.get(e.payload.cartId) ?? { valuePaise: 0, categories: new Set<Category>(), updatedAt: e.occurredAt };
    c.valuePaise += e.payload.pricePaise ?? 0;
    c.categories.add(e.payload.category);
    c.updatedAt = e.occurredAt;
    carts.set(e.payload.cartId, c);
  }
  const convertedCartIds = new Set(orders.map((o) => o.payload.cartId).filter(Boolean));
  const abandoned = [...carts.entries()].filter(([id]) => !convertedCartIds.has(id));
  const cartAbandonRate = carts.size ? abandoned.length / carts.size : 0;
  const recentAbandoned = abandoned
    .filter(([, c]) => ageDays(c.updatedAt) <= 7 && (!lastOrder || c.updatedAt > lastOrder))
    .sort((a, b) => b[1].updatedAt.getTime() - a[1].updatedAt.getTime())[0];

  const discounted = orders.filter((o) => (o.payload.discountPaise ?? 0) > 0).length;
  const discountSensitivity = clamp01(((discounted + 0.5) / (orders.length + 2)) * 0.8 + cartAbandonRate * 0.2);

  const rate = orders90.length / 90;
  const purchaseProbability7d = clamp01((1 - Math.exp(-7 * rate * 2.2)) * (1 - 0.6 * churnRisk) + (recentAbandoned ? 0.08 : 0));

  return {
    recencyDays,
    frequency90d: orders90.length,
    monetary90dPaise: monetary90,
    aovPaise: aov,
    churnRisk: round2(churnRisk),
    purchaseProbability7d: round2(purchaseProbability7d),
    discountSensitivity: round2(discountSensitivity),
    returnRate: orders.length ? round2(returns.length / orders.length) : 0,
    cartAbandonRate: round2(cartAbandonRate),
    daysSinceSignup,
    lastOrderAt: lastOrder,
    lastActiveAt: sorted.at(-1)?.occurredAt ?? null,
    openCart: recentAbandoned
      ? {
          cartId: recentAbandoned[0],
          valuePaise: recentAbandoned[1].valuePaise,
          categories: [...recentAbandoned[1].categories],
          updatedAt: recentAbandoned[1].updatedAt,
        }
      : null,
  };
}

/** Rule-based segmentation from features (order matters: the first match wins). */
export function deriveSegment(f: CustomerFeatures, totalOrders: number): Segment {
  if (f.daysSinceSignup <= 30 && totalOrders <= 1) return 'new';
  if (totalOrders <= 1 && f.cartAbandonRate >= 0.75) return 'window_shopper';
  if (f.recencyDays !== null && f.recencyDays >= 90) return 'hibernating';
  if (f.churnRisk >= 0.55) return 'at_risk';
  if (f.frequency90d >= 5 && f.monetary90dPaise >= 1_500_000) return 'champion';
  if (f.discountSensitivity >= 0.5) return 'price_sensitive';
  if (f.frequency90d >= 3) return 'loyal';
  return 'promising';
}
