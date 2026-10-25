import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'offerly_session';

interface SessionPayload {
  u: string; // username
  iat: number; // issued at (ms)
  exp: number; // expires at (ms)
}

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** Stateless signed session token: base64url(payload).signature. Changing SESSION_SECRET revokes all sessions. */
export function createSessionToken(username: string, secret: string, now: Date, ttlMs: number): string {
  const payload: SessionPayload = { u: username, iat: now.getTime(), exp: now.getTime() + ttlMs };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data, secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string, now: Date): { username: string; expiresAt: Date } | null {
  if (!token || token.length > 1024) return null;
  const [data, sig, extra] = token.split('.');
  if (!data || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(data, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof p.u !== 'string' || typeof p.exp !== 'number' || p.exp <= now.getTime()) return null;
    return { username: p.u, expiresAt: new Date(p.exp) };
  } catch {
    return null;
  }
}

/** Minimal cookie parser (avoids a dependency for one cookie). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeMs: number }): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}
