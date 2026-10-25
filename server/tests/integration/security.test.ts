import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { silentLogger } from '../../src/infra/logger';
import { Decision, Trigger } from '../../src/models';
import type { ServiceStatus } from '../../src/routes/api';
import type { AuthConfig } from '../../src/security/http';
import { hashPassword } from '../../src/security/passwords';
import { connectTestDb, dropTestDb, FakeClock, key, makeServices, resetData, seedFixtures } from '../helpers/harness';

const PASSWORD = 'correct horse battery staple';
const AUTH: AuthConfig = {
  username: 'admin',
  passwordHash: hashPassword(PASSWORD),
  sessionSecret: 'test-session-secret-'.repeat(3),
  secureCookie: false,
  sessionTtlMs: 3_600_000,
};
const STATUS: ServiceStatus = { aiMode: 'fallback_only', model: null, telegram: { enabled: false, botUsername: null, status: 'disabled' } };
const CSRF = { 'X-Requested-With': 'offerly' };

let fx: Awaited<ReturnType<typeof seedFixtures>>;
let clock: FakeClock;
let app: ReturnType<typeof buildApp>;

function makeApp(over: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const made = makeServices();
  clock = made.clock;
  return buildApp({ services: made.services, clock, logger: silentLogger, status: () => STATUS, auth: AUTH, rateLimits: { recommendations: 3 }, ...over });
}

async function login(a = app, username = 'admin', password = PASSWORD) {
  return request(a).post('/api/auth/login').set(CSRF).send({ username, password });
}

async function sessionCookie(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
}

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
  app = makeApp();
});

describe('admin authentication', () => {
  it('every admin route needs a session; nothing is written without one', async () => {
    const offerId = fx.offerId('WINBACK15');
    const routes: [string, string][] = [
      ['get', '/api/overview'],
      ['get', '/api/customers'],
      ['get', `/api/customers/${fx.customers.atRisk}`],
      ['get', '/api/offers'],
      ['get', '/api/rules'],
      ['get', '/api/decisions'],
      ['get', '/api/deliveries'],
      ['post', '/api/recommendations'],
      ['put', '/api/rules'],
      ['post', `/api/offers/${offerId}/status`],
    ];
    for (const [method, path] of routes) {
      const res = await (request(app) as any)[method](path).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk, action: 'pause' });
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({ path, status: 401, code: 'UNAUTHENTICATED' });
    }
    expect(await Trigger.countDocuments()).toBe(0);
  });

  it('health stays public; /auth/me reports the missing session', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('a wrong password and an unknown user get the identical answer', async () => {
    const wrongPassword = await login(app, 'admin', 'nope nope nope');
    const unknownUser = await login(app, 'mallory', PASSWORD);
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('a correct login sets an HttpOnly, SameSite=Strict cookie that unlocks the API', async () => {
    const res = await login();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^offerly_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure'); // secureCookie false in this app
    const pair = cookie.split(';')[0];
    expect((await request(app).get('/api/overview').set('Cookie', pair)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', pair)).body.user.username).toBe('admin');
  });

  it('production cookies carry the Secure flag', async () => {
    const secureApp = makeApp({ auth: { ...AUTH, secureCookie: true } });
    const res = await login(secureApp);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Secure');
  });

  it('rejects tampered and expired sessions', async () => {
    const pair = await sessionCookie();
    expect((await request(app).get('/api/offers').set('Cookie', pair.slice(0, -2) + 'xx')).status).toBe(401);
    clock.advance(AUTH.sessionTtlMs + 1);
    expect((await request(app).get('/api/offers').set('Cookie', pair)).status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const pair = await sessionCookie();
    const res = await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', pair);
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
  });

  it('reports when login is not configured (local-only mode)', async () => {
    const open = makeApp({ auth: null });
    expect((await request(open).get('/api/auth/me')).body).toEqual({ authRequired: false, user: null });
  });
});

describe('CSRF protection', () => {
  it('state-changing requests without the custom header are refused, even when signed in', async () => {
    const pair = await sessionCookie();
    const blocked = await request(app).post('/api/recommendations').set('Cookie', pair).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk });
    expect(blocked.status).toBe(403);
    expect(await Trigger.countDocuments()).toBe(0);
    const ok = await request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk });
    expect(ok.status).toBe(201);
  });

  it('login itself needs the header', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('rate limiting', () => {
  it('the 6th login attempt in a minute gets 429 — even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login(app, 'admin', 'wrong wrong wrong')).status).toBe(401);
    const res = await login();
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('recommendations are limited per admin (3 per window in this test app)', async () => {
    const pair = await sessionCookie();
    const send = () =>
      request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk, dryRun: true });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(201);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(await Decision.countDocuments()).toBe(3);
  });
});

describe('security headers', () => {
  it('are set on API responses and errors', async () => {
    for (const path of ['/api/health', '/api/does-not-exist']) {
      const res = await request(app).get(path);
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('HSTS only when enabled (production over HTTPS)', async () => {
    expect((await request(app).get('/api/health')).headers['strict-transport-security']).toBeUndefined();
    const prod = makeApp({ hsts: true });
    expect((await request(prod).get('/api/health')).headers['strict-transport-security']).toContain('max-age=');
  });
});
