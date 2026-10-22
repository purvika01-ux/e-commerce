import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { AppError } from './infra/errors';
import type { Logger } from './infra/logger';
import { apiRouter, type ApiDeps } from './routes/api';

export function buildApp(deps: ApiDeps & { logger: Logger; serveClient?: boolean }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    const incoming = req.get('X-Request-Id');
    const id = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId;
    if (err instanceof AppError) {
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
