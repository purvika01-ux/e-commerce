import type { OfferSnapshot } from '../domain/types';
import { releaseReservation } from '../decision/ledger';
import type { Clock } from '../decision/orchestrator';
import { Decision, EngagementEvent, TelegramLink } from '../models';

export type EngagementOutcome = 'ok' | 'duplicate' | 'not_owner' | 'not_found' | 'expired' | 'not_active';

/** Claim / decline from a Telegram button. Ownership is checked; replays are absorbed. */
export function createEngagementService(deps: { clock: Clock }) {
  async function respond(chatId: number, grantCode: string, action: 'claimed' | 'declined'): Promise<EngagementOutcome> {
    const now = deps.clock.now();
    const link = await TelegramLink.findOne({ chatId, status: 'active' }).lean();
    const decision = await Decision.findOne({ 'grant.code': grantCode }).lean();
    if (!link || !decision) return 'not_found';
    if (String(link.customerId) !== String(decision.customerId)) return 'not_owner';
    const grant = decision.grant as { status: string; expiresAt: Date };
    if (new Date(grant.expiresAt) <= now) return 'expired';

    const moved = await Decision.updateOne(
      { _id: decision._id, status: 'approved', 'grant.status': action === 'claimed' ? 'issued' : { $in: ['issued', 'claimed'] }, 'grant.expiresAt': { $gt: now } },
      { $set: { 'grant.status': action } },
    );
    if (!moved.modifiedCount) {
      return grant.status === action ? 'duplicate' : 'not_active';
    }
    try {
      await EngagementEvent.create({
        decisionId: decision._id,
        customerId: decision.customerId,
        grantCode,
        type: action,
        idempotencyKey: `${action}:${grantCode}`,
        occurredAt: now,
        dataOrigin: 'classmate',
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      return 'duplicate';
    }
    if (action === 'declined') {
      const s = decision.offerSnapshot as OfferSnapshot;
      await releaseReservation(s.offerId, s.estimatedCostPaise, { releaseUsage: false });
    }
    return 'ok';
  }

  return { respond };
}

export type EngagementService = ReturnType<typeof createEngagementService>;
