import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { TelegramSendError } from '../../src/delivery/telegramSender';
import { silentLogger } from '../../src/infra/logger';
import { Decision, Delivery, EngagementEvent, Offer } from '../../src/models';
import type { ServiceStatus } from '../../src/routes/api';
import { connectTestDb, dropTestDb, FakeClock, FakeTelegram, key, linkTelegram, makeServices, NOW, resetData, seedFixtures } from '../helpers/harness';

const STATUS: ServiceStatus = { aiMode: 'fallback_only', model: null, telegram: { enabled: true, botUsername: 'test_bot', status: 'polling' } };

let fx: Awaited<ReturnType<typeof seedFixtures>>;
let app: ReturnType<typeof buildApp>;
let clock: FakeClock;
let telegram: FakeTelegram;
let services: ReturnType<typeof makeServices>['services'];

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
  telegram = new FakeTelegram();
  const made = makeServices({ telegram });
  clock = made.clock;
  services = made.services;
  app = buildApp({ services, clock, logger: silentLogger, status: () => STATUS });
});

const get = async (query = '') => {
  const res = await request(app).get(`/api/analytics${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

const recommend = (customerId: string, dataOrigin: 'classmate' | 'admin' | 'test' = 'classmate') =>
  services.orchestrator.recommend({ customerId, idempotencyKey: key(), type: 'manual', source: 'admin_api', channel: 'telegram', dataOrigin });

/** A hand-made decision row, for boundary and duplicate cases the pipeline cannot easily produce. */
async function rawDecision(over: Record<string, any> = {}) {
  const { segment = 'at_risk', offerCode, ...rest } = over;
  const offer = offerCode ? await Offer.findOne({ code: offerCode }).lean() : null;
  return Decision.create({
    triggerId: new Types.ObjectId(),
    customerId: fx.customers.atRisk,
    customerRef: 'T-ATRISK',
    status: 'no_offer',
    path: 'none',
    ruleSetVersion: 1,
    decidedAt: NOW,
    contextSnapshot: { segment },
    correlationId: randomBytes(4).toString('hex'),
    dataOrigin: 'classmate',
    ...(offer
      ? {
          offerSnapshot: { offerId: String(offer._id), code: offer.code, name: offer.name, version: offer.version, type: offer.type, terms: offer.terms, estimatedCostPaise: offer.estimatedCostPaise, stackable: false },
          grant: { code: `OFR-RAW-${randomBytes(3).toString('hex')}`, status: 'issued', issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000) },
        }
      : {}),
    ...rest,
  });
}

describe('empty dataset', () => {
  it('returns zeros, no rates, a zero-filled series and the list of unsupported metrics', async () => {
    const body = await get();
    expect(body.empty).toBe(true);
    expect(body.totals).toMatchObject({ decisions: 0, issued: 0, delivered: 0, claimed: 0, customersReached: 0 });
    for (const r of Object.values(body.rates) as any[]) expect(r).toMatchObject({ value: null, denominator: 0 });
    expect(body.daily.points).toHaveLength(30);
    expect(body.daily.points.every((p: any) => p.decisions === 0)).toBe(true);
    expect(body.daily.points.at(-1).date).toBe('2026-10-22');
    expect(body.budget.cohort).toEqual({ reservedPaise: 0, releasedPaise: 0, heldPaise: 0, redeemedPaise: 0 });
    expect(body.budget.current.totalPaise).toBeGreaterThan(0);
    expect(body.bySegment).toEqual([]);
    // Live offers are listed for comparison even without activity.
    expect(body.byOffer.length).toBeGreaterThan(0);
    expect(body.byOffer.every((o: any) => o.issued === 0 && o.claimRate.value === null)).toBe(true);
    expect(body.unsupported.map((u: any) => u.metric)).toEqual(
      expect.arrayContaining([expect.stringMatching(/purchases/i), expect.stringMatching(/causal/i), expect.stringMatching(/revenue/i)]),
    );
    expect(body.totals.redeemed).toBe(0);
  });

  it('all-time with no decisions gives a one-day series instead of failing', async () => {
    const body = await get('?range=all');
    expect(body.filters.fromDay).toBeNull();
    expect(body.daily.points).toHaveLength(1);
  });
});

describe('end-to-end figures from the real pipeline', () => {
  it('counts sends, retries, failures, claims and budget once each', async () => {
    await linkTelegram(fx.customers.atRisk, 9_000_000_501);
    await linkTelegram(fx.customers.atRisk2, 9_000_000_502);

    // Customer 1: one network failure, then sent (an automatic retry), then claimed twice.
    const a = await recommend(fx.customers.atRisk);
    expect(a.decision!.status).toBe('approved');
    telegram.failNext(new TelegramSendError('network', 'down'));
    expect((await services.delivery.deliver(String(a.decision!._id))).status).toBe('sent');
    expect((await services.delivery.deliver(String(a.decision!._id))).status).toBe('sent'); // duplicate call
    expect(await services.engagement.respond(9_000_000_501, a.decision!.grant.code, 'claimed')).toBe('ok');
    expect(await services.engagement.respond(9_000_000_501, a.decision!.grant.code, 'claimed')).toBe('duplicate');

    // Customer 2: the bot is blocked — permanent failure, decision voided, budget released.
    const b = await recommend(fx.customers.atRisk2);
    telegram.failNext(new TelegramSendError('blocked', 'blocked'));
    expect((await services.delivery.deliver(String(b.decision!._id))).status).toBe('failed_permanent');

    // Customer 1 asks again while still holding an unused offer → no offer (repeat request, new decision).
    clock.advance(60_000);
    const c = await recommend(fx.customers.atRisk);
    expect(c.decision!.status).toBe('no_offer');

    // Test-origin data and dashboard previews are never counted.
    await recommend(fx.customers.cart, 'test');
    await services.orchestrator.recommend({ customerId: fx.customers.cart, idempotencyKey: key(), type: 'preview', source: 'admin_api', channel: 'none', dryRun: true, dataOrigin: 'classmate' });

    const cost = a.decision!.offerSnapshot.estimatedCostPaise as number;
    const costB = b.decision!.offerSnapshot.estimatedCostPaise as number;
    const body = await get('?range=7d');
    expect(body.empty).toBe(false);
    expect(body.totals).toMatchObject({
      decisions: 3,
      customers: 2,
      issued: 2,
      stillApproved: 1,
      cancelled: 1,
      noOffer: 1,
      delivered: 1,
      customersReached: 1,
      claimed: 1,
      customersClaimed: 1,
      declined: 0,
      redeemed: 0,
    });
    expect(body.totals.paths.fallback).toBe(2);
    expect(body.rates.deliverySuccess).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, smallSample: true });
    expect(body.rates.claim).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(body.rates.approval).toMatchObject({ numerator: 2, denominator: 3 });
    expect(body.delivery).toMatchObject({ attempted: 2, sent: 1, failed: 1, precheckCancelled: 0, retried: 1, recoveredByRetry: 1, extraAttempts: 1, notSent: 0 });
    expect(body.delivery.failureReasons).toEqual([{ reason: 'blocked', count: 1 }]);
    expect(body.reasons.cancellations).toEqual([{ reason: 'DELIVERY_FAILED_BLOCKED', count: 1 }]);
    expect(body.reasons.noOffer).toEqual([{ reason: 'NO_ELIGIBLE_OFFERS', count: 1 }]);
    expect(body.reasons.exclusionRules.map((r: any) => r.rule)).toContain('NO_STACKING');
    expect(body.budget.cohort).toEqual({ reservedPaise: cost + costB, releasedPaise: costB, heldPaise: cost, redeemedPaise: 0 });
    expect(body.origins).toEqual({ classmate: 3 });

    const offerRow = body.byOffer.find((o: any) => o.code === a.decision!.offerSnapshot.code);
    expect(offerRow).toMatchObject({ delivered: 1, claimed: 1 });
    expect(offerRow.claimRate.value).toBe(1);
    const seg = body.bySegment.find((s: any) => s.segment === 'at_risk');
    expect(seg).toMatchObject({ decisions: 3, issued: 2, noOffer: 1, delivered: 1, claimed: 1 });
    expect(seg.claimRate.value).toBe(1);

    const today = body.daily.points.at(-1);
    expect(today).toMatchObject({ date: '2026-10-22', decisions: 3, issued: 2, noOffer: 1, delivered: 1, claimed: 1 });
    expect(body.daily.points.reduce((s: number, p: any) => s + p.decisions, 0)).toBe(3);

    // Origin filter: nothing was triggered from the dashboard.
    expect((await get('?range=7d&origin=admin')).totals.decisions).toBe(0);
    expect((await get('?range=7d&origin=classmate')).totals.decisions).toBe(3);
  });

  it('a declined offer releases its budget and counts as a decline, not a claim', async () => {
    await linkTelegram(fx.customers.atRisk, 9_000_000_511);
    const a = await recommend(fx.customers.atRisk);
    await services.delivery.deliver(String(a.decision!._id));
    expect(await services.engagement.respond(9_000_000_511, a.decision!.grant.code, 'declined')).toBe('ok');
    const body = await get();
    expect(body.totals).toMatchObject({ delivered: 1, claimed: 0, declined: 1 });
    expect(body.rates.decline.value).toBe(1);
    expect(body.budget.cohort.releasedPaise).toBe(body.budget.cohort.reservedPaise);
    expect(body.budget.cohort.heldPaise).toBe(0);
  });
});

describe('duplicate records', () => {
  it('collapses duplicate delivery rows and duplicate engagement events per decision', async () => {
    const d = await rawDecision({ status: 'approved', path: 'fallback', offerCode: 'WINBACK15' });
    const base = { decisionId: d._id, customerId: d.customerId, customerRef: 'T-ATRISK', channel: 'telegram' as const };
    await Delivery.create({ ...base, idempotencyKey: 'dup-1', status: 'sent', attempts: [{ n: 1 }, { n: 2 }] });
    await Delivery.create({ ...base, idempotencyKey: 'dup-2', status: 'sent', attempts: [{ n: 1 }] });
    for (const k of ['c1', 'c2', 'c3']) {
      await EngagementEvent.create({ decisionId: d._id, customerId: d.customerId, grantCode: d.grant!.code!, type: 'claimed', idempotencyKey: k, occurredAt: NOW });
    }
    await EngagementEvent.create({ decisionId: d._id, customerId: d.customerId, grantCode: d.grant!.code!, type: 'delivered', idempotencyKey: 'dl1', occurredAt: NOW });

    const body = await get();
    expect(body.totals).toMatchObject({ decisions: 1, issued: 1, delivered: 1, claimed: 1, customersReached: 1 });
    expect(body.delivery).toMatchObject({ attempted: 1, sent: 1, retried: 1, extraAttempts: 1 });
    expect(body.rates.claim.value).toBe(1);
    expect(body.byOffer.find((o: any) => o.code === 'WINBACK15')).toMatchObject({ issued: 1, delivered: 1, claimed: 1 });
  });

  it('counts each blocking rule once per decision, however many offers or validation runs hit it', async () => {
    await rawDecision({
      status: 'no_offer',
      outcomeReason: 'NO_ELIGIBLE_OFFERS',
      excluded: [
        { code: 'A', reasons: [{ rule: 'FREQUENCY_CAP' }, { rule: 'SEGMENT_MISMATCH' }] },
        { code: 'B', reasons: [{ rule: 'FREQUENCY_CAP' }] },
      ],
    });
    await rawDecision({
      status: 'rejected',
      path: 'fallback',
      outcomeReason: 'NO_CANDIDATE_PASSED_VALIDATION',
      validationHistory: [
        { ok: false, violations: [{ rule: 'BUDGET_EXHAUSTED' }] },
        { ok: false, violations: [{ rule: 'BUDGET_EXHAUSTED' }, { rule: 'USAGE_LIMIT' }] },
        { ok: true, violations: [] },
      ],
    });
    const body = await get();
    expect(body.reasons.exclusionRules).toEqual([
      { rule: 'FREQUENCY_CAP', count: 1 },
      { rule: 'SEGMENT_MISMATCH', count: 1 },
    ]);
    expect(body.reasons.rejectionRules).toEqual([
      { rule: 'BUDGET_EXHAUSTED', count: 1 },
      { rule: 'USAGE_LIMIT', count: 1 },
    ]);
    expect(body.totals).toMatchObject({ decisions: 2, noOffer: 1, rejected: 1, issued: 0 });
  });
});

describe('date boundaries (IST calendar days)', () => {
  // 7d = 16 Oct 00:00 IST (15 Oct 18:30 UTC) up to, not including, 23 Oct 00:00 IST.
  const FIRST = new Date('2026-10-15T18:30:00.000Z');
  const END = new Date('2026-10-22T18:30:00.000Z');

  it('includes the first and last instants of the window and nothing outside it', async () => {
    await rawDecision({ decidedAt: new Date(FIRST.getTime() - 1) }); // 15 Oct 23:59:59.999 IST
    await rawDecision({ decidedAt: FIRST }); // 16 Oct 00:00 IST
    await rawDecision({ decidedAt: new Date(END.getTime() - 1) }); // 22 Oct 23:59:59.999 IST
    await rawDecision({ decidedAt: END }); // 23 Oct 00:00 IST (tomorrow: outside every preset)

    const week = await get('?range=7d');
    expect(week.totals.decisions).toBe(2);
    expect(week.filters).toMatchObject({ fromDay: '2026-10-16', toDay: '2026-10-22', timezone: 'Asia/Kolkata' });
    expect(week.daily.points[0]).toMatchObject({ date: '2026-10-16', decisions: 1 });
    expect(week.daily.points.at(-1)).toMatchObject({ date: '2026-10-22', decisions: 1 });

    const day15 = await get('?range=custom&from=2026-10-15&to=2026-10-15');
    expect(day15.totals.decisions).toBe(1);
    expect(day15.daily.points).toEqual([expect.objectContaining({ date: '2026-10-15', decisions: 1 })]);

    const span = await get('?range=custom&from=2026-10-15&to=2026-10-23');
    expect(span.totals.decisions).toBe(4);
    expect(span.daily.points).toHaveLength(9);

    const all = await get('?range=all'); // all time still ends with today
    expect(all.totals.decisions).toBe(3);
    expect(all.filters.fromDay).toBe('2026-10-15');
    expect(all.daily.points[0].date).toBe('2026-10-15');
  });

  it('attributes later deliveries and taps to the day the decision was made', async () => {
    const d = await rawDecision({ status: 'approved', path: 'fallback', offerCode: 'WINBACK15', decidedAt: new Date(FIRST.getTime() - 1) });
    await Delivery.create({ decisionId: d._id, customerId: d.customerId, customerRef: 'T-ATRISK', channel: 'telegram', idempotencyKey: 'late', status: 'sent', attempts: [{ n: 1 }] });
    await EngagementEvent.create({ decisionId: d._id, customerId: d.customerId, grantCode: d.grant!.code!, type: 'claimed', idempotencyKey: 'late-claim', occurredAt: NOW });
    expect((await get('?range=7d')).totals).toMatchObject({ decisions: 0, delivered: 0, claimed: 0 });
    expect((await get('?range=30d')).totals).toMatchObject({ decisions: 1, delivered: 1, claimed: 1 });
  });
});

describe('segment and offer filters', () => {
  it('restricts every figure to the chosen segment (as it was when the decision was made)', async () => {
    await rawDecision({ segment: 'at_risk', status: 'approved', path: 'fallback', offerCode: 'WINBACK15' });
    await rawDecision({ segment: 'loyal' });
    await rawDecision({ segment: 'loyal' });

    const loyal = await get('?segment=loyal');
    expect(loyal.filters.segment).toBe('loyal');
    expect(loyal.totals).toMatchObject({ decisions: 2, noOffer: 2, issued: 0 });
    expect(loyal.bySegment.map((s: any) => s.segment)).toEqual(['loyal']);
    expect(loyal.budget.cohort.reservedPaise).toBe(0);
    expect(loyal.daily.points.reduce((s: number, p: any) => s + p.decisions, 0)).toBe(2);

    const atRisk = await get('?segment=at_risk');
    expect(atRisk.totals).toMatchObject({ decisions: 1, issued: 1 });
    expect(atRisk.budget.cohort.reservedPaise).toBeGreaterThan(0);

    const champions = await get('?segment=champion');
    expect(champions.empty).toBe(true);

    const all = await get();
    expect(all.bySegment).toEqual([expect.objectContaining({ segment: 'loyal', decisions: 2 }), expect.objectContaining({ segment: 'at_risk', decisions: 1 })]);
  });

  it('the offer filter keeps only decisions that issued that offer', async () => {
    await rawDecision({ status: 'approved', path: 'fallback', offerCode: 'WINBACK15' });
    await rawDecision({ status: 'no_offer' });
    const body = await get('?offer=WINBACK15');
    expect(body.totals).toMatchObject({ decisions: 1, issued: 1 });
    expect(body.byOffer.map((o: any) => o.code)).toEqual(['WINBACK15']);
  });
});

describe('request validation', () => {
  it('rejects bad filters with a 400', async () => {
    for (const qs of ['?range=yesterday', '?segment=vip', '?range=custom', '?range=custom&from=2026-02-30&to=2026-03-01', '?offer=bad code', '?origin=bot', '?limit=5']) {
      const res = await request(app).get(`/api/analytics${qs}`);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
