import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { hashPassword, verifyPassword } from '../../src/security/passwords';
import { createRateLimiter } from '../../src/security/rateLimit';
import { createSessionToken, readCookie, verifySessionToken } from '../../src/security/session';

const SECRET = 's'.repeat(40);
const NOW = new Date('2026-10-25T10:00:00Z');

describe('password hashing', () => {
  const hash = hashPassword('correct horse battery');
  it('verifies the right password and rejects others', () => {
    expect(verifyPassword('correct horse battery', hash)).toBe(true);
    expect(verifyPassword('correct horse batterY', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });
  it('salts every hash and rejects malformed stored values', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
    expect(hash).not.toContain('$');
    for (const bad of ['', 'plaintext', 'scrypt:1:2', hash.replace('scrypt', 'bcrypt')]) expect(verifyPassword('x', bad)).toBe(false);
  });
});

describe('session tokens', () => {
  const token = createSessionToken('admin', SECRET, NOW, 3_600_000);
  it('accepts a valid token until it expires', () => {
    expect(verifySessionToken(token, SECRET, NOW)?.username).toBe('admin');
    expect(verifySessionToken(token, SECRET, new Date(NOW.getTime() + 3_600_000))).toBeNull();
  });
  it('rejects tampering, the wrong secret and garbage', () => {
    const [data, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'admin', iat: 0, exp: 9e15 })).toString('base64url');
    expect(verifySessionToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySessionToken(`${data}.${sig}x`, SECRET, NOW)).toBeNull();
    expect(verifySessionToken(token, 't'.repeat(40), NOW)).toBeNull();
    for (const g of [undefined, '', 'abc', 'a.b.c', '.']) expect(verifySessionToken(g, SECRET, NOW)).toBeNull();
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
  const hash = hashPassword('a long admin password');
  const message = (env: Record<string, string>) => {
    try {
      loadConfig(env as NodeJS.ProcessEnv);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('allows running without login only on localhost in development', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).authEnabled).toBe(false);
    expect(message({ ...base, NODE_ENV: 'production' })).toContain('ADMIN_PASSWORD_HASH and SESSION_SECRET');
    expect(message({ ...base, HOST: '0.0.0.0' })).toContain('ADMIN_PASSWORD_HASH and SESSION_SECRET');
  });

  it('enables login when both values are present, and rejects half a configuration', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'production', HOST: '0.0.0.0', ADMIN_PASSWORD_HASH: hash, SESSION_SECRET: SECRET } as NodeJS.ProcessEnv);
    expect(cfg.authEnabled).toBe(true);
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
