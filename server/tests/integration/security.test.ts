import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { silentLogger } from '../../src/infra/logger';
import { AdminSession, Offer, RuleSet, Trigger } from '../../src/models';
import type { ServiceStatus } from '../../src/routes/api';
import { USERNAME_LOCKOUT, type AuthConfig } from '../../src/security/http';
import { hashPassword } from '../../src/security/passwords';
import { connectTestDb, dropTestDb, FakeClock, key, makeServices, resetData, seedFixtures } from '../helpers/harness';

const PASSWORD = 'correct horse battery staple';
const MIN = 60_000;
const AUTH: AuthConfig = {
  username: 'admin',
  passwordHash: await hashPassword(PASSWORD, { N: 2 ** 14 }), // low cost only to keep the suite quick
  sessionSecret: 'test-session-secret-'.repeat(3),
  secureCookie: false,
  sessionTtlMs: 60 * MIN,
  idleTimeoutMs: 30 * MIN,
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

const login = (a = app, username = 'admin', password = PASSWORD) => request(a).post('/api/auth/login').set(CSRF).send({ username, password });
const cookiePair = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

async function signIn(a = app): Promise<string> {
  const res = await login(a);
  expect(res.status).toBe(200);
  return cookiePair(res);
}

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
  app = makeApp();
});

describe('unauthenticated and direct API access', () => {
  it('every admin route returns 401 without a session; nothing is written', async () => {
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
      ['post', '/api/offers'],
      ['patch', `/api/offers/${offerId}`],
    ];
    for (const [method, path] of routes) {
      const res = await (request(app) as any)[method](path).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk, action: 'pause' });
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({ path, status: 401, code: 'UNAUTHENTICATED' });
      expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts/); // no stack traces
    }
    expect(await Trigger.countDocuments()).toBe(0);
  });

  it('unauthenticated mutations cannot change rules, offers or budgets', async () => {
    const before = await Offer.findOne({ code: 'WINBACK15' }).lean();
    await request(app).put('/api/rules').set(CSRF).send({ expectedVersion: 1, changeNote: 'x', rules: [] });
    await request(app).post(`/api/offers/${fx.offerId('WINBACK15')}/status`).set(CSRF).send({ action: 'pause' });
    const after = await Offer.findOne({ code: 'WINBACK15' }).lean();
    expect(after!.status).toBe('active');
    expect(after!.budget).toEqual(before!.budget);
    expect(await RuleSet.countDocuments()).toBe(1);
  });

  it('a forged or random session cookie is rejected', async () => {
    for (const forged of ['offerly_session=abc', `offerly_session=${'A'.repeat(43)}`, 'offerly_session=../../etc']) {
      expect((await request(app).get('/api/offers').set('Cookie', forged)).status).toBe(401);
    }
  });

  it('health stays public; /auth/me reports the missing session', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });
});

describe('login', () => {
  it('valid login creates a server-side session; only a hash of the token is stored', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^offerly_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict/);
    const token = cookiePair(res).split('=')[1];
    const stored = await AdminSession.find().lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toBe(token);
    expect((await request(app).get('/api/overview').set('Cookie', cookiePair(res))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookiePair(res))).body.user.username).toBe('admin');
  });

  it('invalid login: wrong password and unknown user get the identical 401 and no session', async () => {
    const wrongPassword = await login(app, 'admin', 'nope nope nope');
    const unknownUser = await login(app, 'mallory', PASSWORD);
    expect([wrongPassword.status, unknownUser.status]).toEqual([401, 401]);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    expect(await AdminSession.countDocuments()).toBe(0);
  });

  it('every login issues a fresh token (no session fixation)', async () => {
    const a = await signIn();
    const b = await signIn();
    expect(a).not.toBe(b);
  });

  it('production cookies use the __Host- prefix and Secure, and are accepted back', async () => {
    const secureApp = makeApp({ auth: { ...AUTH, secureCookie: true } });
    const res = await login(secureApp);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie.startsWith('__Host-offerly_session=')).toBe(true);
    expect(cookie).toContain('Secure');
    expect((await request(secureApp).get('/api/offers').set('Cookie', cookiePair(res))).status).toBe(200);
  });

  it('reports when login is not configured (local-only mode)', async () => {
    const open = makeApp({ auth: null });
    expect((await request(open).get('/api/auth/me')).body).toEqual({ authRequired: false, user: null });
  });
});

describe('session expiry', () => {
  it('ends after the idle timeout without activity', async () => {
    const pair = await signIn();
    clock.advance(AUTH.idleTimeoutMs + 1);
    expect((await request(app).get('/api/offers').set('Cookie', pair)).status).toBe(401);
    expect(await AdminSession.countDocuments()).toBe(0); // expired sessions are removed
  });

  it('activity extends the idle window, but never past the absolute lifetime', async () => {
    const pair = await signIn();
    clock.advance(25 * MIN);
    expect((await request(app).get('/api/offers').set('Cookie', pair)).status).toBe(200);
    clock.advance(25 * MIN); // 50 min total; idle reset by the request above
    expect((await request(app).get('/api/offers').set('Cookie', pair)).status).toBe(200);
    clock.advance(15 * MIN); // 65 min > 60 min absolute lifetime
    expect((await request(app).get('/api/offers').set('Cookie', pair)).status).toBe(401);
  });

  it('expired sessions are also cleaned up by MongoDB (TTL index on expiresAt)', async () => {
    const indexes = await AdminSession.collection.indexes();
    expect(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });
});

describe('logout', () => {
  it('revokes the session server-side, so a copied cookie stops working', async () => {
    const pair = await signIn();
    const res = await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', pair);
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
    expect(await AdminSession.countDocuments()).toBe(0);
    expect((await request(app).get('/api/overview').set('Cookie', pair)).status).toBe(401);
  });

  it('logging out one session leaves other sessions signed in', async () => {
    const a = await signIn();
    const b = await signIn();
    await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', a);
    expect((await request(app).get('/api/overview').set('Cookie', b)).status).toBe(200);
  });
});

describe('CSRF protection (403)', () => {
  it('state-changing requests need the custom header, even when signed in', async () => {
    const pair = await signIn();
    const blocked = await request(app).post('/api/recommendations').set('Cookie', pair).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk });
    expect(blocked.status).toBe(403);
    expect(await Trigger.countDocuments()).toBe(0);
    const ok = await request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk });
    expect(ok.status).toBe(201);
  });

  it('requests that come from another site are refused even with the header', async () => {
    const pair = await signIn();
    const fromEvil = await request(app).put('/api/rules').set('Cookie', pair).set(CSRF).set('Origin', 'https://evil.example').send({});
    expect(fromEvil.status).toBe(403);
    const crossSite = await request(app).put('/api/rules').set('Cookie', pair).set(CSRF).set('Sec-Fetch-Site', 'cross-site').send({});
    expect(crossSite.status).toBe(403);
    const nullOrigin = await request(app).post('/api/auth/login').set(CSRF).set('Origin', 'null').send({ username: 'admin', password: PASSWORD });
    expect(nullOrigin.status).toBe(403);
  });

  it('login and logout themselves need the header', async () => {
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD })).status).toBe(403);
    const pair = await signIn();
    expect((await request(app).post('/api/auth/logout').set('Cookie', pair)).status).toBe(403);
    expect((await request(app).get('/api/overview').set('Cookie', pair)).status).toBe(200); // not logged out
  });
});

describe('login rate limiting and lockout (429)', () => {
  it('the 6th login attempt per IP in a minute gets 429 — even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login(app, 'admin', 'wrong wrong wrong')).status).toBe(401);
    const res = await login();
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it(`a username is locked after ${USERNAME_LOCKOUT.maxFailures} failures, whatever the source address`, async () => {
    const roomy = makeApp({ rateLimits: { login: 1000 } }); // isolate the per-username rule from the per-IP one
    for (let i = 0; i < USERNAME_LOCKOUT.maxFailures; i++) expect((await login(roomy, 'admin', `wrong ${i} wrong`)).status).toBe(401);
    const locked = await login(roomy);
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).not.toMatch(/admin|exist/i);
    expect(await AdminSession.countDocuments()).toBe(0);
  });

  it('recommendations are limited per admin (3 per window in this test app)', async () => {
    const pair = await signIn();
    const send = () =>
      request(app).post('/api/recommendations').set('Cookie', pair).set(CSRF).set('Idempotency-Key', key()).send({ customerId: fx.customers.atRisk, dryRun: true });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
  });
});

describe('security headers', () => {
  it('are set on API responses and errors', async () => {
    for (const path of ['/api/health', '/api/does-not-exist']) {
      const res = await request(app).get(path);
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('HSTS only when enabled (production over HTTPS)', async () => {
    expect((await request(app).get('/api/health')).headers['strict-transport-security']).toBeUndefined();
    expect((await request(makeApp({ hsts: true })).get('/api/health')).headers['strict-transport-security']).toContain('max-age=');
  });
});
