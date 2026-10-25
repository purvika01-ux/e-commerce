import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { createBotSupervisor } from '../../src/bot/supervisor';
import { silentLogger } from '../../src/infra/logger';

const conflict = () => new GrammyError('Conflict', { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 'getUpdates', {});

/** Captures scheduled retries so the test controls time. */
function manualScheduler() {
  const queue: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    queue,
    schedule: (fn: () => void, ms: number) => {
      const item = { fn, ms, cancelled: false };
      queue.push(item);
      return { cancel: () => (item.cancelled = true) };
    },
    runNext() {
      const item = queue.shift();
      if (item && !item.cancelled) item.fn();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('bot supervisor', () => {
  it('reports polling once started', async () => {
    const s = createBotSupervisor({ logger: silentLogger, stop: async () => {}, start: (onStarted) => (onStarted(), new Promise(() => {})) });
    s.run();
    expect(s.state().status).toBe('polling');
  });

  it('a 409 conflict does not throw; it is recorded and retried with growing backoff', async () => {
    const sched = manualScheduler();
    let attempts = 0;
    const s = createBotSupervisor({
      logger: silentLogger,
      stop: async () => {},
      schedule: sched.schedule,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      start: async () => {
        attempts++;
        throw conflict();
      },
    });
    s.run();
    await flush();
    expect(s.state()).toMatchObject({ status: 'failed', lastError: { kind: 'conflict' } });
    expect(sched.queue.map((q) => q.ms)).toEqual([1000]);

    sched.runNext();
    await flush();
    sched.runNext();
    await flush();
    expect(attempts).toBe(3);
    expect(s.state().restarts).toBe(2);
    expect(sched.queue.map((q) => q.ms)).toEqual([3000]); // 1s, 2s, then capped at 3s
  });

  it('recovers to polling after a failure and resets the backoff', async () => {
    const sched = manualScheduler();
    let attempt = 0;
    const s = createBotSupervisor({
      logger: silentLogger,
      stop: async () => {},
      schedule: sched.schedule,
      baseDelayMs: 1000,
      start: (onStarted) => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('network down'));
        onStarted();
        return new Promise(() => {});
      },
    });
    s.run();
    await flush();
    expect(s.state()).toMatchObject({ status: 'failed', lastError: { kind: 'error' } });
    sched.runNext();
    await flush();
    expect(s.state().status).toBe('polling');
    expect(s.state().nextRetryAt).toBeNull();
  });

  it('treats an unexpected stop as a failure, but not a deliberate stop', async () => {
    const sched = manualScheduler();
    let finish!: () => void;
    const s = createBotSupervisor({
      logger: silentLogger,
      stop: async () => finish?.(),
      schedule: sched.schedule,
      start: (onStarted) => {
        onStarted();
        return new Promise<void>((r) => (finish = r));
      },
    });
    s.run();
    finish(); // polling ended on its own
    await flush();
    expect(s.state()).toMatchObject({ status: 'failed', lastError: { kind: 'stopped_unexpectedly' } });

    sched.runNext();
    await flush();
    await s.stop(); // deliberate
    await flush();
    expect(s.state().status).toBe('stopped');
    expect(sched.queue).toHaveLength(0);
  });

  it('a start function that throws synchronously is contained', async () => {
    const sched = manualScheduler();
    const s = createBotSupervisor({
      logger: silentLogger,
      stop: async () => {},
      schedule: sched.schedule,
      start: () => {
        throw new Error('boom');
      },
    });
    expect(() => s.run()).not.toThrow();
    expect(s.state().status).toBe('failed');
  });
});
