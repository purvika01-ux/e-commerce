import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { ruleParams, type RuleSetRecord } from '../domain/rules';
import type { ContactStats, OfferRecord } from '../domain/types';
import { Decision, Offer, toOfferRecord } from '../models';

const DAY = 86_400_000;

/**
 * Atomically reserves worst-case budget and one usage slot. The filter re-checks status, version,
 * validity and headroom inside MongoDB, so concurrent requests can never overspend.
 */
export async function reserveOffer(offer: OfferRecord, now: Date): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cost = offer.estimatedCostPaise;
  const updated = await Offer.findOneAndUpdate(
    {
      _id: offer.id,
      status: 'active',
      version: offer.version,
      validFrom: { $lte: now },
      validTo: { $gt: now },
      $expr: {
        $and: [
          { $lte: [{ $add: ['$budget.reservedPaise', '$budget.redeemedPaise', cost] }, '$budget.totalPaise'] },
          { $lt: ['$usage.grantsIssued', '$usage.maxGrants'] },
        ],
      },
    },
    { $inc: { 'budget.reservedPaise': cost, 'usage.grantsIssued': 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (updated) return { ok: true };

  const current = await Offer.findById(offer.id).lean();
  if (!current) return { ok: false, reason: 'OFFER_NOT_FOUND' };
  const o = toOfferRecord(current);
  if (o.status !== 'active') return { ok: false, reason: 'OFFER_INACTIVE' };
  if (o.version !== offer.version) return { ok: false, reason: 'OFFER_CHANGED' };
  if (o.validTo <= now || o.validFrom > now) return { ok: false, reason: 'OFFER_EXPIRED' };
  if (o.usage.grantsIssued >= o.usage.maxGrants) return { ok: false, reason: 'USAGE_LIMIT' };
  return { ok: false, reason: 'BUDGET_EXHAUSTED' };
}

/** Returns a reservation. Guarded so counters can never go negative. */
export async function releaseReservation(offerId: string, costPaise: number, opts: { releaseUsage: boolean }): Promise<void> {
  const inc: Record<string, number> = { 'budget.reservedPaise': -costPaise };
  const filter: Record<string, unknown> = { _id: offerId, 'budget.reservedPaise': { $gte: costPaise } };
  if (opts.releaseUsage) {
    inc['usage.grantsIssued'] = -1;
    filter['usage.grantsIssued'] = { $gte: 1 };
  }
  await Offer.updateOne(filter, { $inc: inc });
}

/** Per-customer offer history, computed fresh. excludeDecisionId lets a pre-send recheck ignore itself. */
export async function computeContactStats(customerId: string, ruleSet: RuleSetRecord, now: Date, excludeDecisionId?: string): Promise<ContactStats> {
  const windowDays = ruleParams(ruleSet, 'FREQUENCY_CAP')?.windowDays ?? 7;
  const base: Record<string, unknown> = { customerId: new Types.ObjectId(customerId), status: 'approved' };
  if (excludeDecisionId) base._id = { $ne: new Types.ObjectId(excludeDecisionId) };

  const [approvedInWindow, active, all] = await Promise.all([
    Decision.countDocuments({ ...base, decidedAt: { $gte: new Date(now.getTime() - windowDays * DAY) } }),
    Decision.find({ ...base, 'grant.status': { $in: ['issued', 'claimed'] }, 'grant.expiresAt': { $gt: now } }, { offerSnapshot: 1 }).lean(),
    Decision.find(base, { offerSnapshot: 1 }).lean(),
  ]);
  const grantsByOffer: Record<string, number> = {};
  for (const d of all) {
    const id = (d.offerSnapshot as any)?.offerId;
    if (id) grantsByOffer[id] = (grantsByOffer[id] ?? 0) + 1;
  }
  return {
    approvedInWindow,
    activeGrants: active.map((d) => ({
      offerId: (d.offerSnapshot as any).offerId,
      type: (d.offerSnapshot as any).type,
      stackable: Boolean((d.offerSnapshot as any).stackable),
    })),
    grantsByOffer,
  };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newGrantCode(): string {
  const bytes = randomBytes(6);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `OFR-${chars.slice(0, 4)}-${chars.slice(4)}`;
}
