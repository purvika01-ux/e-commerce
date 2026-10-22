import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { permittedContext, toAiCandidate } from '../ai/context';
import { PROMPT_VERSION } from '../ai/prompt';
import type { AiClient, AiResult } from '../ai/types';
import { ProposalSchema, type Proposal } from '../domain/proposal';
import type { RuleSetRecord } from '../domain/rules';
import { snapshotOf, type OfferRecord } from '../domain/types';
import { renderOfferMessage } from '../delivery/render';
import { AppError, conflict, notFound } from '../infra/errors';
import type { Logger } from '../infra/logger';
import { Customer, Decision, Offer, RuleSet, toCustomerContext, toOfferRecord, Trigger } from '../models';
import { filterEligible } from '../rules/eligibility';
import { rankFallback, templateCopy } from '../rules/fallback';
import { validateDecision } from '../rules/validator';
import type { ValidationResult, Violation } from '../rules/violations';
import { computeContactStats, releaseReservation, reserveOffer } from './ledger';

export interface Clock {
  now(): Date;
}

export interface OrchestratorDeps {
  clock: Clock;
  ai: AiClient | null;
  logger: Logger;
  newGrantCode: () => string;
  leaseMs?: number;
}

export interface RecommendRequest {
  customerId: string;
  idempotencyKey: string;
  type: 'manual' | 'bot_request' | 'preview';
  source: 'admin_api' | 'bot';
  channel: 'telegram' | 'none';
  dryRun?: boolean;
  dataOrigin?: 'admin' | 'classmate' | 'test';
}

export interface RecommendResult {
  decision: Record<string, any> | null;
  replayed: boolean;
  triggerStatus: string;
}

type HistoryEntry = ValidationResult & { source: 'ai' | 'fallback' | 'reservation' | 'presend'; attempt?: number; offerCode?: string };

interface Choice {
  offer: OfferRecord;
  headline: string;
  body: string;
  path: 'ai' | 'ai_retry' | 'fallback';
}

const MAX_FALLBACK_TRIES = 3;

export async function loadActiveRuleSet(): Promise<RuleSetRecord> {
  const rs = await RuleSet.findOne({ active: true }).lean();
  if (!rs) throw new AppError('NO_RULESET', 503, 'No active rule set — run the seed first');
  return { version: rs.version, rules: rs.rules as RuleSetRecord['rules'] };
}

async function loadOffer(id: string): Promise<OfferRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  const d = await Offer.findById(id).lean();
  return d ? toOfferRecord(d) : null;
}

/**
 * The decision pipeline (ARCHITECTURE.md §5). It is the only code that can mark a decision
 * "approved", and it never sends anything — delivery takes an approved decision id afterwards.
 */
export function createOrchestrator(deps: OrchestratorDeps) {
  const leaseMs = deps.leaseMs ?? 60_000;

  async function recommend(req: RecommendRequest): Promise<RecommendResult> {
    if (!Types.ObjectId.isValid(req.customerId)) throw notFound('Customer');
    const now = deps.clock.now();
    const requestHash = createHash('sha256')
      .update(JSON.stringify([req.customerId, req.type, req.channel, Boolean(req.dryRun)]))
      .digest('hex');

    // 1. Deduplicate the trigger.
    let trigger;
    try {
      trigger = await Trigger.create({
        idempotencyKey: req.idempotencyKey,
        requestHash,
        customerId: req.customerId,
        type: req.type,
        source: req.source,
        channel: req.channel,
        status: 'processing',
        dataOrigin: req.dataOrigin ?? 'admin',
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      const existing = await Trigger.findOne({ idempotencyKey: req.idempotencyKey }).lean();
      if (!existing) throw err;
      if (existing.requestHash !== requestHash) throw conflict('Idempotency-Key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED');
      const decision = existing.decisionId ? await Decision.findById(existing.decisionId).lean() : null;
      return { decision, replayed: true, triggerStatus: existing.status };
    }
    const triggerId = String(trigger._id);

    // 1b. Per-customer lease so concurrent triggers cannot both pass the frequency cap.
    if (!req.dryRun) {
      const leased = await Customer.findOneAndUpdate(
        { _id: req.customerId, $or: [{ 'decisionLease.expiresAt': null }, { 'decisionLease.expiresAt': { $lt: now } }] },
        { $set: { decisionLease: { holder: triggerId, expiresAt: new Date(now.getTime() + leaseMs) } } },
        { returnDocument: 'after' },
      ).lean();
      if (!leased) {
        const exists = await Customer.exists({ _id: req.customerId });
        await Trigger.updateOne({ _id: triggerId }, { status: exists ? 'skipped' : 'failed', error: { code: exists ? 'CUSTOMER_BUSY' : 'NOT_FOUND', message: '' } });
        if (!exists) throw notFound('Customer');
        throw conflict('Another decision is in progress for this customer', 'CUSTOMER_BUSY');
      }
    }

    let decisionId: string | null = null;
    let reserved: { offerId: string; cost: number } | null = null;
    try {
      // 2–3. Load context, offers and the active rules.
      const customerDoc = await Customer.findById(req.customerId).lean();
      if (!customerDoc) throw notFound('Customer');
      const customer = toCustomerContext(customerDoc);
      const ruleSet = await loadActiveRuleSet();
      const offers = (await Offer.find({ status: { $ne: 'archived' } }).lean()).map(toOfferRecord);
      const stats = await computeContactStats(customer.id, ruleSet, now);

      // 4. Deterministic eligibility.
      const { eligible, excluded } = filterEligible(offers, { customer, stats, ruleSet, now });
      const context = permittedContext(customer, now);
      const created = await Decision.create({
        triggerId,
        customerId: customer.id,
        customerRef: customer.externalRef,
        status: 'pending',
        ruleSetVersion: ruleSet.version,
        decidedAt: now,
        preview: Boolean(req.dryRun),
        contextSnapshot: context,
        candidates: eligible.map((o) => ({ offerId: o.id, code: o.code, version: o.version, priority: o.priority, estimatedCostPaise: o.estimatedCostPaise })),
        excluded,
        ai: { model: deps.ai?.model ?? null, promptVersion: PROMPT_VERSION, enabled: Boolean(deps.ai), attempts: [] },
        correlationId: triggerId,
        dataOrigin: req.dataOrigin ?? 'admin',
      });
      decisionId = String(created._id);

      if (eligible.length === 0) {
        return await finish(triggerId, decisionId, { status: 'no_offer', path: 'none', outcomeReason: 'NO_ELIGIBLE_OFFERS' });
      }

      const history: HistoryEntry[] = [];
      const attempts: Record<string, unknown>[] = [];
      let aiChoice: Choice | null = null;
      let aiProposal: Proposal | null = null;

      // 5–7. AI proposal → strict schema → independent validation (one retry with feedback).
      if (deps.ai) {
        let feedback: Violation[] | undefined;
        for (let n = 1; n <= 2; n++) {
          let res: AiResult;
          try {
            res = await deps.ai.propose({ context, candidates: eligible.map(toAiCandidate), previousViolations: feedback });
          } catch (err) {
            res = { outcome: 'api_error', errorCode: err instanceof Error ? err.name : 'unknown', model: deps.ai.model, latencyMs: 0 };
          }
          const attempt: Record<string, unknown> = {
            n,
            outcome: res.outcome,
            errorCode: res.errorCode ?? null,
            latencyMs: res.latencyMs,
            usage: res.usage ?? null,
            rawText: res.rawText ? res.rawText.slice(0, 2000) : null,
          };
          attempts.push(attempt);
          if (res.outcome !== 'ok') {
            if (res.outcome === 'malformed' && n === 1) {
              feedback = [{ rule: 'SCHEMA_INVALID', message: 'The response was not valid JSON matching the required schema' }];
              continue;
            }
            break; // timeouts, API errors, rate limits and refusals go straight to the fallback
          }
          const parsed = ProposalSchema.safeParse(res.output);
          if (!parsed.success) {
            attempt.outcome = 'schema_invalid';
            feedback = parsed.error.issues.map((i) => ({ rule: 'SCHEMA_INVALID', message: `${i.path.join('.') || 'response'}: ${i.message}` }));
            attempt.violations = feedback;
            continue;
          }
          aiProposal = parsed.data;
          if (parsed.data.decision === 'no_offer') {
            attempt.outcome = 'no_offer';
            break;
          }
          const offerId = parsed.data.offerId!;
          const fresh = await loadOffer(offerId);
          const validation = validateDecision({
            proposal: { offerId, headline: parsed.data.headline, body: parsed.data.body },
            candidateIds: eligible.map((o) => o.id),
            offer: fresh,
            customer,
            stats,
            ruleSet,
            now,
            phase: 'decision',
          });
          history.push({ ...validation, source: 'ai', attempt: n, offerCode: fresh?.code });
          if (validation.ok && fresh) {
            aiChoice = { offer: fresh, headline: parsed.data.headline!.trim(), body: parsed.data.body!.trim(), path: n === 1 ? 'ai' : 'ai_retry' };
            break;
          }
          attempt.outcome = 'validation_failed';
          attempt.violations = validation.violations;
          feedback = validation.violations;
        }
      }

      await Decision.updateOne({ _id: decisionId }, { $set: { 'ai.attempts': attempts, proposal: aiProposal } });

      // The AI may decline to make an offer; that is always safe and is respected.
      if (!aiChoice && aiProposal?.decision === 'no_offer' && attempts.at(-1)?.outcome === 'no_offer') {
        return await finish(triggerId, decisionId, {
          status: 'no_offer',
          path: attempts.length === 1 ? 'ai' : 'ai_retry',
          outcomeReason: 'AI_CHOSE_NO_OFFER',
          validationHistory: history,
        });
      }

      // 7–8. Try the AI choice, then deterministic fallbacks, each validated and atomically reserved.
      const queue: (() => Promise<Choice | null>)[] = [];
      if (aiChoice) queue.push(async () => aiChoice);
      for (const o of rankFallback(eligible).filter((o) => o.id !== aiChoice?.offer.id).slice(0, MAX_FALLBACK_TRIES)) {
        queue.push(async () => {
          const fresh = await loadOffer(o.id);
          const copy = templateCopy(o, customer);
          const validation = validateDecision({
            proposal: { offerId: o.id, ...copy },
            candidateIds: eligible.map((e) => e.id),
            offer: fresh,
            customer,
            stats,
            ruleSet,
            now,
            phase: 'decision',
          });
          history.push({ ...validation, source: 'fallback', offerCode: o.code });
          return validation.ok && fresh ? { offer: fresh, ...copy, path: 'fallback' } : null;
        });
      }

      let approved: Choice | null = null;
      for (const next of queue) {
        const choice = await next();
        if (!choice) continue;
        if (req.dryRun) {
          approved = choice;
          break;
        }
        const r = await reserveOffer(choice.offer, now);
        if (r.ok) {
          reserved = { offerId: choice.offer.id, cost: choice.offer.estimatedCostPaise };
          approved = choice;
          break;
        }
        history.push({
          ok: false,
          phase: 'decision',
          violations: [{ rule: r.reason, message: 'Atomic budget/usage reservation was refused' }],
          checkedAt: now,
          validatorVersion: 'ledger',
          source: 'reservation',
          offerCode: choice.offer.code,
        });
      }

      if (!approved) {
        return await finish(triggerId, decisionId, {
          status: 'rejected',
          path: 'fallback',
          outcomeReason: 'NO_CANDIDATE_PASSED_VALIDATION',
          validationHistory: history,
        });
      }

      // 9. Persist the approved decision with the snapshot the customer is promised.
      const snapshot = snapshotOf(approved.offer);
      const grantCode = req.dryRun ? 'PREVIEW-ONLY' : deps.newGrantCode();
      const expiresAt = new Date(Math.min(now.getTime() + approved.offer.grantValidityHours * 3_600_000, approved.offer.validTo.getTime()));
      const update: Record<string, unknown> = {
        status: req.dryRun ? 'dry_run' : 'approved',
        path: approved.path,
        offerSnapshot: snapshot,
        copy: { headline: approved.headline, body: approved.body },
        renderedMessage: renderOfferMessage({ headline: approved.headline, body: approved.body, snapshot, grantCode, expiresAt }),
        validationHistory: history,
        outcomeReason: approved.path === 'fallback' && deps.ai ? 'AI_UNAVAILABLE_OR_REJECTED' : approved.path === 'fallback' ? 'AI_DISABLED' : null,
      };
      if (!req.dryRun) {
        update.reservation = { offerId: snapshot.offerId, costPaise: snapshot.estimatedCostPaise, reservedAt: now };
        update.grant = { code: grantCode, status: 'issued', issuedAt: now, expiresAt };
      }
      const saved = await Decision.findOneAndUpdate({ _id: decisionId, status: 'pending' }, { $set: update }, { returnDocument: 'after' }).lean();
      if (!saved) throw new AppError('DECISION_WRITE_FAILED', 500, 'Could not persist the approved decision');
      reserved = null; // now owned by the persisted decision
      await Trigger.updateOne({ _id: triggerId }, { status: 'completed', decisionId, completedAt: now });
      return { decision: saved, replayed: false, triggerStatus: 'completed' };
    } catch (err) {
      // Fail closed: compensate the reservation, mark the decision as an error, never send.
      if (reserved) await releaseReservation(reserved.offerId, reserved.cost, { releaseUsage: true }).catch(() => undefined);
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      if (decisionId) await Decision.updateOne({ _id: decisionId, status: 'pending' }, { status: 'error', errorCode: code }).catch(() => undefined);
      await Trigger.updateOne({ _id: triggerId }, { status: 'failed', decisionId, error: { code, message: err instanceof Error ? err.message : '' } }).catch(() => undefined);
      deps.logger.error('decision pipeline failed', { triggerId, decisionId, code, error: err });
      throw err;
    } finally {
      if (!req.dryRun) {
        await Customer.updateOne({ _id: req.customerId, 'decisionLease.holder': triggerId }, { $set: { decisionLease: { holder: null, expiresAt: null } } }).catch(() => undefined);
      }
    }
  }

  async function finish(triggerId: string, decisionId: string, set: Record<string, unknown>): Promise<RecommendResult> {
    const saved = await Decision.findOneAndUpdate({ _id: decisionId, status: 'pending' }, { $set: set }, { returnDocument: 'after' }).lean();
    await Trigger.updateOne({ _id: triggerId }, { status: 'completed', decisionId, completedAt: deps.clock.now() });
    return { decision: saved, replayed: false, triggerStatus: 'completed' };
  }

  return { recommend };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
