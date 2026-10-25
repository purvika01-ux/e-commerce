import { Types } from 'mongoose';
import { releaseReservation, voidApprovedDecision } from '../decision/ledger';
import type { Clock } from '../decision/orchestrator';
import type { Logger } from '../infra/logger';
import { Decision, Delivery, EngagementEvent, Offer, Trigger } from '../models';

/** Records older than this are treated as abandoned by a crashed or restarted process. */
export const STALE_AFTER_MS = 10 * 60_000;

/**
 * Marks lapsed grants as expired and returns their reserved budget. The usage slot is kept:
 * the grant was issued, so it still counts toward the offer's maxGrants.
 * Each grant is released at most once because the release follows a guarded status transition.
 */
export async function expireGrants(now: Date): Promise<number> {
  const due = await Decision.find(
    { status: 'approved', 'grant.status': { $in: ['issued', 'claimed'] }, 'grant.expiresAt': { $lte: now } },
    { _id: 1 },
  ).lean();
  let expired = 0;
  for (const { _id } of due) {
    const before = await Decision.findOneAndUpdate(
      { _id, status: 'approved', 'grant.status': { $in: ['issued', 'claimed'] }, 'grant.expiresAt': { $lte: now } },
      { $set: { 'grant.status': 'expired' } },
    ).lean();
    if (!before) continue; // claimed, declined or expired by someone else in the meantime
    const s = before.offerSnapshot as { offerId: string; estimatedCostPaise: number };
    await releaseReservation(s.offerId, s.estimatedCostPaise, { releaseUsage: false });
    await EngagementEvent.create({
      decisionId: before._id,
      customerId: before.customerId,
      grantCode: (before.grant as { code: string }).code,
      type: 'expired',
      idempotencyKey: `expired:${(before.grant as { code: string }).code}`,
      occurredAt: now,
      dataOrigin: before.dataOrigin,
    }).catch((err: { code?: number }) => {
      if (err?.code !== 11000) throw err;
    });
    expired++;
  }
  return expired;
}

/**
 * Cleans up work interrupted by a crash. Nothing is ever (re)sent from here:
 * - decisions stuck in "pending" become "error" (they never reached approval);
 * - triggers stuck in "processing" become "failed";
 * - deliveries stuck in "sending" may or may not have reached Telegram, so they are closed as
 *   failed and their decision is voided rather than retried — a possible missing message is
 *   preferred over a possible duplicate.
 */
export async function recoverStuck(now: Date): Promise<{ decisions: number; triggers: number; deliveries: number }> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const decisions = await Decision.updateMany(
    { status: 'pending', decidedAt: { $lt: cutoff } },
    { $set: { status: 'error', errorCode: 'ABANDONED' } },
  );
  const triggers = await Trigger.updateMany(
    { status: { $in: ['received', 'processing'] }, createdAt: { $lt: cutoff } },
    { $set: { status: 'failed', error: { code: 'ABANDONED', message: 'Interrupted before completion' }, completedAt: now } },
  );
  const stuck = await Delivery.find({ status: 'sending', updatedAt: { $lt: cutoff } }, { _id: 1, decisionId: 1 }).lean();
  let deliveries = 0;
  for (const d of stuck) {
    const res = await Delivery.updateOne({ _id: d._id, status: 'sending' }, { status: 'failed_permanent', failureReason: 'INTERRUPTED' });
    if (!res.modifiedCount) continue;
    await voidApprovedDecision(String(d.decisionId), 'DELIVERY_INTERRUPTED');
    deliveries++;
  }
  return { decisions: decisions.modifiedCount, triggers: triggers.modifiedCount, deliveries };
}

export interface ReconcileResult {
  checked: number;
  corrected: { code: string; reservedPaise: [number, number]; grantsIssued: [number, number] }[];
  skipped: string[];
}

/**
 * Recomputes each offer's counters from the decisions that own them and repairs drift
 * (for example a reservation orphaned by a crash). Uses compare-and-set on the counters it read,
 * and skips any offer with an in-flight decision, so it can never erase a live reservation.
 */
export async function reconcileBudgets(): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, corrected: [], skipped: [] };
  const offers = await Offer.find({}, { code: 1, budget: 1, usage: 1 }).lean();
  for (const o of offers) {
    result.checked++;
    const observed = { reserved: o.budget?.reservedPaise ?? 0, issued: o.usage?.grantsIssued ?? 0 };
    const offerId = String(o._id);
    // A pending decision may already hold a reservation that is not yet recorded on it.
    const inFlight = await Decision.exists({ status: 'pending', 'candidates.offerId': offerId });
    if (inFlight) {
      result.skipped.push(o.code);
      continue;
    }
    const [agg] = await Decision.aggregate([
      { $match: { status: 'approved', 'offerSnapshot.offerId': offerId } },
      {
        $group: {
          _id: null,
          issued: { $sum: 1 },
          reserved: {
            $sum: { $cond: [{ $in: ['$grant.status', ['issued', 'claimed']] }, '$offerSnapshot.estimatedCostPaise', 0] },
          },
        },
      },
    ]);
    const expected = { reserved: agg?.reserved ?? 0, issued: agg?.issued ?? 0 };
    if (expected.reserved === observed.reserved && expected.issued === observed.issued) continue;
    const res = await Offer.updateOne(
      { _id: new Types.ObjectId(offerId), 'budget.reservedPaise': observed.reserved, 'usage.grantsIssued': observed.issued },
      { $set: { 'budget.reservedPaise': expected.reserved, 'usage.grantsIssued': expected.issued } },
    );
    if (res.modifiedCount) {
      result.corrected.push({ code: o.code, reservedPaise: [observed.reserved, expected.reserved], grantsIssued: [observed.issued, expected.issued] });
    } else {
      result.skipped.push(o.code); // counters moved while we were checking; try again next run
    }
  }
  return result;
}

export interface MaintenanceState {
  lastRunAt: Date | null;
  lastError: string | null;
  lastResult: Record<string, unknown> | null;
}

/** Runs the jobs on an interval. Runs never overlap; failures are logged and retried next time. */
export function createMaintenance(deps: { clock: Clock; logger: Logger; intervalMs?: number }) {
  const state: MaintenanceState = { lastRunAt: null, lastError: null, lastResult: null };
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const now = deps.clock.now();
      const expired = await expireGrants(now);
      const recovered = await recoverStuck(now);
      const reconciled = await reconcileBudgets();
      state.lastResult = { expired, recovered, corrected: reconciled.corrected, skipped: reconciled.skipped };
      state.lastError = null;
      if (expired || recovered.decisions || recovered.triggers || recovered.deliveries || reconciled.corrected.length) {
        deps.logger.info('maintenance applied changes', state.lastResult);
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : 'unknown error';
      deps.logger.error('maintenance run failed', { error: err });
    } finally {
      state.lastRunAt = deps.clock.now();
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      void runOnce();
      timer = setInterval(() => void runOnce(), deps.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    state: () => ({ ...state }),
  };
}

export type Maintenance = ReturnType<typeof createMaintenance>;
