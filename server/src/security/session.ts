import { createHmac, randomBytes } from 'node:crypto';
import { AdminSession } from '../models';

/** Production uses the __Host- prefix: browsers then require Secure, Path=/ and no Domain (no subdomain can set it). */
export const sessionCookieName = (secure: boolean) => (secure ? '__Host-offerly_session' : 'offerly_session');

export interface SessionPolicy {
  secret: string;
  absoluteTtlMs: number;
  idleTimeoutMs: number;
}

/** Only this keyed hash is stored, so a database leak does not reveal usable session tokens. */
const hashToken = (token: string, secret: string) => createHmac('sha256', secret).update(token).digest('base64url');

/** Creates a new session (a fresh random token on every login, which also prevents session fixation). */
export async function createSession(username: string, policy: SessionPolicy, now: Date): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + policy.absoluteTtlMs);
  await AdminSession.create({ tokenHash: hashToken(token, policy.secret), username, createdAt: now, lastSeenAt: now, expiresAt });
  return { token, expiresAt };
}

/**
 * Resolves a session token. Rejects unknown, revoked, absolutely expired or idle sessions.
 * Activity extends the idle window (written at most once a minute to keep reads cheap).
 */
export async function resolveSession(
  token: string | undefined,
  policy: SessionPolicy,
  now: Date,
): Promise<{ username: string; expiresAt: Date; idleExpiresAt: Date } | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hashToken(token, policy.secret);
  const s = await AdminSession.findOne({ tokenHash }).lean();
  if (!s) return null;
  const idleDeadline = new Date(s.lastSeenAt.getTime() + policy.idleTimeoutMs);
  if (s.expiresAt <= now || idleDeadline <= now) {
    await AdminSession.deleteOne({ _id: s._id });
    return null;
  }
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
    await AdminSession.updateOne({ _id: s._id }, { lastSeenAt: now });
  }
  return { username: s.username, expiresAt: s.expiresAt, idleExpiresAt: new Date(now.getTime() + policy.idleTimeoutMs) };
}

/** Logout: the session is deleted server-side, so a copied cookie stops working immediately. */
export async function destroySession(token: string | undefined, policy: SessionPolicy): Promise<void> {
  if (!token) return;
  await AdminSession.deleteOne({ tokenHash: hashToken(token, policy.secret) });
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

/**
 * SameSite=None only when the dashboard is on another site (e.g. Vercel) and the cookie is Secure;
 * browsers reject SameSite=None without Secure. CSRF is then covered by the header + origin allowlist.
 */
const sameSiteOf = (secure: boolean, crossSite = false) => (secure && crossSite ? 'SameSite=None' : 'SameSite=Strict');

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeMs: number; crossSite?: boolean }): string {
  const parts = [`${sessionCookieName(opts.secure)}=${token}`, 'Path=/', 'HttpOnly', sameSiteOf(opts.secure, opts.crossSite), `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean, crossSite = false): string {
  return [`${sessionCookieName(secure)}=`, 'Path=/', 'HttpOnly', sameSiteOf(secure, crossSite), 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}
