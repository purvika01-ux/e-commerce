type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SECRET_KEYS = /token|key|secret|password|authorization|cookie|uri/i;

/** Replaces secret-looking values and any registered secret strings before anything is written. */
export function redact(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
    return out;
  }
  if (value instanceof Error) return { name: value.name, message: redact(value.message, secrets, depth + 1) };
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? '[REDACTED]' : redact(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(opts: { secrets?: string[]; silent?: boolean } = {}): Logger {
  const secrets = (opts.secrets ?? []).filter(Boolean) as string[];
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (opts.silent) return;
    const line = JSON.stringify(redact({ level, time: new Date().toISOString(), msg, ...fields }, secrets));
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = createLogger({ silent: true });
