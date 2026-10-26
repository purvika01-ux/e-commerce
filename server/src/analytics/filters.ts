import { z } from 'zod';
import { SEGMENTS } from '../domain/types';
import { badRequest } from '../infra/errors';

/** Analytics days are calendar days in India Standard Time (UTC+05:30, no daylight saving). */
export const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60_000;
export const DAY_MS = 86_400_000;
/** Longest span a single report (and its daily series) may cover. */
export const MAX_SPAN_DAYS = 366;

export const AnalyticsQuerySchema = z
  .object({
    range: z.enum(['7d', '30d', '90d', 'all', 'custom']).default('30d'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
    segment: z.enum(SEGMENTS).optional(),
    offer: z.string().regex(/^[A-Z0-9_]{3,24}$/, 'Offer code').optional(),
    origin: z.enum(['all', 'classmate', 'admin']).default('all'),
  })
  .strict();
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

export interface AnalyticsFilters {
  range: AnalyticsQuery['range'];
  /** Inclusive lower bound (start of an IST day), or null for all time. */
  from: Date | null;
  /** Exclusive upper bound (start of the IST day after the last included day). */
  to: Date;
  segment: AnalyticsQuery['segment'] | null;
  offer: string | null;
  origin: AnalyticsQuery['origin'];
}

/** Start of the IST calendar day containing `d`, as a UTC instant. */
export function startOfIstDay(d: Date): Date {
  return new Date(Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** IST calendar date (YYYY-MM-DD) for an instant. */
export function istDayKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of a YYYY-MM-DD IST day, as a UTC instant. */
function istDayStart(key: string): Date {
  const utcMidnight = Date.parse(`${key}T00:00:00.000Z`);
  if (Number.isNaN(utcMidnight) || new Date(utcMidnight).toISOString().slice(0, 10) !== key) throw badRequest(`"${key}" is not a real date`);
  return new Date(utcMidnight - IST_OFFSET_MS);
}

/**
 * Turns query parameters into exact boundaries. Preset ranges are whole IST days ending today
 * ("7d" = today and the six days before it), so every filter and chart shares the same window.
 */
export function resolveFilters(q: AnalyticsQuery, now: Date): AnalyticsFilters {
  const endOfToday = new Date(startOfIstDay(now).getTime() + DAY_MS);
  let from: Date | null;
  let to = endOfToday;
  if (q.range === 'custom') {
    if (!q.from || !q.to) throw badRequest('A custom range needs both "from" and "to" (YYYY-MM-DD)');
    from = istDayStart(q.from);
    to = new Date(istDayStart(q.to).getTime() + DAY_MS);
    if (to <= from) throw badRequest('"from" must be on or before "to"');
    if ((to.getTime() - from.getTime()) / DAY_MS > MAX_SPAN_DAYS) throw badRequest(`A custom range can cover at most ${MAX_SPAN_DAYS} days`);
  } else {
    if (q.from || q.to) throw badRequest('"from" and "to" are only used with range=custom');
    const days = { '7d': 7, '30d': 30, '90d': 90, all: null }[q.range];
    from = days ? new Date(endOfToday.getTime() - days * DAY_MS) : null;
  }
  return { range: q.range, from, to, segment: q.segment ?? null, offer: q.offer ?? null, origin: q.origin };
}

/** Every IST day key in [from, to), oldest first. */
export function dayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  for (let t = startOfIstDay(from).getTime(); t < to.getTime(); t += DAY_MS) keys.push(istDayKey(new Date(t)));
  return keys;
}
