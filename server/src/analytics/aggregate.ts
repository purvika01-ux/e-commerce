import type { PipelineStage } from 'mongoose';
import { Decision, Delivery, EngagementEvent, Offer } from '../models';
import { DAY_MS, dayKeys, istDayKey, MAX_SPAN_DAYS, startOfIstDay, TIMEZONE, type AnalyticsFilters } from './filters';

/**
 * Campaign analytics, computed in MongoDB from persisted records only.
 *
 * Everything is a cohort of decisions made in the selected window: deliveries, button taps and
 * budget releases that happened later are attributed back to their decision. That keeps every
 * filter (dates, segment, offer, origin) consistent across all figures.
 *
 * De-duplication: each decision is one row (triggers are idempotent, one decision per trigger);
 * deliveries and engagement events are collapsed per decision before counting, so a retried send,
 * a replayed button tap or a duplicate event row can never count twice.
 */

export interface Rate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0 — never shown as 0%. */
  value: number | null;
  /** Fewer than SMALL_SAMPLE observations: the rate is too noisy to compare. */
  smallSample: boolean;
}
export const SMALL_SAMPLE = 10;
export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
  smallSample: denominator < SMALL_SAMPLE,
});

const sumIf = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });

/** Decision-level match shared by every facet. Previews and test data are never counted. */
export function decisionMatch(f: AnalyticsFilters): Record<string, unknown> {
  const m: Record<string, unknown> = {
    preview: { $ne: true },
    status: { $ne: 'dry_run' },
    dataOrigin: f.origin === 'all' ? { $ne: 'test' } : f.origin,
    decidedAt: { ...(f.from ? { $gte: f.from } : {}), $lt: f.to },
  };
  if (f.segment) m['contextSnapshot.segment'] = f.segment;
  if (f.offer) m['offerSnapshot.code'] = f.offer;
  return m;
}

function pipeline(f: AnalyticsFilters): PipelineStage[] {
  return [
    { $match: decisionMatch(f) },
    // At most one delivery per decision (unique idempotency key), but collapse defensively anyway.
    {
      $lookup: {
        from: Delivery.collection.name,
        localField: '_id',
        foreignField: 'decisionId',
        as: 'dl',
        pipeline: [{ $project: { _id: 0, status: 1, failureReason: 1, attemptCount: { $size: { $ifNull: ['$attempts', []] } } } }],
      },
    },
    // Distinct event types per decision: duplicate rows collapse to one.
    {
      $lookup: {
        from: EngagementEvent.collection.name,
        localField: '_id',
        foreignField: 'decisionId',
        as: 'ev',
        pipeline: [{ $group: { _id: '$type' } }],
      },
    },
    {
      $addFields: {
        segment: { $ifNull: ['$contextSnapshot.segment', 'unknown'] },
        dStatuses: '$dl.status',
        evTypes: '$ev._id',
        issued: { $and: [{ $in: ['$status', ['approved', 'cancelled']] }, { $ne: [{ $ifNull: ['$offerSnapshot', null] }, null] }] },
        attemptCount: { $ifNull: [{ $max: '$dl.attemptCount' }, 0] },
        day: { $dateToString: { format: '%Y-%m-%d', date: '$decidedAt', timezone: TIMEZONE } },
      },
    },
    {
      $addFields: {
        sent: { $in: ['sent', '$dStatuses'] },
        failed: { $and: [{ $not: [{ $in: ['sent', '$dStatuses'] }] }, { $in: ['failed_permanent', '$dStatuses'] }] },
        precheck: {
          $and: [{ $not: [{ $in: ['sent', '$dStatuses'] }] }, { $not: [{ $in: ['failed_permanent', '$dStatuses'] }] }, { $in: ['cancelled_precheck', '$dStatuses'] }],
        },
        inFlight: {
          $and: [
            { $gt: [{ $size: { $setIntersection: ['$dStatuses', ['sending', 'failed_retryable']] } }, 0] },
            { $eq: [{ $size: { $setIntersection: ['$dStatuses', ['sent', 'failed_permanent', 'cancelled_precheck']] } }, 0] },
          ],
        },
        notSent: { $and: ['$issued', { $eq: [{ $size: '$dStatuses' }, 0] }] },
        failureReason: { $arrayElemAt: ['$dl.failureReason', 0] },
        costPaise: { $cond: ['$issued', { $ifNull: ['$offerSnapshot.estimatedCostPaise', 0] }, 0] },
        grantStatus: { $ifNull: ['$grant.status', null] },
      },
    },
    {
      $addFields: {
        claimed: { $and: ['$sent', { $in: ['claimed', '$evTypes'] }] },
        declined: { $and: ['$sent', { $in: ['declined', '$evTypes'] }] },
        expiredUnanswered: {
          $and: ['$sent', { $in: ['expired', '$evTypes'] }, { $not: [{ $in: ['claimed', '$evTypes'] }] }, { $not: [{ $in: ['declined', '$evTypes'] }] }],
        },
        releasedPaise: { $cond: [{ $and: ['$issued', { $in: ['$grantStatus', ['declined', 'expired', 'void']] }] }, '$costPaise', 0] },
        heldPaise: { $cond: [{ $and: [{ $eq: ['$status', 'approved'] }, { $in: ['$grantStatus', ['issued', 'claimed']] }] }, '$costPaise', 0] },
        redeemed: { $eq: ['$grantStatus', 'redeemed'] },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              decisions: { $sum: 1 },
              issued: sumIf('$issued'),
              stillApproved: sumIf({ $eq: ['$status', 'approved'] }),
              cancelled: sumIf({ $eq: ['$status', 'cancelled'] }),
              noOffer: sumIf({ $eq: ['$status', 'no_offer'] }),
              rejected: sumIf({ $eq: ['$status', 'rejected'] }),
              errors: sumIf({ $in: ['$status', ['error', 'pending']] }),
              delivered: sumIf('$sent'),
              deliveryFailed: sumIf('$failed'),
              precheckCancelled: sumIf('$precheck'),
              deliveryInFlight: sumIf('$inFlight'),
              notSent: sumIf('$notSent'),
              claimed: sumIf('$claimed'),
              declined: sumIf('$declined'),
              expiredUnanswered: sumIf('$expiredUnanswered'),
              redeemed: sumIf('$redeemed'),
              retried: sumIf({ $and: [{ $gt: ['$attemptCount', 1] }, { $or: ['$sent', '$failed'] }] }),
              recoveredByRetry: sumIf({ $and: ['$sent', { $gt: ['$attemptCount', 1] }] }),
              extraAttempts: { $sum: { $max: [{ $subtract: ['$attemptCount', 1] }, 0] } },
              pathAi: sumIf({ $and: ['$issued', { $eq: ['$path', 'ai'] }] }),
              pathAiRetry: sumIf({ $and: ['$issued', { $eq: ['$path', 'ai_retry'] }] }),
              pathFallback: sumIf({ $and: ['$issued', { $eq: ['$path', 'fallback'] }] }),
              reservedPaise: { $sum: '$costPaise' },
              releasedPaise: { $sum: '$releasedPaise' },
              heldPaise: { $sum: '$heldPaise' },
              customers: { $addToSet: '$customerId' },
              reached: { $addToSet: { $cond: ['$sent', '$customerId', '$$REMOVE'] } },
              claimers: { $addToSet: { $cond: ['$claimed', '$customerId', '$$REMOVE'] } },
            },
          },
          { $project: { _id: 0, customers: { $size: '$customers' }, reached: { $size: '$reached' }, claimers: { $size: '$claimers' }, doc: '$$ROOT' } },
        ],
        origins: [{ $group: { _id: '$dataOrigin', count: { $sum: 1 } } }],
        byOffer: [
          { $match: { issued: true } },
          {
            $group: {
              _id: '$offerSnapshot.code',
              name: { $last: '$offerSnapshot.name' },
              issued: { $sum: 1 },
              cancelled: sumIf({ $eq: ['$status', 'cancelled'] }),
              delivered: sumIf('$sent'),
              deliveryFailed: sumIf('$failed'),
              claimed: sumIf('$claimed'),
              declined: sumIf('$declined'),
              expiredUnanswered: sumIf('$expiredUnanswered'),
              reservedPaise: { $sum: '$costPaise' },
              releasedPaise: { $sum: '$releasedPaise' },
              heldPaise: { $sum: '$heldPaise' },
            },
          },
        ],
        bySegment: [
          {
            $group: {
              _id: '$segment',
              decisions: { $sum: 1 },
              issued: sumIf('$issued'),
              noOffer: sumIf({ $eq: ['$status', 'no_offer'] }),
              blocked: sumIf({ $in: ['$status', ['rejected', 'error', 'pending']] }),
              delivered: sumIf('$sent'),
              claimed: sumIf('$claimed'),
              declined: sumIf('$declined'),
              reservedPaise: { $sum: '$costPaise' },
            },
          },
        ],
        daily: [
          {
            $group: {
              _id: '$day',
              decisions: { $sum: 1 },
              issued: sumIf('$issued'),
              noOffer: sumIf({ $eq: ['$status', 'no_offer'] }),
              blocked: sumIf({ $in: ['$status', ['rejected', 'error', 'pending']] }),
              delivered: sumIf('$sent'),
              claimed: sumIf('$claimed'),
            },
          },
        ],
        noOfferReasons: [{ $match: { status: 'no_offer' } }, { $group: { _id: '$outcomeReason', count: { $sum: 1 } } }],
        // Which rules kept offers away, counted once per decision even if several offers hit the same rule.
        exclusionRules: [
          { $match: { status: 'no_offer', outcomeReason: 'NO_ELIGIBLE_OFFERS' } },
          { $unwind: '$excluded' },
          { $unwind: '$excluded.reasons' },
          { $group: { _id: { d: '$_id', rule: '$excluded.reasons.rule' } } },
          { $group: { _id: '$_id.rule', count: { $sum: 1 } } },
        ],
        rejectionRules: [
          { $match: { status: 'rejected' } },
          { $unwind: '$validationHistory' },
          { $match: { 'validationHistory.ok': false } },
          { $unwind: '$validationHistory.violations' },
          { $group: { _id: { d: '$_id', rule: '$validationHistory.violations.rule' } } },
          { $group: { _id: '$_id.rule', count: { $sum: 1 } } },
        ],
        cancellations: [{ $match: { status: 'cancelled' } }, { $group: { _id: '$outcomeReason', count: { $sum: 1 } } }],
        errors: [{ $match: { status: { $in: ['error', 'pending'] } } }, { $group: { _id: { $ifNull: ['$errorCode', '$status'] }, count: { $sum: 1 } } }],
        deliveryFailures: [{ $match: { failed: true } }, { $group: { _id: '$failureReason', count: { $sum: 1 } } }],
        precheckRules: [{ $match: { precheck: true } }, { $group: { _id: '$failureReason', count: { $sum: 1 } } }],
        firstDay: [{ $group: { _id: null, first: { $min: '$decidedAt' } } }],
      },
    },
  ];
}

type Row = { _id: string | null; count: number };
const ranked = (rows: Row[], key = 'reason') =>
  rows
    .map((r) => ({ [key]: r._id ?? 'UNSPECIFIED', count: r.count }))
    .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));

/** Generated vs observed: what each figure is based on. Kept with the data so the UI cannot drift. */
export const PROVENANCE = {
  generated:
    'Decisions, approvals, cancellations and budget reservations are produced by the Offerly decision engine for synthetic customer profiles.',
  observed:
    'Telegram delivery results are the Telegram API’s responses. Claims and declines are real button taps by classmates using a synthetic profile — interest signals, not purchases.',
  simulated: 'Nothing on this page is simulated. Customer profiles and their purchase histories are synthetic seed data and are not used as outcomes here.',
};

/** Metrics the brief invites but the stored data cannot support. Reported instead of being estimated. */
export const UNSUPPORTED = [
  {
    metric: 'Redemptions and completed purchases',
    reason: 'There is no store or checkout, so nothing records an offer code being used at purchase. No grant is ever marked "redeemed".',
    needed: 'An order or redemption event that carries the grant code.',
  },
  {
    metric: 'Revenue, order value and discount actually spent',
    reason: 'Budget figures are worst-case reservations (the most an offer could cost), not money spent.',
    needed: 'Orders linked to grants, with basket value and the discount applied.',
  },
  {
    metric: 'Incremental conversions or lift (causal impact)',
    reason: 'There is no randomised holdout or control group, so a claim rate cannot be compared with what would have happened without an offer.',
    needed: 'A holdout group that is eligible but deliberately not sent an offer, plus purchase outcomes for both groups.',
  },
  {
    metric: 'Message opens or read rate',
    reason: 'The Telegram Bot API does not report when a message is read.',
    needed: 'Not available from Telegram; button taps are the only engagement signal.',
  },
  {
    metric: 'Manual delivery retries',
    reason: 'Failed sends are retried automatically within the same delivery (network errors and rate limits only); there is no manual retry action yet.',
    needed: 'A retry endpoint that records each manual attempt.',
  },
];

export async function computeAnalytics(f: AnalyticsFilters, now: Date) {
  const [facet] = await Decision.aggregate(pipeline(f));
  const offers = await Offer.find(f.offer ? { code: f.offer } : {}, { code: 1, name: 1, status: 1, validTo: 1, budget: 1, usage: 1 }).lean();

  const t = facet.totals[0] ? { ...facet.totals[0].doc, customers: facet.totals[0].customers, reached: facet.totals[0].reached, claimers: facet.totals[0].claimers } : null;
  const n = (k: string): number => (t ? Number(t[k] ?? 0) : 0);

  // Daily series: every IST day in the window, zero-filled. "All time" starts at the first decision.
  const firstDecision: Date | null = facet.firstDay[0]?.first ? new Date(facet.firstDay[0].first) : null;
  let seriesFrom = f.from ?? (firstDecision ? startOfIstDay(firstDecision) : startOfIstDay(now));
  const truncated = (f.to.getTime() - seriesFrom.getTime()) / DAY_MS > MAX_SPAN_DAYS;
  if (truncated) seriesFrom = new Date(f.to.getTime() - MAX_SPAN_DAYS * DAY_MS);
  const byDay = new Map<string, Record<string, number>>((facet.daily as Record<string, any>[]).map((d) => [d._id, d]));
  const points = dayKeys(seriesFrom, f.to).map((date) => {
    const d = byDay.get(date);
    return { date, decisions: d?.decisions ?? 0, issued: d?.issued ?? 0, noOffer: d?.noOffer ?? 0, blocked: d?.blocked ?? 0, delivered: d?.delivered ?? 0, claimed: d?.claimed ?? 0 };
  });

  // Offer comparison: offers active now plus any offer issued in the window.
  const activity = new Map<string, Record<string, any>>((facet.byOffer as Record<string, any>[]).map((o) => [o._id, o]));
  const byOffer = offers
    .filter((o) => activity.has(o.code) || (o.status === 'active' && new Date(o.validTo) > now))
    .map((o) => {
      const a = activity.get(o.code) ?? {};
      const delivered = a.delivered ?? 0;
      const total = o.budget?.totalPaise ?? 0;
      const reservedNow = o.budget?.reservedPaise ?? 0;
      const redeemedNow = o.budget?.redeemedPaise ?? 0;
      return {
        code: o.code,
        name: o.name,
        status: o.status !== 'archived' && new Date(o.validTo) <= now ? 'expired' : o.status,
        issued: a.issued ?? 0,
        cancelled: a.cancelled ?? 0,
        delivered,
        deliveryFailed: a.deliveryFailed ?? 0,
        claimed: a.claimed ?? 0,
        declined: a.declined ?? 0,
        expiredUnanswered: a.expiredUnanswered ?? 0,
        claimRate: rate(a.claimed ?? 0, delivered),
        cohortBudget: { reservedPaise: a.reservedPaise ?? 0, releasedPaise: a.releasedPaise ?? 0, heldPaise: a.heldPaise ?? 0 },
        currentBudget: { totalPaise: total, reservedPaise: reservedNow, redeemedPaise: redeemedNow, remainingPaise: Math.max(0, total - reservedNow - redeemedNow) },
      };
    })
    .sort((a, b) => b.issued - a.issued || a.code.localeCompare(b.code));
  // Activity for offers that no longer exist (should not happen; archived offers are kept) is still reported.
  for (const [code, a] of activity) {
    if (byOffer.some((o) => o.code === code)) continue;
    byOffer.push({
      code,
      name: a.name ?? code,
      status: 'unknown',
      issued: a.issued,
      cancelled: a.cancelled,
      delivered: a.delivered,
      deliveryFailed: a.deliveryFailed,
      claimed: a.claimed,
      declined: a.declined,
      expiredUnanswered: a.expiredUnanswered,
      claimRate: rate(a.claimed, a.delivered),
      cohortBudget: { reservedPaise: a.reservedPaise, releasedPaise: a.releasedPaise, heldPaise: a.heldPaise },
      currentBudget: { totalPaise: 0, reservedPaise: 0, redeemedPaise: 0, remainingPaise: 0 },
    });
  }

  const bySegment = (facet.bySegment as Record<string, any>[])
    .map((s) => ({
      segment: s._id as string,
      decisions: s.decisions,
      issued: s.issued,
      noOffer: s.noOffer,
      blocked: s.blocked,
      delivered: s.delivered,
      claimed: s.claimed,
      declined: s.declined,
      reservedPaise: s.reservedPaise,
      approvalRate: rate(s.issued, s.decisions),
      claimRate: rate(s.claimed, s.delivered),
    }))
    .sort((a, b) => b.decisions - a.decisions || a.segment.localeCompare(b.segment));

  // Pre-send cancellations store the failed rules as "RULE_A, RULE_B".
  const precheck = new Map<string, number>();
  for (const r of facet.precheckRules as Row[]) {
    for (const rule of String(r._id ?? 'UNSPECIFIED').split(',').map((s) => s.trim()).filter(Boolean)) precheck.set(rule, (precheck.get(rule) ?? 0) + r.count);
  }

  const live = offers.filter((o) => o.status === 'active' && new Date(o.validTo) > now);
  const sum = (xs: typeof offers, k: 'totalPaise' | 'reservedPaise' | 'redeemedPaise') => xs.reduce((s, o) => s + (o.budget?.[k] ?? 0), 0);
  const attempted = n('delivered') + n('deliveryFailed');

  return {
    filters: {
      range: f.range,
      from: f.from?.toISOString() ?? null,
      to: f.to.toISOString(),
      fromDay: f.from ? istDayKey(f.from) : firstDecision ? istDayKey(firstDecision) : null,
      toDay: istDayKey(new Date(f.to.getTime() - 1)),
      timezone: TIMEZONE,
      segment: f.segment,
      offer: f.offer,
      origin: f.origin,
    },
    generatedAt: now.toISOString(),
    empty: n('decisions') === 0,
    totals: {
      decisions: n('decisions'),
      customers: n('customers'),
      issued: n('issued'),
      stillApproved: n('stillApproved'),
      cancelled: n('cancelled'),
      noOffer: n('noOffer'),
      rejected: n('rejected'),
      errors: n('errors'),
      delivered: n('delivered'),
      customersReached: n('reached'),
      claimed: n('claimed'),
      customersClaimed: n('claimers'),
      declined: n('declined'),
      expiredUnanswered: n('expiredUnanswered'),
      redeemed: n('redeemed'),
      paths: { ai: n('pathAi'), aiRetry: n('pathAiRetry'), fallback: n('pathFallback') },
    },
    rates: {
      approval: rate(n('issued'), n('decisions')),
      deliverySuccess: rate(n('delivered'), attempted),
      claim: rate(n('claimed'), n('delivered')),
      decline: rate(n('declined'), n('delivered')),
      noResponse: rate(n('expiredUnanswered'), n('delivered')),
    },
    delivery: {
      attempted,
      sent: n('delivered'),
      failed: n('deliveryFailed'),
      precheckCancelled: n('precheckCancelled'),
      inFlight: n('deliveryInFlight'),
      notSent: n('notSent'),
      retried: n('retried'),
      recoveredByRetry: n('recoveredByRetry'),
      extraAttempts: n('extraAttempts'),
      failureReasons: ranked(facet.deliveryFailures),
      precheckRules: [...precheck].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    },
    budget: {
      cohort: { reservedPaise: n('reservedPaise'), releasedPaise: n('releasedPaise'), heldPaise: n('heldPaise'), redeemedPaise: 0 },
      current: {
        offers: live.length,
        totalPaise: sum(live, 'totalPaise'),
        reservedPaise: sum(live, 'reservedPaise'),
        redeemedPaise: sum(live, 'redeemedPaise'),
        remainingPaise: Math.max(0, sum(live, 'totalPaise') - sum(live, 'reservedPaise') - sum(live, 'redeemedPaise')),
      },
    },
    reasons: {
      noOffer: ranked(facet.noOfferReasons),
      exclusionRules: ranked(facet.exclusionRules, 'rule'),
      rejectionRules: ranked(facet.rejectionRules, 'rule'),
      cancellations: ranked(facet.cancellations),
      errors: ranked(facet.errors),
    },
    byOffer,
    bySegment,
    daily: { timezone: TIMEZONE, truncated, points },
    origins: Object.fromEntries((facet.origins as Row[]).map((o) => [o._id ?? 'unknown', o.count])),
    provenance: PROVENANCE,
    unsupported: UNSUPPORTED,
    smallSampleThreshold: SMALL_SAMPLE,
  };
}

export type AnalyticsReport = Awaited<ReturnType<typeof computeAnalytics>>;
