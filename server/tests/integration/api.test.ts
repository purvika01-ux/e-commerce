import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { ServiceStatus } from '../../src/routes/api';
import { createAnthropicAiClient } from '../../src/ai/anthropicClient';
import { createTelegramSender } from '../../src/delivery/telegramSender';
import { loadConfig } from '../../src/config';
import { createLogger, silentLogger } from '../../src/infra/logger';
import { Decision, Delivery } from '../../src/models';
import { connectTestDb, dropTestDb, FakeTelegram, key, linkTelegram, makeServices, resetData, seedFixtures } from '../helpers/harness';

let fx: Awaited<ReturnType<typeof seedFixtures>>;
let telegram: FakeTelegram;
let app: ReturnType<typeof buildApp>;
let serviceStatus: ServiceStatus;

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
  telegram = new FakeTelegram();
  const { services, clock } = makeServices({ telegram });
  serviceStatus = { aiMode: 'fallback_only', model: null, telegram: { enabled: true, botUsername: 'test_bot', status: 'polling' } };
  app = buildApp({ services, clock, logger: silentLogger, status: () => serviceStatus });
});

describe('API', () => {
  it('GET /api/health reports a connected database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: { status: 'connected' } });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/health stays 200 but reports degraded when the bot has failed', async () => {
    serviceStatus.telegram = {
      ...serviceStatus.telegram,
      status: 'failed',
      lastError: { kind: 'conflict', message: 'Another process is polling this bot token', at: new Date() },
    };
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.telegram).toMatchObject({ status: 'failed', lastError: { kind: 'conflict' } });
  });

  it('POST /api/recommendations requires an Idempotency-Key and validates the body', async () => {
    const noKey = await request(app).post('/api/recommendations').send({ customerId: fx.customers.atRisk });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const bad = await request(app).post('/api/recommendations').set('Idempotency-Key', key()).send({ customerId: { $gt: '' }, extra: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(await Decision.countDocuments()).toBe(0);
  });

  it('preview (dryRun) validates without reserving, granting or sending', async () => {
    const res = await request(app).post('/api/recommendations').set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk, dryRun: true });
    expect(res.status).toBe(201);
    expect(res.body.decision.status).toBe('dry_run');
    expect(res.body.decision.lastValidation.ok).toBe(true);
    expect(res.body.decision.grant).toBeNull();
    expect(telegram.sent).toHaveLength(0);
    // Previews never appear in the decision log.
    expect((await request(app).get('/api/decisions')).body.items).toHaveLength(0);
  });

  it('decide + send via Telegram, and a replayed request does not send again', async () => {
    await linkTelegram(fx.customers.atRisk, 9_000_000_100);
    const k = key('api');
    const first = await request(app).post('/api/recommendations').set('Idempotency-Key', k).send({ customerId: fx.customers.atRisk, channel: 'telegram' });
    expect(first.status).toBe(201);
    expect(first.body.decision.status).toBe('approved');
    expect(first.body.delivery.status).toBe('sent');
    const again = await request(app).post('/api/recommendations').set('Idempotency-Key', k).send({ customerId: fx.customers.atRisk, channel: 'telegram' });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(telegram.sent).toHaveLength(1);
    expect(await Delivery.countDocuments()).toBe(1);

    const list = await request(app).get('/api/decisions');
    expect(list.body.items).toHaveLength(1);
    const detail = await request(app).get(`/api/decisions/${first.body.decision.id}`);
    expect(detail.body.deliveries).toHaveLength(1);
  });

  it('refuses Telegram delivery for an unlinked customer before doing any work', async () => {
    const res = await request(app).post('/api/recommendations').set('Idempotency-Key', key()).send({ customerId: fx.customers.cart, channel: 'telegram' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_DELIVERABLE');
    expect(await Decision.countDocuments()).toBe(0);
  });

  it('activation of an offer that breaks the rules is refused', async () => {
    const res = await request(app).post(`/api/offers/${fx.offerId('MEGA30')}/status`).send({ action: 'activate' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: any) => d.rule)).toContain('MAX_DISCOUNT_PERCENT');
  });

  it('rule updates are validated and versioned', async () => {
    const current = await request(app).get('/api/rules');
    const rules = current.body.rules.map(({ key, type, enabled, params }: any) => ({ key, type, enabled, params }));
    const invalid = await request(app)
      .put('/api/rules')
      .send({ expectedVersion: 1, changeNote: 'bad', rules: rules.map((r: any) => (r.type === 'MAX_DISCOUNT_PERCENT' ? { ...r, params: { maxPercent: 500 } } : r)) });
    expect(invalid.status).toBe(400);
    const ok = await request(app).put('/api/rules').send({ expectedVersion: 1, changeNote: 'tighten', rules });
    expect(ok.status).toBe(201);
    const stale = await request(app).put('/api/rules').send({ expectedVersion: 1, changeNote: 'stale', rules });
    expect(stale.status).toBe(409);
  });
});

describe('safety guards', () => {
  it('real Claude and Telegram clients cannot be constructed in tests', () => {
    expect(() => createAnthropicAiClient({ apiKey: 'sk-test-not-real', model: 'x', timeoutMs: 1000 })).toThrow(/tests/);
    expect(() => createTelegramSender({} as never)).toThrow(/tests/);
  });

  it('config errors name the variable but never print its value', () => {
    let message = '';
    try {
      loadConfig({ MONGODB_URI: 'postgres://user:SuperSecret@host/db', TELEGRAM_BOT_TOKEN: 'not-a-token-SECRETVALUE' } as NodeJS.ProcessEnv);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('MONGODB_URI');
    expect(message).toContain('TELEGRAM_BOT_TOKEN');
    expect(message).not.toContain('SuperSecret');
    expect(message).not.toContain('SECRETVALUE');
  });

  it('the logger redacts secrets', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (l: string) => lines.push(l);
    try {
      createLogger({ secrets: ['123456:ABCDEFabcdefABCDEFabcdef123'] }).info('sending', { url: 'https://api.telegram.org/bot123456:ABCDEFabcdefABCDEFabcdef123/send', apiKey: 'sk-live' });
    } finally {
      console.log = orig;
    }
    expect(lines[0]).not.toContain('ABCDEFabcdef');
    expect(lines[0]).not.toContain('sk-live');
  });
});
