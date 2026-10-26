import mongoose from 'mongoose';
import type { Logger } from './logger';

export async function connectMongo(uri: string, logger: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  logger.info('mongo connected', { db: mongoose.connection.name });
  return mongoose;
}

/**
 * Retries the initial connection with exponential backoff, so a short database outage or a slow
 * network at boot does not crash-loop the service. After the last attempt it throws, and the
 * process exits so the host restarts it. Once connected, the driver reconnects on its own.
 */
export async function connectWithRetry(
  connect: () => Promise<unknown>,
  opts: { logger: Logger; attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const attempts = opts.attempts ?? 8;
  const base = opts.baseDelayMs ?? 2000;
  const max = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let n = 1; ; n++) {
    try {
      await connect();
      return;
    } catch (err) {
      // Only the error class is logged: driver messages can include host names from the URI.
      const kind = err instanceof Error ? err.name : 'Error';
      if (n >= attempts) {
        opts.logger.error('mongo connection failed; giving up', { attempt: n, kind });
        throw err;
      }
      const delay = Math.min(max, base * 2 ** (n - 1));
      opts.logger.warn('mongo connection failed; retrying', { attempt: n, of: attempts, kind, retryInMs: delay });
      await sleep(delay);
    }
  }
}

/** Health-check ping, bounded so /api/health always answers quickly (hosts time out health checks at ~5 s). */
export async function pingMongo(timeoutMs = 2000): Promise<{ status: 'connected' | 'disconnected'; latencyMs?: number }> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return { status: 'disconnected' };
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
      }),
    ]);
    return { status: 'connected', latencyMs: Date.now() - started };
  } catch {
    return { status: 'disconnected' };
  } finally {
    clearTimeout(timer);
  }
}
