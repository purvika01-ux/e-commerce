import { GrammyError } from 'grammy';
import type { Logger } from '../infra/logger';

export type BotStatus = 'disabled' | 'starting' | 'polling' | 'failed' | 'stopped';
export type BotFailureKind = 'conflict' | 'unauthorized' | 'stopped_unexpectedly' | 'error';

export interface BotSupervisorState {
  status: BotStatus;
  lastError: { kind: BotFailureKind; message: string; at: Date } | null;
  restarts: number;
  nextRetryAt: Date | null;
}

export interface BotSupervisorOptions {
  /** Starts long polling. Resolves when polling stops, rejects on a fatal error. */
  start: (onStarted: () => void) => Promise<void>;
  stop: () => Promise<void>;
  logger: Logger;
  baseDelayMs?: number;
  maxDelayMs?: number;
  conflictMaxDelayMs?: number;
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  now?: () => Date;
}

function classify(err: unknown): { kind: BotFailureKind; message: string } {
  if (err instanceof GrammyError && err.error_code === 409) {
    return { kind: 'conflict', message: 'Another process is polling this bot token (Telegram 409). Stop the other instance.' };
  }
  if (err instanceof GrammyError && err.error_code === 401) {
    return { kind: 'unauthorized', message: 'Telegram rejected the bot token (401). Check or replace TELEGRAM_BOT_TOKEN.' };
  }
  return { kind: 'error', message: err instanceof Error ? err.message : 'Unknown polling error' };
}

/**
 * Keeps Telegram polling alive without letting a polling failure crash the API process.
 * Transient network errors are already retried inside grammY; this handles the fatal ones
 * (409 conflict, 401 unauthorized, unexpected stop) by recording them and retrying with backoff.
 */
export function createBotSupervisor(opts: BotSupervisorOptions) {
  const base = opts.baseDelayMs ?? 30_000;
  const max = opts.maxDelayMs ?? 10 * 60_000;
  const conflictMax = opts.conflictMaxDelayMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { cancel: () => clearTimeout(t) };
    });
  const state: BotSupervisorState = { status: 'starting', lastError: null, restarts: 0, nextRetryAt: null };
  let consecutiveFailures = 0;
  let stopped = false;
  let pending: { cancel: () => void } | null = null;

  function fail(kind: BotFailureKind, message: string) {
    state.status = 'failed';
    state.lastError = { kind, message, at: now() };
    consecutiveFailures++;
    // A 409 is expected while an old and a new deploy overlap (~60 s on Render), so retry it sooner.
    const cap = kind === 'conflict' ? Math.min(max, conflictMax) : max;
    const delay = Math.min(cap, base * 2 ** (consecutiveFailures - 1));
    state.nextRetryAt = new Date(now().getTime() + delay);
    opts.logger.error('telegram polling failed; will retry', { kind, message, retryInMs: delay });
    pending = schedule(() => {
      pending = null;
      if (stopped) return;
      state.restarts++;
      run();
    }, delay);
  }

  function run() {
    if (stopped) return;
    state.status = 'starting';
    state.nextRetryAt = null;
    let promise: Promise<void>;
    try {
      promise = opts.start(() => {
        state.status = 'polling';
        consecutiveFailures = 0;
      });
    } catch (err) {
      const c = classify(err);
      fail(c.kind, c.message);
      return;
    }
    promise.then(
      () => {
        if (!stopped) fail('stopped_unexpectedly', 'Polling stopped without an error');
      },
      (err) => {
        if (stopped) return;
        const c = classify(err);
        fail(c.kind, c.message);
      },
    );
  }

  return {
    run,
    async stop() {
      stopped = true;
      pending?.cancel();
      state.status = 'stopped';
      await opts.stop().catch(() => undefined);
    },
    state: (): BotSupervisorState => ({ ...state }),
  };
}

export type BotSupervisor = ReturnType<typeof createBotSupervisor>;
