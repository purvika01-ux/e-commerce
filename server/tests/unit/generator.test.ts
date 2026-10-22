import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../src/data/generator';
import { PERSONAS } from '../../src/domain/types';

const now = new Date('2026-10-22T10:00:00.000Z');

describe('synthetic data generator', () => {
  const data = generateDataset({ seed: 42, count: 120, now });

  it('is reproducible for the same seed and differs for another seed', () => {
    expect(JSON.stringify(generateDataset({ seed: 42, count: 120, now }))).toBe(JSON.stringify(data));
    expect(JSON.stringify(generateDataset({ seed: 7, count: 120, now }))).not.toBe(JSON.stringify(data));
  });

  it('covers every persona and only produces past events', () => {
    for (const p of PERSONAS) expect(data.filter((c) => c.persona === p).length).toBeGreaterThanOrEqual(2);
    expect(data.every((c) => c.events.every((e) => e.occurredAt.getTime() <= now.getTime()))).toBe(true);
  });

  it('behaves like real customer data (skewed revenue, frequent cart abandonment)', () => {
    const revenue = data
      .map((c) => c.events.filter((e) => e.type === 'order_placed').reduce((s, e) => s + e.payload.totalPaise, 0))
      .sort((a, b) => b - a);
    const total = revenue.reduce((a, b) => a + b, 0);
    const top20 = revenue.slice(0, Math.round(data.length * 0.2)).reduce((a, b) => a + b, 0);
    expect(top20 / total).toBeGreaterThan(0.55);

    let carts = 0;
    let abandoned = 0;
    for (const c of data) {
      const n = new Set(c.events.filter((e) => e.type === 'cart_add').map((e) => e.payload.cartId)).size;
      carts += n;
      abandoned += c.features.cartAbandonRate * n;
    }
    expect(abandoned / carts).toBeGreaterThan(0.45);
    expect(abandoned / carts).toBeLessThan(0.85);
  });

  it('separates personas in derived features', () => {
    const avg = (persona: string, pick: (f: (typeof data)[number]['features']) => number) => {
      const xs = data.filter((c) => c.persona === persona).map((c) => pick(c.features));
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(avg('loyal_high_value', (f) => f.frequency90d)).toBeGreaterThan(avg('window_shopper', (f) => f.frequency90d) + 2);
    expect(avg('at_risk', (f) => f.churnRisk)).toBeGreaterThan(avg('loyal_high_value', (f) => f.churnRisk));
    // A new shopper who already ordered twice is realistically "promising", so require most, not all.
    const fresh = data.filter((c) => c.persona === 'new_customer');
    expect(fresh.filter((c) => c.segment === 'new').length / fresh.length).toBeGreaterThan(0.75);
  });
});
