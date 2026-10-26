import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { TelegramSendError } from '../../src/delivery/telegramSender';
import type { Logger } from '../../src/infra/logger';
import { Offer } from '../../src/models';
import type { ServiceStatus } from '../../src/routes/api';
import { USERNAME_LOCKOUT, type AuthConfig } from '../../src/security/http';
import { hashPassword } from '../../src/security/passwords';
import { createDeliveryService } from '../../src/delivery/service';
import { createServices } from '../../src/services';
import { connectTestDb, dropTestDb, FakeClock, FakeTelegram, key, linkTelegram, resetData, seedFixtures } from '../helpers/harness';

const PASSWORD = 'correct horse battery staple';
const AUTH: AuthConfig = {
  username: 'admin',
  passwordHash: await hashPassword(PASSWORD, { N: 2 ** 14 }),
  sessionSecret: 'audit-session-secret-'.repeat(3),
  secureCookie: false,
  sessionTtlMs: 3_600_000,
  idleTimeoutMs: 1_800_000,
};
const STATUS: ServiceStatus = { aiMode: 'fallback_only', model: null, telegram: { enabled: true, botUsername: 'test_bot', status: 'polling' } };
const CSRF = { 'X-Requested-With': 'offerly' };

let fx: Awaited<ReturnType<typeof seedFixtures>>;
let lines: string[];
let telegram: FakeTelegram;
let app: ReturnType<typeof buildApp>;

const events = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
const byEvent = (name: string) => events().filter((e) => e.event === name);

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
  lines = [];
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ level, msg, ...fields }));
  const logger: Logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  telegram = new FakeTelegram();
  // Services and app share the capturing logger, so delivery and admin events land in `lines`.
  const clock = new FakeClock();
  let n = 0;
  const services = createServices({ clock, ai: null, telegram, logger, newGrantCode: () => `OFR-AUDT-${String(++n).padStart(2, '0')}`, sleep: async () => undefined });
  app = buildApp({ services, clock, logger, status: () => STATUS, auth: AUTH, rateLimits: { login: 1000 } });
});

async function signIn(): Promise<string> {
  const res = await request(app).post('/api/auth/login').set(CSRF).send({ username: 'admin', password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
}

describe('security events are logged', () => {
  it('failed sign-ins, lockouts, CSRF blocks and unauthenticated access are recorded', async () => {
    await request(app).post('/api/auth/login').set(CSRF).send({ username: 'admin', password: 'wrong wrong wrong' });
    await request(app).get('/api/offers'); // no session
    await request(app).get('/api/auth/me'); // routine check: not logged
    const pair = await signIn();
    await request(app).put('/api/rules').set('Cookie', pair).set('Origin', 'https://evil.example').set(CSRF).send({});
    for (let i = 0; i < USERNAME_LOCKOUT.maxFailures; i++) {
      await request(app).post('/api/auth/login').set(CSRF).send({ username: 'mallory', password: `guess-${i}-guess` });
    }

    const denied = byEvent('access_denied').map((e) => `${e.status} ${e.code} ${e.method} ${e.path}`);
    expect(denied).toContain('401 INVALID_CREDENTIALS POST /api/auth/login');
    expect(denied).toContain('401 UNAUTHENTICATED GET /api/offers');
    expect(denied).toContain('403 FORBIDDEN PUT /api/rules');
    expect(denied.some((d) => d.includes('/api/auth/me'))).toBe(false);
    expect(byEvent('login_locked')).toHaveLength(1);
    expect(byEvent('login_locked')[0]).toMatchObject({ usernameMatches: false });
    expect(byEvent('login_succeeded')[0]).toMatchObject({ user: 'admin' });
  });

  it('logs never contain passwords, attempted usernames, session tokens, hashes or secrets', async () => {
    const pair = await signIn();
    await request(app).post('/api/auth/login').set(CSRF).send({ username: 'typo-of-a-password', password: 'wrong wrong wrong' });
    await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', pair);
    const all = lines.join('\n');
    const token = pair.split('=')[1];
    for (const secret of [PASSWORD, 'wrong wrong wrong', 'typo-of-a-password', token, AUTH.passwordHash, AUTH.sessionSecret]) {
      expect(all.includes(secret)).toBe(false);
    }
    expect(byEvent('logout')).toHaveLength(1);
  });
});

describe('admin actions are logged with the acting user', () => {
  it('rule changes, offer status changes and decisions', async () => {
    const pair = await signIn();
    const rules = (await request(app).get('/api/rules').set('Cookie', pair)).body.rules.map(({ key, type, enabled, params }: any) => ({ key, type, enabled, params }));
    await request(app).put('/api/rules').set('Cookie', pair).set(CSRF).send({ expectedVersion: 1, changeNote: 'Tighten for Diwali', rules });
    await request(app).post(`/api/offers/${fx.offerId('FREESHIP')}/status`).set('Cookie', pair).set(CSRF).send({ action: 'pause' });
    await request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk });

    expect(byEvent('rules_updated')[0]).toMatchObject({ user: 'admin', fromVersion: 1, toVersion: 2, changeNote: 'Tighten for Diwali' });
    expect(byEvent('offer_status_changed')[0]).toMatchObject({ user: 'admin', offer: 'FREESHIP', from: 'active', to: 'paused' });
    expect(byEvent('recommendation_decided')[0]).toMatchObject({ user: 'admin', customer: 'T-ATRISK', status: 'approved', offer: 'WINBACK15' });
  });
});

describe('delivery failures are logged', () => {
  it('a pre-send cancellation and a Telegram failure each leave a useful record', async () => {
    const pair = await signIn();
    await linkTelegram(fx.customers.atRisk, 9_000_000_301);
    await linkTelegram(fx.customers.atRisk2, 9_000_000_302);

    // 1) Offer paused between approval and send → cancelled by the pre-send check.
    const approve = await request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk });
    expect(approve.body.decision.status).toBe('approved');
    await Offer.updateOne({ code: 'WINBACK15' }, { status: 'paused' });
    const logger: Logger = { debug() {}, info() {}, warn: (m, f) => lines.push(JSON.stringify({ level: 'warn', msg: m, ...f })), error() {} };
    await createDeliveryService({ clock: { now: () => new Date('2026-10-22T10:00:00Z') }, telegram, logger }).deliver(approve.body.decision.id);
    expect(byEvent('delivery_cancelled')[0]).toMatchObject({ customer: 'T-ATRISK', rules: expect.arrayContaining(['OFFER_INACTIVE']) });

    // 2) Telegram says the user blocked the bot → permanent failure.
    await Offer.updateOne({ code: 'WINBACK15' }, { status: 'active' });
    telegram.failNext(new TelegramSendError('blocked', 'blocked'));
    await request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk2, channel: 'telegram' });
    expect(byEvent('delivery_failed')[0]).toMatchObject({ customer: 'T-ATRISK2', kind: 'blocked' });
  });
});
