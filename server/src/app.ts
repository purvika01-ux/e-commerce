import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { AppError } from './infra/errors';
import type { Logger } from './infra/logger';
import { apiRouter, type ApiDeps } from './routes/api';
import { authRouter, corsAllowlist, csrfGuard, requireAuth, securityHeaders, type AuthConfig } from './security/http';
import { createRateLimiter, DEFAULT_RATE_LIMITS, rateLimit, type RateLimitSettings } from './security/rateLimit';

export interface AppOptions {
  logger: Logger;
  serveClient?: boolean;
  /** null = admin login disabled (only allowed when bound to localhost; enforced by config). */
  auth?: AuthConfig | null;
  rateLimits?: Partial<RateLimitSettings>;
  /** Express "trust proxy" setting, needed behind a hosting proxy so rate limits see the real client IP. */
  trustProxy?: boolean | number;
  hsts?: boolean;
  /** Exact origins allowed to call the API cross-origin (dashboard hosted elsewhere, local Vite). */
  corsOrigins?: readonly string[];
}

export function buildApp(deps: ApiDeps & AppOptions) {
  const app = express();
  const auth = deps.auth ?? null;
  const limits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  const apiLimiter = createRateLimiter({ windowMs: limits.windowMs, max: limits.api });
  const recommendationLimiter = createRateLimiter({ windowMs: limits.windowMs, max: limits.recommendations });
  const loginLimiter = createRateLimiter({ windowMs: limits.windowMs, max: limits.login });
  // Signed-in requests are limited per admin; anything else per client IP.
  const clientKey = (req: Request, res: Response) => String(res.locals.user ?? req.ip ?? 'unknown');
  const corsOrigins = new Set(deps.corsOrigins ?? []);

  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy ?? false);
  app.use(securityHeaders({ hsts: deps.hsts ?? false }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    const incoming = req.get('X-Request-Id');
    const id = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  // Order matters: CORS (allowlisted preflights end here) → per-IP limit → login/logout/me → session required → CSRF header → per-route limits → API.
  app.use('/api', corsAllowlist(corsOrigins));
  app.use('/api', rateLimit(apiLimiter, (req) => `ip:${req.ip}`));
  app.use('/api/auth', authRouter(auth, deps.clock, loginLimiter, deps.logger, corsOrigins));
  app.use('/api', requireAuth(auth, deps.clock));
  app.use('/api', csrfGuard(auth, corsOrigins));
  app.post('/api/recommendations', rateLimit(recommendationLimiter, (req, res) => `rec:${clientKey(req, res)}`));
  app.use('/api', apiRouter(deps));
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', 404, 'Route not found')));

  // Serve the built dashboard from the same origin when it exists.
  if (deps.serveClient) {
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
    if (fs.existsSync(dist)) {
      app.use(express.static(dist));
      app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    }
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId;
    if (err instanceof AppError) {
      // Denied requests are security-relevant: record who/what/where (never credentials or bodies).
      // The dashboard's routine "am I signed in?" check is excluded to keep the log readable.
      const denied = err.httpStatus === 401 || err.httpStatus === 403 || err.httpStatus === 429;
      if (denied && req.path !== '/api/auth/me') {
        deps.logger.warn('request denied', {
          event: 'access_denied',
          status: err.httpStatus,
          code: err.code,
          method: req.method,
          path: req.path,
          ip: req.ip,
          user: res.locals.user ?? null,
          requestId,
        });
      }
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
      return;
    }
    if (err instanceof SyntaxError && 'body' in (err as object)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body', requestId } });
      return;
    }
    if (err instanceof mongoose.Error.CastError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid identifier', requestId } });
      return;
    }
    const dbDown = err instanceof Error && /Mongo(Network|ServerSelection|NotConnected)Error|buffering timed out/.test(`${err.name} ${err.message}`);
    deps.logger.error('request failed', { requestId, error: err });
    res
      .status(dbDown ? 503 : 500)
      .json({ error: { code: dbDown ? 'SERVICE_UNAVAILABLE' : 'INTERNAL', message: dbDown ? 'Database unavailable — nothing was sent' : 'Unexpected error', requestId } });
  });
  return app;
}
