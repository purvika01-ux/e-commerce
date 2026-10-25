import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../infra/errors';

export interface RateLimiter {
  /** Records a hit for this key. Returns whether it is allowed and, if not, seconds until the window resets. */
  hit(key: string): { allowed: boolean; retryAfterSec: number };
}

/**
 * Fixed-window, in-memory limiter. Per process — correct for the single-instance deployment this
 * app is designed for; a multi-instance deployment would need a shared store.
 */
export function createRateLimiter(opts: { windowMs: number; max: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return {
    hit(key) {
      const t = now();
      if (t - lastSweep > opts.windowMs) {
        for (const [k, w] of windows) if (t - w.start >= opts.windowMs) windows.delete(k);
        lastSweep = t;
      }
      let w = windows.get(key);
      if (!w || t - w.start >= opts.windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      const retryAfterSec = Math.max(1, Math.ceil((w.start + opts.windowMs - t) / 1000));
      return { allowed: w.count <= opts.max, retryAfterSec };
    },
  };
}

/** Express middleware: 429 with Retry-After when the key exceeds its limit. */
export function rateLimit(limiter: RateLimiter, keyOf: (req: Request, res: Response) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(keyOf(req, res));
    if (r.allowed) return next();
    res.setHeader('Retry-After', String(r.retryAfterSec));
    next(new AppError('RATE_LIMITED', 429, `Too many requests — try again in ${r.retryAfterSec}s`));
  };
}

export interface RateLimitSettings {
  windowMs: number;
  login: number;
  recommendations: number;
  api: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = { windowMs: 60_000, login: 5, recommendations: 30, api: 300 };
