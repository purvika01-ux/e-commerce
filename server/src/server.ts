import mongoose from 'mongoose';
import { createAnthropicAiClient } from './ai/anthropicClient';
import { buildApp } from './app';
import { createBot } from './bot/bot';
import { createBotSupervisor, type BotSupervisor } from './bot/supervisor';
import { createMaintenance } from './maintenance/jobs';
import { ConfigError, loadConfig, loadDotenv } from './config';
import { createTelegramSender } from './delivery/telegramSender';
import { createLogger } from './infra/logger';
import { connectMongo } from './infra/mongo';
import { ensureIndexes } from './models';
import { createServices } from './services';
import { Bot } from 'grammy';

async function main() {
  loadDotenv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const logger = createLogger({ secrets: [config.ANTHROPIC_API_KEY ?? '', config.TELEGRAM_BOT_TOKEN ?? '', config.MONGODB_URI] });

  try {
    await connectMongo(config.MONGODB_URI, logger);
    await ensureIndexes();
  } catch {
    logger.error('Could not connect to MongoDB. Check MONGODB_URI in server/.env and that mongod is running.');
    process.exit(1);
  }

  const ai = config.aiEnabled
    ? createAnthropicAiClient({ apiKey: config.ANTHROPIC_API_KEY!, model: config.CLAUDE_MODEL, timeoutMs: config.AI_TIMEOUT_MS, baseURL: config.OFFERLY_ANTHROPIC_BASE_URL })
    : null;
  if (!ai) logger.warn('Claude is not configured (set ANTHROPIC_API_KEY in server/.env). Decisions will use the deterministic, validated fallback.');

  const clock = { now: () => new Date() };
  let botUsername: string | null = null;
  const telegramApiClient = config.telegramEnabled ? new Bot(config.TELEGRAM_BOT_TOKEN!) : null;
  const services = createServices({
    clock,
    ai,
    telegram: telegramApiClient ? createTelegramSender(telegramApiClient.api) : null,
    logger,
    // Two AI attempts plus database work must finish inside the per-customer lease.
    leaseMs: 2 * config.AI_TIMEOUT_MS + 30_000,
  });

  // Polling runs under a supervisor: a fatal polling error (409 conflict, 401) is logged, shown in
  // /api/health and retried with backoff, instead of crashing the API process.
  let supervisor: BotSupervisor | null = null;
  if (config.telegramEnabled) {
    const bot = createBot(config.TELEGRAM_BOT_TOKEN!, services, logger);
    supervisor = createBotSupervisor({
      logger,
      stop: () => bot.stop(),
      start: (onStarted) =>
        bot.start({
          drop_pending_updates: false,
          onStart: (me) => {
            botUsername = me.username;
            onStarted();
            logger.info('telegram bot polling', { botUsername });
            void bot.api
              .setMyCommands([
                { command: 'offer', description: 'Get a personalised offer' },
                { command: 'myoffers', description: 'Offers you hold' },
                { command: 'profile', description: 'Your synthetic shopper profile' },
                { command: 'stop', description: 'Stop receiving offers' },
                { command: 'help', description: 'Help' },
              ])
              .catch(() => logger.warn('could not update the bot command menu'));
          },
        }),
    });
    supervisor.run();
  } else {
    logger.warn(
      config.TELEGRAM_MODE === 'off'
        ? 'Telegram is disabled (TELEGRAM_MODE=off). Nothing will be sent.'
        : 'Telegram is not configured (set TELEGRAM_BOT_TOKEN in server/.env). The bot is disabled; nothing will be sent.',
    );
  }

  // Expires lapsed grants, cleans up interrupted work and repairs counter drift every minute.
  const maintenance = createMaintenance({ clock, logger });
  maintenance.start();

  if (!config.authEnabled) {
    logger.warn('Admin login is OFF (allowed only on localhost). Run npm run setup-admin and add the values to server/.env to enable it.');
  }
  const app = buildApp({
    services,
    clock,
    logger,
    serveClient: true,
    auth: config.authEnabled
      ? {
          username: config.ADMIN_USERNAME,
          passwordHash: config.ADMIN_PASSWORD_HASH!,
          sessionSecret: config.SESSION_SECRET!,
          secureCookie: config.NODE_ENV === 'production',
          sessionTtlMs: config.SESSION_TTL_HOURS * 3_600_000,
        }
      : null,
    trustProxy: config.TRUST_PROXY,
    hsts: config.NODE_ENV === 'production',
    status: () => {
      const bot = supervisor?.state();
      return {
        aiMode: ai ? 'live' : 'fallback_only',
        model: ai?.model ?? null,
        telegram: {
          enabled: config.telegramEnabled,
          botUsername,
          status: bot?.status ?? 'disabled',
          lastError: bot?.lastError ? { kind: bot.lastError.kind, message: bot.lastError.message, at: bot.lastError.at } : null,
          nextRetryAt: bot?.nextRetryAt ?? null,
        },
        maintenance: maintenance.state(),
      };
    },
  });
  const server = app.listen(config.PORT, config.HOST, () => logger.info(`Offerly AI listening on http://${config.HOST}:${config.PORT}`));

  // Log stray async failures instead of letting Node's default terminate the whole service.
  process.on('unhandledRejection', (reason) => logger.error('unhandled promise rejection', { error: reason }));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception — exiting so the process manager can restart cleanly', { error: err });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');
    maintenance.stop();
    await supervisor?.stop();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
