import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { loadConfig, loadDotenv } from '../config';
import { createLogger } from '../infra/logger';
import { connectMongo } from '../infra/mongo';
import {
  Customer,
  CustomerEvent,
  Decision,
  Delivery,
  EngagementEvent,
  ensureIndexes,
  Offer,
  RuleSet,
  TelegramLink,
  Trigger,
} from '../models';
import { DEFAULT_OFFERS, DEFAULT_RULES, offerDocFromSeed } from './catalog';
import { generateDataset } from './generator';

export interface SeedOptions {
  seed: number;
  count: number;
  now: Date;
}

/** Replaces all data with a fresh synthetic dataset, default offers and rule set v1. */
export async function seedDatabase(opts: SeedOptions): Promise<{ customers: number; events: number; offers: number }> {
  const all: mongoose.Model<any>[] = [Customer, CustomerEvent, Offer, RuleSet, Trigger, Decision, Delivery, EngagementEvent, TelegramLink];
  for (const m of all) await m.deleteMany({});
  await ensureIndexes();

  const dataset = generateDataset(opts);
  const customers = await Customer.insertMany(
    dataset.map(({ events: _events, ...c }) => ({ ...c, featuresComputedAt: opts.now, dataOrigin: 'seed' })),
  );
  const events = dataset.flatMap((c, i) =>
    c.events.map((e) => ({ customerId: customers[i]._id, type: e.type, occurredAt: e.occurredAt, payload: e.payload, dataOrigin: 'seed' })),
  );
  for (let i = 0; i < events.length; i += 5000) await CustomerEvent.insertMany(events.slice(i, i + 5000), { ordered: false });
  await Offer.insertMany(DEFAULT_OFFERS.map((o) => offerDocFromSeed(o, opts.now)));
  await RuleSet.create({ version: 1, active: true, rules: DEFAULT_RULES, changeNote: 'Default rules (seed)' });
  return { customers: customers.length, events: events.length, offers: DEFAULT_OFFERS.length };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

async function main() {
  loadDotenv();
  const config = loadConfig();
  const logger = createLogger({ secrets: [config.MONGODB_URI] });
  await connectMongo(config.MONGODB_URI, logger);
  const linked = await TelegramLink.countDocuments({ status: 'active' });
  if (linked > 0 && !process.argv.includes('--force')) {
    logger.error(`Refusing to re-seed: ${linked} Telegram chat(s) are linked to customers. Re-run with --force to wipe them.`);
    process.exit(1);
  }
  const result = await seedDatabase({ seed: arg('seed', 42), count: arg('customers', 120), now: new Date() });
  logger.info('seed complete', result);
  await mongoose.disconnect();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
