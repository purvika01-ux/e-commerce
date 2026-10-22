import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

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
});

export type Config = z.infer<typeof EnvSchema> & {
  aiEnabled: boolean;
  telegramEnabled: boolean;
};

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
  return {
    ...c,
    aiEnabled: c.AI_MODE !== 'off' && Boolean(c.ANTHROPIC_API_KEY),
    telegramEnabled: c.TELEGRAM_MODE !== 'off' && Boolean(c.TELEGRAM_BOT_TOKEN),
  };
}

export function loadDotenv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(here, '../.env'), quiet: true });
}
