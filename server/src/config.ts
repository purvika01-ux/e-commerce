import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { PASSWORD_HASH_PATTERN } from './security/passwords';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  AI_MODE: z.enum(['auto', 'live', 'off']).default('auto'),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().min(10).optional()),
  // The app always talks to the public API unless explicitly configured, so it never inherits a
  // base URL from the shell it happens to be started in.
  OFFERLY_ANTHROPIC_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  CLAUDE_MODEL: z.string().min(1).default('claude-opus-5-5'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  TELEGRAM_MODE: z.enum(['auto', 'polling', 'off']).default('auto'),
  TELEGRAM_BOT_TOKEN: z.preprocess(blankToUndefined, z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'does not look like a BotFather token').optional()),
  // Admin login for the dashboard and API. Generate the values with: npm run setup-admin
  ADMIN_USERNAME: z.preprocess(blankToUndefined, z.string().regex(/^[A-Za-z0-9_.-]{3,64}$/, 'use 3–64 letters, digits, dot, dash or underscore').default('admin')),
  ADMIN_PASSWORD_HASH: z.preprocess(blankToUndefined, z.string().regex(PASSWORD_HASH_PATTERN, 'must be generated with npm run setup-admin').optional()),
  SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(32, 'must be at least 32 characters (npm run setup-admin generates one)').optional()),
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(72).default(8),
  // Set when running behind a hosting proxy so rate limits see the real client IP (true or a hop count).
  TRUST_PROXY: z.preprocess(blankToUndefined, z.union([z.enum(['true', 'false']).transform((v) => v === 'true'), z.coerce.number().int().min(0).max(5)]).default(false)),
});

export type Config = z.infer<typeof EnvSchema> & {
  aiEnabled: boolean;
  telegramEnabled: boolean;
  authEnabled: boolean;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class ConfigError extends Error {}

/** Validates the environment. Error messages name the variable but never echo its value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration (see server/.env.example):\n${problems}`);
  }
  const c = parsed.data;
  if (c.AI_MODE === 'live' && !c.ANTHROPIC_API_KEY) {
    throw new ConfigError('Invalid configuration:\n  - ANTHROPIC_API_KEY: required when AI_MODE=live');
  }
  if (c.TELEGRAM_MODE === 'polling' && !c.TELEGRAM_BOT_TOKEN) {
    throw new ConfigError('Invalid configuration:\n  - TELEGRAM_BOT_TOKEN: required when TELEGRAM_MODE=polling');
  }
  const authEnabled = Boolean(c.ADMIN_PASSWORD_HASH && c.SESSION_SECRET);
  if (!authEnabled && (c.ADMIN_PASSWORD_HASH || c.SESSION_SECRET)) {
    const missing = c.ADMIN_PASSWORD_HASH ? 'SESSION_SECRET' : 'ADMIN_PASSWORD_HASH';
    throw new ConfigError(`Invalid configuration:\n  - ${missing}: required together with the other admin login setting`);
  }
  // The dashboard may only run without a login when it is reachable from this machine alone.
  const exposed = c.NODE_ENV === 'production' || !LOOPBACK_HOSTS.has(c.HOST);
  if (exposed && !authEnabled) {
    throw new ConfigError(
      'Invalid configuration:\n  - ADMIN_PASSWORD_HASH and SESSION_SECRET: required in production or when HOST is not localhost (run npm run setup-admin)',
    );
  }
  return {
    ...c,
    aiEnabled: c.AI_MODE !== 'off' && Boolean(c.ANTHROPIC_API_KEY),
    telegramEnabled: c.TELEGRAM_MODE !== 'off' && Boolean(c.TELEGRAM_BOT_TOKEN),
    authEnabled,
  };
}

export function loadDotenv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(here, '../.env'), quiet: true });
}
