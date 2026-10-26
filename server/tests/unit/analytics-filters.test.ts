import { describe, expect, it } from 'vitest';
import { AnalyticsQuerySchema, dayKeys, istDayKey, resolveFilters, startOfIstDay } from '../../src/analytics/filters';
import { rate } from '../../src/analytics/aggregate';

// 15:30 IST on 22 Oct 2026.
const NOW = new Date('2026-10-22T10:00:00.000Z');
const q = (over: Record<string, unknown> = {}) => AnalyticsQuerySchema.parse(over);

describe('IST day boundaries', () => {
  it('starts the IST day at 18:30 UTC the previous evening', () => {
    expect(startOfIstDay(NOW).toISOString()).toBe('2026-10-21T18:30:00.000Z');
    expect(startOfIstDay(new Date('2026-10-21T18:29:59.999Z')).toISOString()).toBe('2026-10-20T18:30:00.000Z');
    expect(istDayKey(new Date('2026-10-21T18:29:59.999Z'))).toBe('2026-10-21');
    expect(istDayKey(new Date('2026-10-21T18:30:00.000Z'))).toBe('2026-10-22');
  });

  it('preset ranges are whole IST days ending with today', () => {
    const f = resolveFilters(q({ range: '7d' }), NOW);
    expect(f.from!.toISOString()).toBe('2026-10-15T18:30:00.000Z'); // start of 16 Oct IST
    expect(f.to.toISOString()).toBe('2026-10-22T18:30:00.000Z'); // start of 23 Oct IST (exclusive)
    expect(dayKeys(f.from!, f.to)).toHaveLength(7);
    expect(dayKeys(f.from!, f.to)[0]).toBe('2026-10-16');
    expect(resolveFilters(q(), NOW).range).toBe('30d');
    expect(resolveFilters(q({ range: 'all' }), NOW).from).toBeNull();
  });

  it('a custom range includes both end days', () => {
    const f = resolveFilters(q({ range: 'custom', from: '2026-10-01', to: '2026-10-01' }), NOW);
    expect(f.from!.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(f.to.toISOString()).toBe('2026-10-01T18:30:00.000Z');
    expect(dayKeys(f.from!, f.to)).toEqual(['2026-10-01']);
  });

  it('refuses impossible or inconsistent ranges', () => {
    expect(() => resolveFilters(q({ range: 'custom' }), NOW)).toThrow(/needs both/);
    expect(() => resolveFilters(q({ range: 'custom', from: '2026-02-30', to: '2026-03-02' }), NOW)).toThrow(/not a real date/);
    expect(() => resolveFilters(q({ range: 'custom', from: '2026-10-05', to: '2026-10-01' }), NOW)).toThrow(/on or before/);
    expect(() => resolveFilters(q({ range: 'custom', from: '2024-01-01', to: '2026-01-01' }), NOW)).toThrow(/at most/);
    expect(() => resolveFilters(q({ range: '7d', from: '2026-10-01' }), NOW)).toThrow(/only used with/);
    expect(() => q({ range: 'yesterday' })).toThrow();
    expect(() => q({ segment: 'vip' })).toThrow();
    expect(() => q({ extra: '1' })).toThrow();
  });
});

describe('rates', () => {
  it('has no value (rather than 0%) when nothing was observed, and flags small samples', () => {
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null, smallSample: true });
    expect(rate(3, 4)).toMatchObject({ value: 0.75, smallSample: true });
    expect(rate(5, 10)).toMatchObject({ value: 0.5, smallSample: false });
  });
});
