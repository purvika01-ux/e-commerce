import http from 'node:http';
import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { createBotSupervisor } from '../../src/bot/supervisor';
import { loadConfig } from '../../src/config';
import type { Logger } from '../../src/infra/logger';
import { connectWithRetry } from '../../src/infra/mongo';
import { closeHttpServer } from '../../src/infra/shutdown';

function capturingLogger() {
  const lines: string[] = [];
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ level, msg, ...fields }));
  const logger: Logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  return { logger, lines };
}

describe('database startup retry', () => {
  it('retries with exponential backoff and succeeds once the database is reachable', async () => {
    const { logger } = capturingLogger();
    const waits: number[] = [];
    let calls = 0;
    await connectWithRetry(
      async () => {
        if (++calls < 4) throw new Error('querySrv ECONNREFUSED');
      },
      { logger, sleep: async (ms) => void waits.push(ms), baseDelayMs: 2000, maxDelayMs: 5000 },
    );
    expect(calls).toBe(4);
    expect(waits).toEqual([2000, 4000, 5000]); // capped
  });

  it('gives up after the last attempt (so the host restarts the process) without logging the connection string', async () => {
    const { logger, lines } = capturingLogger();
    const uri = 'mongodb://fake-user:SuperSecretPw@db.invalid:27017/offerly'; // deliberately fake

    await expect(
      connectWithRetry(
        async () => {
          throw new Error(`failed to connect to ${uri}`);
        },
        { logger, attempts: 3, sleep: async () => undefined },
      ),
    ).rejects.toThrow();
    expect(lines).toHaveLength(3); // two retry warnings + one final error
    expect(lines.join('\n')).not.toContain('SuperSecretPw');
    expect(lines.join('\n')).not.toContain('db.invalid');
  });
});

describe('graceful HTTP shutdown', () => {
  async function serverWithSlowRoute(delayMs: number) {
    const server = http.createServer((_req, res) => setTimeout(() => res.end('done'), delayMs));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { server, port };
  }

  it('lets an in-flight request finish before closing', async () => {
    const { server, port } = await serverWithSlowRoute(150);
    const response = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 30)); // request is now in flight
    const drained = await closeHttpServer(server, 2000);
    expect(drained).toBe(true);
    expect(await response).toBe('done');
  });

  it('forces remaining connections closed after the deadline', async () => {
    const { server, port } = await serverWithSlowRoute(5000);
    const response = fetch(`http://127.0.0.1:${port}/`).then(
      () => 'completed',
      () => 'aborted',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(await closeHttpServer(server, 100)).toBe(false);
    expect(await response).toBe('aborted');
  });
});

describe('Telegram hand-over during deploys', () => {
  it('retries a 409 conflict at most every 60 s, while other failures keep longer backoff', async () => {
    const delays: number[] = [];
    const conflict = new GrammyError('Conflict', { ok: false, error_code: 409, description: 'Conflict' }, 'getUpdates', {});
    const queue: (() => void)[] = [];
    const s = createBotSupervisor({
      logger: capturingLogger().logger,
      stop: async () => {},
      baseDelayMs: 30_000,
      schedule: (fn, ms) => {
        delays.push(ms);
        queue.push(fn);
        return { cancel: () => {} };
      },
      start: async () => {
        throw conflict;
      },
    });
    s.run();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      queue.shift()?.();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(delays.slice(0, 4)).toEqual([30_000, 60_000, 60_000, 60_000]);
  });
});

describe('DNS_SERVERS configuration', () => {
  const base = { MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/offerly' };
  it('is optional and parses a comma-separated list', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).DNS_SERVERS).toEqual([]);
    expect(loadConfig({ ...base, DNS_SERVERS: '8.8.8.8, 1.1.1.1' } as NodeJS.ProcessEnv).DNS_SERVERS).toEqual(['8.8.8.8', '1.1.1.1']);
  });
  it('rejects values that are not IP addresses, naming the variable', () => {
    expect(() => loadConfig({ ...base, DNS_SERVERS: 'dns.google' } as NodeJS.ProcessEnv)).toThrow(/DNS_SERVERS/);
  });
});
