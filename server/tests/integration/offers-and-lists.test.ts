import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { silentLogger } from '../../src/infra/logger';
import { Decision, Offer } from '../../src/models';
import type { ServiceStatus } from '../../src/routes/api';
import { connectTestDb, dropTestDb, FakeClock, FakeTelegram, key, linkTelegram, makeServices, NOW, resetData, seedFixtures } from '../helpers/harness';

const STATUS: ServiceStatus = { aiMode: 'fallback_only', model: null, telegram: { enabled: true, botUsername: 'test_bot', status: 'polling' } };
const DAY = 86_400_000;

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

const validOffer = (over: Record<string, unknown> = {}) => ({
  code: 'MONSOON12',
  name: 'Monsoon 12% off',
  description: 'Seasonal nudge',
  type: 'percent_off',
  terms: { percentOff: 12, maxDiscountPaise: 20_000, minOrderPaise: 79_900 },
  eligibility: { segments: ['promising'] },
  validFrom: new Date(NOW.getTime() - DAY).toISOString(),
  validTo: new Date(NOW.getTime() + 20 * DAY).toISOString(),
  grantValidityHours: 48,
  priority: 55,
  budgetTotalPaise: 500_000,
  maxGrants: 50,
  ...over,
});

describe('creating offers', () => {
  it('creates a draft with server-owned counters and a computed cost', async () => {
    const res = await request(app).post('/api/offers').send(validOffer());
    expect(res.status).toBe(201);
    expect(res.body.offer).toMatchObject({ code: 'MONSOON12', status: 'draft', version: 1, estimatedCostPaise: 20_000, ruleIssues: [] });
    expect(res.body.offer.budget).toEqual({ totalPaise: 500_000, reservedPaise: 0, redeemedPaise: 0 });
  });

  it('rejects invalid input with field-level details and writes nothing', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [validOffer({ terms: { percentOff: 12, minOrderPaise: 0 } }), 'terms.maxDiscountPaise'],
      [validOffer({ type: 'flat_off' }), 'terms.flatOffPaise'],
      [validOffer({ validTo: new Date(NOW.getTime() - 2 * DAY).toISOString() }), 'validTo'],
      [validOffer({ code: 'bad code' }), 'code'],
      [validOffer({ status: 'active' }), ''],
      [validOffer({ budgetTotalPaise: 0 }), 'budgetTotalPaise'],
    ];
    for (const [body, path] of cases) {
      const res = await request(app).post('/api/offers').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      if (path) expect(res.body.error.details.map((d: any) => d.path)).toContain(path);
    }
    expect(await Offer.countDocuments({ code: 'MONSOON12' })).toBe(0);
  });

  it('refuses duplicate codes', async () => {
    expect((await request(app).post('/api/offers').send(validOffer({ code: 'WINBACK15' }))).status).toBe(409);
  });

  it('a draft that breaks the rules is saved but flagged, and cannot be activated', async () => {
    const res = await request(app).post('/api/offers').send(validOffer({ code: 'HUGE40', terms: { percentOff: 40, maxDiscountPaise: 90_000, minOrderPaise: 99_900 } }));
    expect(res.status).toBe(201);
    expect(res.body.offer.ruleIssues.map((i: any) => i.rule)).toEqual(expect.arrayContaining(['MAX_DISCOUNT_PERCENT', 'MAX_DISCOUNT_AMOUNT']));
    expect((await request(app).post(`/api/offers/${res.body.offer.id}/status`).send({ action: 'activate' })).status).toBe(422);
  });
});

describe('editing offers', () => {
  it('cosmetic edits keep the version; commercial edits bump it', async () => {
    const id = fx.offerId('WINBACK15');
    const cosmetic = await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 1, name: 'We miss you — 15% off (refreshed)' });
    expect(cosmetic.status).toBe(200);
    expect(cosmetic.body.offer.version).toBe(1);
    // A partial edit must not reset fields it did not mention (regression: schema defaults used to leak in).
    expect(cosmetic.body.offer.eligibility).toEqual({ segments: ['at_risk', 'hibernating'], minChurnRisk: 0.5 });
    expect(cosmetic.body.offer.description).toBe('Win-back discount for customers who have gone quiet.');
    const commercial = await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 1, terms: { percentOff: 12, maxDiscountPaise: 25_000, minOrderPaise: 99_900 } });
    expect(commercial.status).toBe(200);
    expect(commercial.body.offer.version).toBe(2);
    expect(commercial.body.offer.estimatedCostPaise).toBe(24_000);
  });

  it('stale versions and archived offers are refused', async () => {
    const id = fx.offerId('WINBACK15');
    expect((await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 7, priority: 10 })).status).toBe(409);
    await request(app).post(`/api/offers/${id}/status`).send({ action: 'archive' });
    expect((await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 1, priority: 10 })).status).toBe(409);
  });

  it('an active offer cannot be edited into breaking the rules', async () => {
    const id = fx.offerId('WINBACK15');
    const res = await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 1, terms: { percentOff: 40, maxDiscountPaise: 30_000, minOrderPaise: 99_900 } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: any) => d.rule)).toContain('MAX_DISCOUNT_PERCENT');
    expect((await Offer.findById(id).lean())!.terms).toMatchObject({ percentOff: 15 });
  });

  it('budget and usage limits cannot drop below what is already committed', async () => {
    const r = await services.orchestrator.recommend({ customerId: fx.customers.atRisk, idempotencyKey: key(), type: 'manual', source: 'admin_api', channel: 'none', dataOrigin: 'test' });
    expect(r.decision!.status).toBe('approved'); // reserves ₹300 of WINBACK15
    const id = fx.offerId('WINBACK15');
    const res = await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 1, budgetTotalPaise: 10_000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BUDGET_BELOW_COMMITTED');
    expect((await request(app).patch(`/api/offers/${id}`).send({ expectedVersion: 1, maxGrants: 0 })).status).toBe(400);
  });

  it('an issued grant keeps its promised terms; an unsent decision is cancelled after a terms change', async () => {
    await linkTelegram(fx.customers.atRisk, 9_000_000_401);
    const r = await services.orchestrator.recommend({ customerId: fx.customers.atRisk, idempotencyKey: key(), type: 'manual', source: 'admin_api', channel: 'telegram', dataOrigin: 'test' });
    await request(app).patch(`/api/offers/${fx.offerId('WINBACK15')}`).send({ expectedVersion: 1, terms: { percentOff: 10, maxDiscountPaise: 30_000, minOrderPaise: 99_900 } });
    const d: any = await Decision.findById(r.decision!._id).lean();
    expect(d.offerSnapshot.terms.percentOff).toBe(15); // the snapshot never changes
    const delivery = await services.delivery.deliver(String(r.decision!._id));
    expect(delivery.status).toBe('cancelled_precheck');
    expect(delivery.failureReason).toContain('OFFER_CHANGED');
    expect(telegram.sent).toHaveLength(0);
  });
});

describe('overview time range and series', () => {
  it('filters counts by range, returns a full daily series and live budget totals', async () => {
    await services.orchestrator.recommend({ customerId: fx.customers.atRisk, idempotencyKey: key(), type: 'manual', source: 'admin_api', channel: 'none', dataOrigin: 'test' });
    clock.advance(10 * DAY);
    await services.orchestrator.recommend({ customerId: fx.customers.cart, idempotencyKey: key(), type: 'manual', source: 'admin_api', channel: 'none', dataOrigin: 'test' });

    const week = (await request(app).get('/api/overview?days=7')).body;
    expect(week.range).toBe('7d');
    expect(week.decisions.approved).toBe(1); // the older one is outside the 7-day window
    expect(week.daily.points).toHaveLength(7);
    expect(week.daily.points.reduce((s: number, p: any) => s + p.approved, 0)).toBe(1);

    const all = (await request(app).get('/api/overview')).body;
    expect(all.range).toBe('all');
    expect(all.decisions.approved).toBe(2);
    expect(all.daily.points).toHaveLength(30);
    expect(all.budget.liveOffers).toBeGreaterThan(0);
    expect(all.budget.availablePaise).toBe(all.budget.totalPaise - all.budget.committedPaise);
    expect((await request(app).get('/api/overview?days=365')).status).toBe(400);
  });
});

describe('decision and customer lists', () => {
  it('decisions paginate, filter and sort; the old limit parameter still works', async () => {
    for (const id of [fx.customers.atRisk, fx.customers.atRisk2, fx.customers.cart, fx.customers.likelyBuyer]) {
      clock.advance(60_000);
      await services.orchestrator.recommend({ customerId: id, idempotencyKey: key(), type: 'manual', source: 'admin_api', channel: 'none', dataOrigin: 'test' });
    }
    const page1 = (await request(app).get('/api/decisions?page=1&pageSize=3')).body;
    expect(page1).toMatchObject({ page: 1, pageSize: 3, total: 4 });
    expect(page1.items).toHaveLength(3);
    const page2 = (await request(app).get('/api/decisions?page=2&pageSize=3')).body;
    expect(page2.items).toHaveLength(1);
    const oldest = (await request(app).get('/api/decisions?sort=oldest&pageSize=1')).body.items[0];
    expect(oldest.customerRef).toBe('T-ATRISK');
    expect((await request(app).get('/api/decisions?q=T-CART')).body.items.map((d: any) => d.customerRef)).toEqual(['T-CART']);
    expect((await request(app).get('/api/decisions?limit=2')).body.items).toHaveLength(2);
  });

  it('customers sort by a behavioural field', async () => {
    const res = await request(app).get('/api/customers?sort=churn&order=desc&pageSize=2');
    expect(res.status).toBe(200);
    const churn = res.body.items.map((c: any) => c.features.churnRisk);
    expect(churn[0]).toBeGreaterThanOrEqual(churn[1]);
    expect(res.body.items[0].externalRef).toBe('T-ATRISK');
    expect((await request(app).get('/api/customers?sort=password')).status).toBe(400);
  });
});
