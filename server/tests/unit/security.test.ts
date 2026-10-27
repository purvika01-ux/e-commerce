import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { hashPassword, verifyPassword } from '../../src/security/passwords';
import { createRateLimiter } from '../../src/security/rateLimit';
import { clearedSessionCookie, readCookie, sessionCookie, sessionCookieName } from '../../src/security/session';

const SECRET = 's'.repeat(40);
const FAST = { N: 2 ** 14 }; // lower cost only to keep most unit tests quick

describe('password hashing', () => {
  it('uses the OWASP scrypt cost by default and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith(`scrypt:${2 ** 17}:8:1:`)).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
  });

  it('still verifies hashes made with the older, lower cost (no forced migration)', async () => {
    const legacy = await hashPassword('legacy password', FAST);
    expect(legacy.startsWith(`scrypt:${2 ** 14}:`)).toBe(true);
    expect(await verifyPassword('legacy password', legacy)).toBe(true);
  });

  it('salts every hash and rejects malformed or tampered stored values', async () => {
    const a = await hashPassword('same', FAST);
    expect(a).not.toBe(await hashPassword('same', FAST));
    expect(a).not.toContain('$');
    const absurd = a.replace(`scrypt:${2 ** 14}:`, `scrypt:${2 ** 30}:`);
    for (const bad of ['', 'plaintext', 'scrypt:1:2', a.replace('scrypt', 'bcrypt'), absurd]) expect(await verifyPassword('x', bad)).toBe(false);
  });
});

describe('session cookies', () => {
  it('are HttpOnly, SameSite=Strict, and use the __Host- prefix with Secure in production', () => {
    const dev = sessionCookie('tok', { secure: false, maxAgeMs: 3_600_000 });
    expect(dev).toMatch(/^offerly_session=tok; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
    const prod = sessionCookie('tok', { secure: true, maxAgeMs: 3_600_000 });
    expect(prod.startsWith('__Host-offerly_session=tok; Path=/;')).toBe(true);
    expect(prod).toContain('Secure');
    expect(prod).not.toContain('Domain');
    expect(clearedSessionCookie(true)).toContain('Max-Age=0');
    expect(sessionCookieName(true)).toBe('__Host-offerly_session');
  });

  it('use SameSite=None only for a Secure cookie when the dashboard is on another site', () => {
    expect(sessionCookie('tok', { secure: true, maxAgeMs: 3_600_000, crossSite: true })).toBe('__Host-offerly_session=tok; Path=/; HttpOnly; SameSite=None; Max-Age=3600; Secure');
    expect(sessionCookie('tok', { secure: false, maxAgeMs: 3_600_000, crossSite: true })).toContain('SameSite=Strict');
    expect(clearedSessionCookie(true, true)).toContain('SameSite=None');
    expect(clearedSessionCookie(true)).toContain('SameSite=Strict');
  });

  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; offerly_session=tok%2Ben; b=2', 'offerly_session')).toBe('tok+en');
    expect(readCookie('a=1', 'offerly_session')).toBeUndefined();
    expect(readCookie(undefined, 'offerly_session')).toBeUndefined();
  });
});

describe('rate limiter', () => {
  it('allows max hits per window per key, then resets', () => {
    let t = 0;
    const l = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    expect([l.hit('a').allowed, l.hit('a').allowed, l.hit('a').allowed]).toEqual([true, true, false]);
    expect(l.hit('b').allowed).toBe(true);
    expect(l.hit('a').retryAfterSec).toBe(1);
    t = 1000;
    expect(l.hit('a').allowed).toBe(true);
  });
});

describe('configuration guard', () => {
  const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/offerly' };
  const message = (env: Record<string, string>) => {
    try {
      loadConfig(env as NodeJS.ProcessEnv);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('has no default password: login can only be skipped on localhost in development', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).authEnabled).toBe(false);
    expect(message({ ...base, NODE_ENV: 'production' })).toContain('ADMIN_PASSWORD_HASH and SESSION_SECRET');
    expect(message({ ...base, HOST: '0.0.0.0' })).toContain('ADMIN_PASSWORD_HASH and SESSION_SECRET');
  });

  it('CORS_ORIGINS: exact https origins in production, local Vite only in development, nothing by default in production', async () => {
    const hash = await hashPassword('a long admin password', FAST);
    const prod = { ...base, NODE_ENV: 'production', HOST: '0.0.0.0', ADMIN_PASSWORD_HASH: hash, SESSION_SECRET: SECRET };
    const none = loadConfig(prod as NodeJS.ProcessEnv);
    expect(none.corsOrigins).toEqual([]);
    expect(none.crossSiteCookie).toBe(false);

    const vercel = loadConfig({ ...prod, CORS_ORIGINS: ' https://my-app.vercel.app/ , https://www.example.com' } as NodeJS.ProcessEnv);
    expect(vercel.corsOrigins).toEqual(['https://my-app.vercel.app', 'https://www.example.com']);
    expect(vercel.crossSiteCookie).toBe(true);

    for (const bad of ['*', 'https://*.vercel.app', 'https://my-app.vercel.app/login', 'my-app.vercel.app', 'ftp://x.example']) {
      expect(message({ ...prod, CORS_ORIGINS: bad })).toContain('CORS_ORIGINS');
    }
    expect(message({ ...prod, CORS_ORIGINS: 'http://my-app.vercel.app' })).toContain('https://');

    const dev = loadConfig(base as NodeJS.ProcessEnv);
    expect(dev.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(dev.crossSiteCookie).toBe(false);
  });

  it('enables login when both values are present, and rejects half a configuration', async () => {
    const hash = await hashPassword('a long admin password', FAST);
    const cfg = loadConfig({ ...base, NODE_ENV: 'production', HOST: '0.0.0.0', ADMIN_PASSWORD_HASH: hash, SESSION_SECRET: SECRET } as NodeJS.ProcessEnv);
    expect(cfg.authEnabled).toBe(true);
    expect(cfg.SESSION_IDLE_MINUTES).toBe(60);
    expect(message({ ...base, ADMIN_PASSWORD_HASH: hash })).toContain('SESSION_SECRET');
    expect(message({ ...base, SESSION_SECRET: SECRET })).toContain('ADMIN_PASSWORD_HASH');
  });

  it('names invalid variables without printing their values', () => {
    const msg = message({ ...base, ADMIN_PASSWORD_HASH: 'myplaintextpassword', SESSION_SECRET: 'tooShortSecretValue' });
    expect(msg).toContain('ADMIN_PASSWORD_HASH');
    expect(msg).toContain('SESSION_SECRET');
    expect(msg).not.toContain('myplaintextpassword');
    expect(msg).not.toContain('tooShortSecretValue');
  });
});
