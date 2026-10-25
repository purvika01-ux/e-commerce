import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt cost parameters (Node built-in; no extra dependency). Stored with the hash so they can change later.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** Hash format: scrypt:N:r:p:<salt base64url>:<hash base64url>. No "$" so it is safe in .env files and shells. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export const PASSWORD_HASH_PATTERN = /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{32,}$/;

/** Constant-time check. Any malformed stored hash simply fails. */
export function verifyPassword(password: string, stored: string): boolean {
  if (!PASSWORD_HASH_PATTERN.test(stored)) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split(':');
  try {
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: string | null = null;
/** A real hash of a random password, used so a wrong username costs the same time as a wrong password. */
export function dummyHash(): string {
  dummy ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummy;
}
