import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Clock } from '../decision/orchestrator';
import { AppError, badRequest } from '../infra/errors';
import type { Logger } from '../infra/logger';
import { dummyHashLike, verifyPassword } from './passwords';
import { createRateLimiter, rateLimit, type RateLimiter } from './rateLimit';
import { clearedSessionCookie, createSession, destroySession, readCookie, resolveSession, sessionCookie, sessionCookieName, type SessionPolicy } from './session';

export interface AuthConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  /** Adds the Secure flag and the __Host- cookie prefix; must be true whenever the app is served over HTTPS. */
  secureCookie: boolean;
  /** Absolute session lifetime. */
  sessionTtlMs: number;
  /** Sign out after this long without activity. */
  idleTimeoutMs: number;
  /** The dashboard is hosted on another site (CORS_ORIGINS in production): cookie becomes SameSite=None. */
  crossSiteCookie?: boolean;
}

/** Failed logins per username before that username is locked for the rest of the window. */
export const USERNAME_LOCKOUT = { maxFailures: 10, windowMs: 15 * 60_000 };

const policyOf = (auth: AuthConfig): SessionPolicy => ({ secret: auth.sessionSecret, absoluteTtlMs: auth.sessionTtlMs, idleTimeoutMs: auth.idleTimeoutMs });
const tokenOf = (req: Request, auth: AuthConfig) => readCookie(req.get('cookie'), sessionCookieName(auth.secureCookie));

export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'offerly';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Browser hardening headers, set directly (no extra dependency). */
export function securityHeaders(opts: { hsts: boolean }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (opts.hsts) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE';
const CORS_HEADERS = `Content-Type, ${CSRF_HEADER}, Idempotency-Key, X-Request-Id`;

/**
 * CORS for an explicit allowlist of dashboard origins (e.g. the Vercel deployment and the local Vite
 * dev server). Allowed preflights are answered before rate limits and auth, since browsers send them
 * without cookies. Any other origin gets no access headers, so the browser keeps blocking it.
 */
export function corsAllowlist(allowed: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (allowed.size === 0) return next();
    res.vary('Origin');
    const origin = req.get('Origin');
    if (!origin || !allowed.has(origin)) return next();
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS' && req.get('Access-Control-Request-Method')) {
      res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      return void res.status(204).end();
    }
    next();
  };
}

function hasCsrfHeader(req: Request): boolean {
  return req.get(CSRF_HEADER) === CSRF_VALUE;
}

/**
 * Second CSRF layer: browsers send Origin (and Sec-Fetch-Site) on state-changing requests.
 * A request that says it comes from another site is refused even if it somehow carries the header,
 * unless its Origin is one of the configured dashboard origins.
 */
function isCrossSite(req: Request, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = req.get('Origin');
  if (origin && trustedOrigins.has(origin)) return false;
  if (req.get('Sec-Fetch-Site') === 'cross-site') return true;
  if (!origin || origin === 'null') return origin === 'null';
  return origin !== `${req.protocol}://${req.get('host')}`;
}

function assertSameSiteRequest(req: Request, trustedOrigins: ReadonlySet<string>) {
  if (!hasCsrfHeader(req) || isCrossSite(req, trustedOrigins)) throw new AppError('FORBIDDEN', 403, 'Request blocked by CSRF protection');
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** /api/auth: login, logout, me. When auth is disabled (local-only use) me reports that. */
export function authRouter(auth: AuthConfig | null, clock: Clock, loginLimiter: RateLimiter, logger: Logger, trustedOrigins: ReadonlySet<string> = new Set()): Router {
  const r = Router();
  // The limiter reports "not allowed" once the count exceeds max, so max = maxFailures - 1 locks on the Nth failure.
  const failures = createRateLimiter({ windowMs: USERNAME_LOCKOUT.windowMs, max: USERNAME_LOCKOUT.maxFailures - 1 });
  const lockedUntil = new Map<string, number>();

  r.get('/me', async (req, res) => {
    if (!auth) return void res.json({ authRequired: false, user: null });
    const session = await resolveSession(tokenOf(req, auth), policyOf(auth), clock.now());
    if (!session) throw new AppError('UNAUTHENTICATED', 401, 'Please sign in');
    res.json({ authRequired: true, user: { username: session.username, expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt } });
  });

  r.post(
    '/login',
    rateLimit(loginLimiter, (req) => `login:${req.ip}`),
    async (req, res) => {
      if (!auth) throw new AppError('AUTH_DISABLED', 400, 'Login is not configured on this server');
      assertSameSiteRequest(req, trustedOrigins);
      const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }).strict().safeParse(req.body);
      if (!body.success) throw badRequest('Enter a username and password');

      // Per-username lockout (any username string, so it reveals nothing about which usernames exist).
      const key = body.data.username.toLowerCase();
      const until = lockedUntil.get(key) ?? 0;
      if (until > Date.now()) {
        const retryAfterSec = Math.ceil((until - Date.now()) / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        throw new AppError('RATE_LIMITED', 429, 'Too many failed sign-in attempts. Try again later.');
      }

      // Always run the password check, even for an unknown username, so timing does not reveal valid usernames.
      const userMatches = sameString(body.data.username, auth.username);
      const passwordMatches = await verifyPassword(body.data.password, userMatches ? auth.passwordHash : await dummyHashLike(auth.passwordHash));
      if (!userMatches || !passwordMatches) {
        const hit = failures.hit(key);
        if (!hit.allowed) {
          lockedUntil.set(key, Date.now() + hit.retryAfterSec * 1000);
          // The typed username is not logged (it may be a mistyped password); only whether it matched.
          logger.warn('admin username locked after repeated failed sign-ins', { event: 'login_locked', usernameMatches: userMatches, ip: req.ip, lockSec: hit.retryAfterSec });
        }
        throw new AppError('INVALID_CREDENTIALS', 401, 'Incorrect username or password');
      }
      lockedUntil.delete(key);

      const session = await createSession(auth.username, policyOf(auth), clock.now());
      res.setHeader('Set-Cookie', sessionCookie(session.token, { secure: auth.secureCookie, maxAgeMs: auth.sessionTtlMs, crossSite: auth.crossSiteCookie }));
      res.setHeader('Cache-Control', 'no-store');
      logger.info('admin signed in', { event: 'login_succeeded', user: auth.username, ip: req.ip });
      res.json({ authRequired: true, user: { username: auth.username, expiresAt: session.expiresAt } });
    },
  );

  r.post('/logout', async (req, res) => {
    if (auth) {
      assertSameSiteRequest(req, trustedOrigins);
      await destroySession(tokenOf(req, auth), policyOf(auth));
      logger.info('admin signed out', { event: 'logout', ip: req.ip });
    }
    res.setHeader('Set-Cookie', clearedSessionCookie(auth?.secureCookie ?? false, auth?.crossSiteCookie));
    res.status(204).end();
  });

  return r;
}

/** Every /api route except health and /auth requires a valid server-side session when auth is configured. */
export function requireAuth(auth: AuthConfig | null, clock: Clock) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!auth || req.path === '/health') return next();
    try {
      const session = await resolveSession(tokenOf(req, auth), policyOf(auth), clock.now());
      if (!session) return next(new AppError('UNAUTHENTICATED', 401, 'Please sign in'));
      res.locals.user = session.username;
      next();
    } catch (err) {
      next(err); // e.g. database unavailable → 503 from the error handler; never treated as signed in
    }
  };
}

/** CSRF defence for cookie sessions: state-changing requests need the custom header and must not be cross-site. */
export function csrfGuard(auth: AuthConfig | null, trustedOrigins: ReadonlySet<string> = new Set()) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!auth || SAFE_METHODS.has(req.method)) return next();
    try {
      assertSameSiteRequest(req, trustedOrigins);
      next();
    } catch (err) {
      next(err);
    }
  };
}
