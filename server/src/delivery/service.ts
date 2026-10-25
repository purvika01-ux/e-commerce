import type { OfferSnapshot } from '../domain/types';
import { computeContactStats, voidApprovedDecision } from '../decision/ledger';
import { loadActiveRuleSet, type Clock } from '../decision/orchestrator';
import { AppError, notFound } from '../infra/errors';
import type { Logger } from '../infra/logger';
import { Customer, Decision, Delivery, EngagementEvent, Offer, TelegramLink, toCustomerContext, toOfferRecord } from '../models';
import { validateDecision } from '../rules/validator';
import type { Violation } from '../rules/violations';
import { classifyTelegramError, type TelegramSender } from './telegramSender';

export interface DeliveryDeps {
  clock: Clock;
  telegram: TelegramSender | null;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * Sends an approved decision. Accepts only a decision id — never free text or model output — and
 * re-validates time-, rule- and opt-out-sensitive conditions immediately before sending.
 */
export function createDeliveryService(deps: DeliveryDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? 3;

  const cancel = (decisionId: string, reason: string) => voidApprovedDecision(decisionId, reason);

  async function deliver(decisionId: string): Promise<Record<string, any>> {
    const decision = await Decision.findById(decisionId).lean();
    if (!decision) throw notFound('Decision');
    if (decision.status !== 'approved') {
      throw new AppError('NOT_APPROVED', 422, `Only approved decisions can be delivered (status is "${decision.status}")`);
    }
    const snapshot = decision.offerSnapshot as OfferSnapshot;

    // Idempotency: one delivery row per decision and channel. A duplicate call returns it unchanged.
    let delivery;
    try {
      delivery = await Delivery.create({
        decisionId,
        customerId: decision.customerId,
        customerRef: decision.customerRef,
        channel: 'telegram',
        idempotencyKey: `deliver:${decisionId}:telegram`,
        status: 'sending',
      });
    } catch (err: any) {
      if (err?.code === 11000) return (await Delivery.findOne({ idempotencyKey: `deliver:${decisionId}:telegram` }).lean())!;
      throw err;
    }
    const deliveryId = delivery._id;
    const now = deps.clock.now();

    const finishCancelled = async (violations: Violation[]) => {
      await Decision.updateOne({ _id: decisionId }, { $push: { validationHistory: { ok: false, phase: 'presend', source: 'presend', violations, checkedAt: now, validatorVersion: 'v1' } } });
      await cancel(decisionId, 'PRESEND_CHECK_FAILED');
      await Delivery.updateOne({ _id: deliveryId }, { status: 'cancelled_precheck', failureReason: violations.map((v) => v.rule).join(', ') });
      return (await Delivery.findById(deliveryId).lean())!;
    };

    // Pre-send recheck. Any failure to establish safety cancels the send (fail closed).
    let chatId: number;
    try {
      const link = await TelegramLink.findOne({ customerId: decision.customerId, status: 'active' }).lean();
      const customerDoc = await Customer.findById(decision.customerId).lean();
      const offerDoc = await Offer.findById(snapshot.offerId).lean();
      if (!link) return await finishCancelled([{ rule: 'NOT_DELIVERABLE', message: 'Customer has no active Telegram link' }]);
      if (!customerDoc) return await finishCancelled([{ rule: 'CUSTOMER_NOT_FOUND', message: 'Customer no longer exists' }]);
      if (!deps.telegram) return await finishCancelled([{ rule: 'TELEGRAM_NOT_CONFIGURED', message: 'Telegram bot token is not configured' }]);
      const grant = decision.grant as { status?: string; expiresAt?: Date };
      if (grant?.status !== 'issued' || !grant.expiresAt || new Date(grant.expiresAt) <= now) {
        return await finishCancelled([{ rule: 'GRANT_NOT_ACTIVE', message: 'The issued offer is no longer active' }]);
      }
      const ruleSet = await loadActiveRuleSet();
      const customer = toCustomerContext(customerDoc);
      const stats = await computeContactStats(customer.id, ruleSet, now, decisionId);
      const recheck = validateDecision({
        proposal: { offerId: snapshot.offerId, headline: decision.copy?.headline ?? null, body: decision.copy?.body ?? null },
        snapshot,
        offer: offerDoc ? toOfferRecord(offerDoc) : null,
        customer,
        stats,
        ruleSet,
        now,
        phase: 'presend',
      });
      if (!recheck.ok) return await finishCancelled(recheck.violations);
      await Decision.updateOne({ _id: decisionId }, { $push: { validationHistory: { ...recheck, source: 'presend' } } });
      chatId = link.chatId;
    } catch (err) {
      deps.logger.error('pre-send recheck failed', { decisionId, error: err });
      return await finishCancelled([{ rule: 'PRESEND_CHECK_ERROR', message: 'Could not complete the pre-send check' }]);
    }

    // Send, retrying only transient failures.
    const attempts: Record<string, unknown>[] = [];
    for (let n = 1; n <= maxAttempts; n++) {
      try {
        const sent = await deps.telegram!.sendOffer(chatId, decision.renderedMessage as string, (decision.grant as any).code);
        attempts.push({ n, at: deps.clock.now(), outcome: 'sent' });
        await Delivery.updateOne({ _id: deliveryId }, { status: 'sent', attempts, providerMessageId: sent.messageId });
        await EngagementEvent.create({
          decisionId,
          customerId: decision.customerId,
          grantCode: (decision.grant as any).code,
          type: 'delivered',
          idempotencyKey: `delivered:${decisionId}`,
          occurredAt: deps.clock.now(),
          dataOrigin: decision.dataOrigin === 'test' ? 'test' : 'classmate',
        }).catch(() => undefined);
        return (await Delivery.findById(deliveryId).lean())!;
      } catch (raw) {
        const err = classifyTelegramError(raw);
        attempts.push({ n, at: deps.clock.now(), outcome: 'failed', errorKind: err.kind });
        const retryable = (err.kind === 'network' || err.kind === 'rate_limited') && n < maxAttempts;
        if (retryable) {
          await sleep(Math.min(5000, (err.retryAfterSec ?? n) * 1000));
          continue;
        }
        if (err.kind === 'blocked') await TelegramLink.updateOne({ chatId }, { status: 'blocked' });
        await Delivery.updateOne({ _id: deliveryId }, { status: 'failed_permanent', attempts, failureReason: err.kind });
        await cancel(decisionId, `DELIVERY_FAILED_${err.kind.toUpperCase()}`);
        deps.logger.warn('telegram delivery failed', { decisionId, kind: err.kind });
        return (await Delivery.findById(deliveryId).lean())!;
      }
    }
    throw new AppError('INTERNAL', 500, 'unreachable');
  }

  return { deliver };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
