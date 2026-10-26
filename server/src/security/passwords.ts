import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (Node built-in, RFC 7914). Cost follows the OWASP Password Storage
 * Cheat Sheet minimum for scrypt: N=2^17, r=8, p=1 (~128 MiB per hash). Parameters are stored in
 * each hash, so older hashes (e.g. N=2^14) still verify and can be upgraded by re-running setup-admin.
 */
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

// One hash at a time: each needs ~128 MiB, and a small hosting instance must not run several at once.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Hash format: scrypt:N:r:p:<salt base64url>:<hash base64url>. No "$", so it is safe in .env files and shells. */
export async function hashPassword(password: string, cost: { N?: number } = {}): Promise<string> {
  const n = cost.N ?? N;
  const salt = randomBytes(16);
  const hash = await serialized(() => scryptAsync(password, salt, KEYLEN, { N: n, r: R, p: P, maxmem: MAXMEM }));
  return ['scrypt', n, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export const PASSWORD_HASH_PATTERN = /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{32,}$/;

/** Constant-time check, run off the event loop. Any malformed stored hash simply fails. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!PASSWORD_HASH_PATTERN.test(stored)) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split(':');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  // Refuse absurd parameters (a tampered hash must not be able to exhaust memory).
  if (params.N > 2 ** 20 || params.r > 32 || params.p > 4) return false;
  try {
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = await serialized(() => scryptAsync(password, Buffer.from(saltB64, 'base64url'), expected.length, { ...params, maxmem: MAXMEM }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/** A real hash (same cost as the configured one) so a wrong username takes as long as a wrong password. */
export function dummyHashLike(stored: string): Promise<string> {
  const n = Number(stored.split(':')[1]) || N;
  dummy ??= hashPassword(randomBytes(24).toString('base64url'), { N: n });
  return dummy;
}
