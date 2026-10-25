import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/infra/logger';
import { createMaintenance, expireGrants, reconcileBudgets, recoverStuck, STALE_AFTER_MS } from '../../src/maintenance/jobs';
import { Decision, Delivery, EngagementEvent, Offer, Trigger } from '../../src/models';
import { connectTestDb, dropTestDb, FakeClock, FakeTelegram, key, linkTelegram, makeServices, resetData, seedFixtures } from '../helpers/harness';

let fx: Awaited<ReturnType<typeof seedFixtures>>;
const HOUR = 3_600_000;

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
});

const req = (customerId: string, over: Record<string, unknown> = {}) => ({
  customerId,
  idempotencyKey: key(),
  type: 'manual' as const,
  source: 'admin_api' as const,
  channel: 'none' as const,
  dataOrigin: 'test' as const,
  ...over,
});

async function counters(code: string) {
  const o: any = await Offer.findOne({ code }).lean();
  return { reserved: o.budget.reservedPaise, issued: o.usage.grantsIssued };
}

describe('grant expiry', () => {
  it('releases the budget of a lapsed grant exactly once and keeps the usage slot', async () => {
    const { services, clock } = makeServices();
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk));
    expect(await counters('WINBACK15')).toEqual({ reserved: 30_000, issued: 1 });

    // Not yet due: nothing changes.
    expect(await expireGrants(clock.now())).toBe(0);

    clock.advance(73 * HOUR); // WINBACK15 grants last 72 hours
    expect(await expireGrants(clock.now())).toBe(1);
    expect(await expireGrants(clock.now())).toBe(0); // second run is a no-op

    const d: any = await Decision.findById(r.decision!._id).lean();
    expect(d.status).toBe('approved');
    expect(d.grant.status).toBe('expired');
    expect(await counters('WINBACK15')).toEqual({ reserved: 0, issued: 1 });
    expect(await EngagementEvent.countDocuments({ type: 'expired' })).toBe(1);
  });

  it('expires claimed grants too, but never re-releases a declined one', async () => {
    const { services, clock } = makeServices();
    await linkTelegram(fx.customers.atRisk, 9_000_000_201);
    await linkTelegram(fx.customers.atRisk2, 9_000_000_202);
    const a = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    const b = await services.recommendAndDeliver(req(fx.customers.atRisk2, { channel: 'telegram' }));
    expect(await services.engagement.respond(9_000_000_201, a.decision!.grant.code, 'claimed')).toBe('ok');
    expect(await services.engagement.respond(9_000_000_202, b.decision!.grant.code, 'declined')).toBe('ok');
    expect(await counters('WINBACK15')).toEqual({ reserved: 30_000, issued: 2 }); // decline already released one

    clock.advance(73 * HOUR);
    expect(await expireGrants(clock.now())).toBe(1); // only the claimed one
    expect(await counters('WINBACK15')).toEqual({ reserved: 0, issued: 2 });
  });

  it('an expired grant no longer blocks a new offer for the same customer (stacking rule)', async () => {
    const { services, clock } = makeServices();
    expect((await services.orchestrator.recommend(req(fx.customers.likelyBuyer))).decision!.status).toBe('approved');
    clock.advance(8 * 24 * HOUR); // past the 168-hour grant and the 7-day frequency window
    await expireGrants(clock.now());
    // The bonus-points offer allows one grant per customer, so nothing else is eligible — but the
    // reason must no longer include NO_STACKING.
    const again = await services.orchestrator.recommend(req(fx.customers.likelyBuyer));
    const reasons = again.decision!.excluded.flatMap((e: any) => e.reasons.map((r: any) => r.rule));
    expect(reasons).not.toContain('NO_STACKING');
    expect(reasons).toContain('PER_CUSTOMER_LIMIT');
  });
});

describe('recovery of interrupted work', () => {
  it('closes stale pending decisions and triggers, and leaves fresh ones alone', async () => {
    const { services, clock } = makeServices();
    const done = await services.orchestrator.recommend(req(fx.customers.atRisk));
    // Simulate a crash: one decision left pending long ago, one just now.
    const base = (await Decision.findById(done.decision!._id).lean()) as any;
    const mk = async (decidedAt: Date) => {
      const t = await Trigger.create({ idempotencyKey: key('stuck'), requestHash: 'x', customerId: fx.customers.cart, type: 'manual', source: 'admin_api', channel: 'none', status: 'processing' });
      return Decision.create({ ...base, _id: undefined, triggerId: t._id, status: 'pending', decidedAt, grant: undefined, correlationId: 'stuck' });
    };
    const stale = await mk(new Date(clock.now().getTime() - STALE_AFTER_MS - 1000));
    const fresh = await mk(clock.now());

    // Trigger timestamps come from the database clock, so look far enough ahead to make them stale.
    const later = new Date(Date.now() + STALE_AFTER_MS + 60_000);
    const r = await recoverStuck(new Date(Math.max(later.getTime(), clock.now().getTime())));
    expect(r.decisions).toBe(2); // both are older than the cut-off from the far-ahead clock
    expect(r.triggers).toBe(2);

    // With the real cut-off, the fresh one is untouched.
    await Decision.updateOne({ _id: fresh._id }, { status: 'pending', errorCode: null });
    const again = await recoverStuck(clock.now());
    expect(again.decisions).toBe(0);
    expect((await Decision.findById(stale._id).lean())!.status).toBe('error');
    expect((await Decision.findById(stale._id).lean())!.errorCode).toBe('ABANDONED');
    expect((await Decision.findById(fresh._id).lean())!.status).toBe('pending');
  });

  it('closes a delivery stuck in "sending": no resend, decision voided, reservation released once', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_203);
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk, { channel: 'telegram' }));
    // Simulate a crash between creating the delivery row and getting Telegram's answer.
    await Delivery.create({
      decisionId: r.decision!._id,
      customerId: r.decision!.customerId,
      customerRef: r.decision!.customerRef,
      channel: 'telegram',
      idempotencyKey: `deliver:${r.decision!._id}:telegram`,
      status: 'sending',
    });
    const later = new Date(Date.now() + STALE_AFTER_MS + 60_000);
    expect((await recoverStuck(later)).deliveries).toBe(1);
    expect((await recoverStuck(later)).deliveries).toBe(0);

    const delivery: any = await Delivery.findOne({ decisionId: r.decision!._id }).lean();
    expect(delivery).toMatchObject({ status: 'failed_permanent', failureReason: 'INTERRUPTED' });
    const d: any = await Decision.findById(r.decision!._id).lean();
    expect(d).toMatchObject({ status: 'cancelled', outcomeReason: 'DELIVERY_INTERRUPTED' });
    expect(d.grant.status).toBe('void');
    expect(await counters('WINBACK15')).toEqual({ reserved: 0, issued: 0 });

    // The delivery service must not send it afterwards either.
    await expect(services.delivery.deliver(String(r.decision!._id))).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    expect(telegram.sent).toHaveLength(0);
  });
});

describe('budget reconciliation', () => {
  it('repairs a reservation orphaned by a crash', async () => {
    const { services } = makeServices();
    await services.orchestrator.recommend(req(fx.customers.atRisk));
    // Orphaned reservation: counters moved but no decision owns it.
    await Offer.updateOne({ code: 'WINBACK15' }, { $inc: { 'budget.reservedPaise': 30_000, 'usage.grantsIssued': 1 } });
    const r = await reconcileBudgets();
    expect(r.corrected).toEqual([{ code: 'WINBACK15', reservedPaise: [60_000, 30_000], grantsIssued: [2, 1] }]);
    expect(await counters('WINBACK15')).toEqual({ reserved: 30_000, issued: 1 });
    expect((await reconcileBudgets()).corrected).toEqual([]); // idempotent
  });

  it('never touches an offer with a decision still in flight', async () => {
    const { services } = makeServices();
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk));
    await Decision.updateOne({ _id: r.decision!._id }, { status: 'pending' }); // looks in-flight
    await Offer.updateOne({ code: 'WINBACK15' }, { $inc: { 'budget.reservedPaise': 5_000 } });
    const res = await reconcileBudgets();
    expect(res.skipped).toContain('WINBACK15');
    expect(await counters('WINBACK15')).toEqual({ reserved: 35_000, issued: 1 });
  });

  it('agrees with the counters after a normal mix of approve, decline, deliver and expire', async () => {
    const { services, clock } = makeServices();
    await linkTelegram(fx.customers.atRisk, 9_000_000_204);
    const a = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    await services.engagement.respond(9_000_000_204, a.decision!.grant.code, 'declined');
    await services.orchestrator.recommend(req(fx.customers.atRisk2));
    await services.orchestrator.recommend(req(fx.customers.cart));
    clock.advance(73 * HOUR);
    await expireGrants(clock.now());
    expect((await reconcileBudgets()).corrected).toEqual([]);
  });
});

describe('maintenance runner', () => {
  it('runs all jobs, records state, and never overlaps runs', async () => {
    const clock = new FakeClock();
    const m = createMaintenance({ clock, logger: silentLogger });
    await Promise.all([m.runOnce(), m.runOnce()]);
    const s = m.state();
    expect(s.lastRunAt).not.toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.lastResult).toMatchObject({ expired: 0, corrected: [] });
  });
});
