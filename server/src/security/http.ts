import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Clock } from '../decision/orchestrator';
import { AppError, badRequest } from '../infra/errors';
import { dummyHash, verifyPassword } from './passwords';
import { rateLimit, type RateLimiter } from './rateLimit';
import { clearedSessionCookie, createSessionToken, readCookie, SESSION_COOKIE, sessionCookie, verifySessionToken } from './session';

export interface AuthConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  /** Adds the Secure cookie flag; must be true whenever the app is served over HTTPS. */
  secureCookie: boolean;
  sessionTtlMs: number;
}

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

function hasCsrfHeader(req: Request): boolean {
  return req.get(CSRF_HEADER) === CSRF_VALUE;
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Resolves the signed-in admin from the session cookie, or null. */
export function currentUser(req: Request, auth: AuthConfig, clock: Clock) {
  return verifySessionToken(readCookie(req.get('cookie'), SESSION_COOKIE), auth.sessionSecret, clock.now());
}

/** /api/auth: login, logout, me. When auth is disabled (local-only use) me reports that. */
export function authRouter(auth: AuthConfig | null, clock: Clock, loginLimiter: RateLimiter): Router {
  const r = Router();

  r.get('/me', (req, res) => {
    if (!auth) return void res.json({ authRequired: false, user: null });
    const user = currentUser(req, auth, clock);
    if (!user) throw new AppError('UNAUTHENTICATED', 401, 'Please sign in');
    res.json({ authRequired: true, user: { username: user.username, expiresAt: user.expiresAt } });
  });

  r.post(
    '/login',
    rateLimit(loginLimiter, (req) => `login:${req.ip}`),
    (req, res) => {
      if (!auth) throw new AppError('AUTH_DISABLED', 400, 'Login is not configured on this server');
      if (!hasCsrfHeader(req)) throw new AppError('FORBIDDEN', 403, 'Missing request header');
      const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }).strict().safeParse(req.body);
      if (!body.success) throw badRequest('Enter a username and password');
      // Always run the password check, even for an unknown username, so timing does not reveal valid usernames.
      const userMatches = sameString(body.data.username, auth.username);
      const passwordMatches = verifyPassword(body.data.password, userMatches ? auth.passwordHash : dummyHash());
      if (!userMatches || !passwordMatches) throw new AppError('INVALID_CREDENTIALS', 401, 'Incorrect username or password');
      const token = createSessionToken(auth.username, auth.sessionSecret, clock.now(), auth.sessionTtlMs);
      res.setHeader('Set-Cookie', sessionCookie(token, { secure: auth.secureCookie, maxAgeMs: auth.sessionTtlMs }));
      res.json({ authRequired: true, user: { username: auth.username } });
    },
  );

  r.post('/logout', (req, res) => {
    if (auth && !hasCsrfHeader(req)) throw new AppError('FORBIDDEN', 403, 'Missing request header');
    res.setHeader('Set-Cookie', clearedSessionCookie(auth?.secureCookie ?? false));
    res.status(204).end();
  });

  return r;
}

/** Every /api route except health and /auth requires a valid session when auth is configured. */
export function requireAuth(auth: AuthConfig | null, clock: Clock) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!auth || req.path === '/health') return next();
    const user = currentUser(req, auth, clock);
    if (!user) return next(new AppError('UNAUTHENTICATED', 401, 'Please sign in'));
    res.locals.user = user.username;
    next();
  };
}

/** CSRF defence for cookie sessions: state-changing requests must carry a custom header. */
export function csrfGuard(auth: AuthConfig | null) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!auth || SAFE_METHODS.has(req.method) || hasCsrfHeader(req)) return next();
    next(new AppError('FORBIDDEN', 403, 'Missing request header'));
  };
}
