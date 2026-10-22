import mongoose from 'mongoose';
import { createAnthropicAiClient } from './ai/anthropicClient';
import { buildApp } from './app';
import { createBot } from './bot/bot';
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

  let bot: Bot | null = null;
  let botUsername: string | null = null;
  const telegramBot = config.telegramEnabled ? new Bot(config.TELEGRAM_BOT_TOKEN!) : null;
  const services = createServices({
    clock: { now: () => new Date() },
    ai,
    telegram: telegramBot ? createTelegramSender(telegramBot.api) : null,
    logger,
    // Two AI attempts plus database work must finish inside the per-customer lease.
    leaseMs: 2 * config.AI_TIMEOUT_MS + 30_000,
  });

  if (config.telegramEnabled) {
    bot = createBot(config.TELEGRAM_BOT_TOKEN!, services, logger);
    try {
      const me = await bot.api.getMe();
      botUsername = me.username;
      await bot.api.setMyCommands([
        { command: 'offer', description: 'Get a personalised offer' },
        { command: 'myoffers', description: 'Offers you hold' },
        { command: 'profile', description: 'Your synthetic shopper profile' },
        { command: 'stop', description: 'Stop receiving offers' },
        { command: 'help', description: 'Help' },
      ]);
      void bot.start({ drop_pending_updates: false, onStart: () => logger.info('telegram bot polling', { botUsername }) });
    } catch {
      logger.error('Telegram bot could not start — check TELEGRAM_BOT_TOKEN. Continuing without the bot.');
      bot = null;
    }
  } else {
    logger.warn('Telegram is not configured (set TELEGRAM_BOT_TOKEN in server/.env). The bot is disabled; nothing will be sent.');
  }

  const app = buildApp({
    services,
    clock: { now: () => new Date() },
    logger,
    serveClient: true,
    status: () => ({
      aiMode: ai ? 'live' : 'fallback_only',
      model: ai?.model ?? null,
      telegram: { enabled: Boolean(bot), botUsername },
    }),
  });
  const server = app.listen(config.PORT, config.HOST, () => logger.info(`Offerly AI listening on http://${config.HOST}:${config.PORT}`));

  const shutdown = async () => {
    logger.info('shutting down');
    await bot?.stop().catch(() => undefined);
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
