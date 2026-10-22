import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import type { AiClient, AiRequest, AiResult } from '../../src/ai/types';
import { DEFAULT_OFFERS, DEFAULT_RULES, offerDocFromSeed } from '../../src/data/catalog';
import { TelegramSendError, type TelegramSender } from '../../src/delivery/telegramSender';
import type { CustomerFeatures, Persona, Segment } from '../../src/domain/types';
import { silentLogger } from '../../src/infra/logger';
import { Customer, ensureIndexes, Offer, RuleSet, TelegramLink } from '../../src/models';
import { createServices } from '../../src/services';

export const NOW = new Date('2026-10-22T10:00:00.000Z');
const DAY = 86_400_000;

/** Each test file gets its own throwaway database on the local mongod. */
export async function connectTestDb(): Promise<void> {
  const base = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
  await mongoose.connect(`${base}/offerly_test_${randomBytes(4).toString('hex')}`, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes();
}

export async function dropTestDb(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export async function resetData(): Promise<void> {
  for (const name of Object.keys(mongoose.connection.collections)) await mongoose.connection.collections[name].deleteMany({});
}

export class FakeClock {
  constructor(private t = NOW.getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

type Scripted = AiResult | ((req: AiRequest) => AiResult);

/** Mock Claude: returns scripted results in order and records every request it was given. */
export class ScriptedAi implements AiClient {
  readonly model = 'mock-claude';
  readonly requests: AiRequest[] = [];
  constructor(private script: Scripted[] = []) {}
  push(...s: Scripted[]) {
    this.script.push(...s);
  }
  async propose(req: AiRequest): Promise<AiResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedAi: no scripted response left');
    return typeof next === 'function' ? next(req) : next;
  }
}

export const aiOk = (output: unknown): AiResult => ({ outcome: 'ok', output, model: 'mock-claude', latencyMs: 5 });
export const aiFail = (outcome: AiResult['outcome'], errorCode: string = outcome): AiResult => ({ outcome, errorCode, model: 'mock-claude', latencyMs: 5 });
export const proposal = (offerId: string | null, over: Record<string, unknown> = {}) => ({
  decision: offerId ? 'offer' : 'no_offer',
  offerId,
  headline: offerId ? 'We have missed you around here' : null,
  body: offerId ? 'Come back and treat yourself to something you love.' : null,
  rationale: 'Customer is drifting away; a modest win-back offer fits.',
  confidence: 0.8,
  ...over,
});

/** Mock Telegram: records sends; can be scripted to fail. */
export class FakeTelegram implements TelegramSender {
  readonly sent: { chatId: number; html: string; grantCode: string }[] = [];
  private failures: TelegramSendError[] = [];
  failNext(...errs: TelegramSendError[]) {
    this.failures.push(...errs);
  }
  async sendOffer(chatId: number, html: string, grantCode: string) {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push({ chatId, html, grantCode });
    return { messageId: String(this.sent.length) };
  }
}

export function makeServices(opts: { ai?: AiClient | null; telegram?: TelegramSender | null; clock?: FakeClock } = {}) {
  const clock = opts.clock ?? new FakeClock();
  let n = 0;
  const services = createServices({
    clock,
    ai: opts.ai === undefined ? null : opts.ai,
    telegram: opts.telegram === undefined ? new FakeTelegram() : opts.telegram,
    logger: silentLogger,
    newGrantCode: () => `OFR-TEST-${String(++n).padStart(2, '0')}`,
    sleep: async () => undefined,
  });
  return { services, clock };
}

const baseFeatures = (over: Partial<CustomerFeatures>): CustomerFeatures => ({
  recencyDays: 20,
  frequency90d: 1,
  monetary90dPaise: 150_000,
  aovPaise: 150_000,
  churnRisk: 0.3,
  purchaseProbability7d: 0.2,
  discountSensitivity: 0.3,
  returnRate: 0.05,
  cartAbandonRate: 0.5,
  daysSinceSignup: 300,
  lastOrderAt: new Date(NOW.getTime() - 20 * DAY),
  lastActiveAt: new Date(NOW.getTime() - 2 * DAY),
  openCart: null,
  ...over,
});

export async function insertCustomer(ref: string, persona: Persona, segment: Segment, features: Partial<CustomerFeatures>) {
  const c = await Customer.create({
    externalRef: ref,
    displayName: `Test ${ref}`,
    persona,
    city: 'Ludhiana',
    ageBand: '25-34',
    signupAt: new Date(NOW.getTime() - 300 * DAY),
    preferredCategories: ['fashion'],
    rewardPoints: { balance: 120, expiringPoints: 0, expiresAt: null },
    features: baseFeatures(features),
    segment,
    featuresComputedAt: NOW,
    dataOrigin: 'test',
  });
  return String(c._id);
}

/** Canonical fixtures: default rules + catalog offers + one customer per key situation. */
export async function seedFixtures() {
  await RuleSet.create({ version: 1, active: true, rules: DEFAULT_RULES, changeNote: 'test' });
  const offers = await Offer.insertMany(DEFAULT_OFFERS.map((o) => offerDocFromSeed(o, NOW)));
  const offerId = (code: string) => String(offers.find((o) => o.code === code)!._id);
  const atRisk = await insertCustomer('T-ATRISK', 'at_risk', 'at_risk', { recencyDays: 50, churnRisk: 0.8, purchaseProbability7d: 0.1, lastOrderAt: new Date(NOW.getTime() - 50 * DAY) });
  const atRisk2 = await insertCustomer('T-ATRISK2', 'at_risk', 'at_risk', { recencyDays: 60, churnRisk: 0.75, purchaseProbability7d: 0.1, lastOrderAt: new Date(NOW.getTime() - 60 * DAY) });
  const likelyBuyer = await insertCustomer('T-LIKELY', 'loyal_high_value', 'loyal', { recencyDays: 1, frequency90d: 8, purchaseProbability7d: 0.9, churnRisk: 0.05 });
  const cart = await insertCustomer('T-CART', 'cart_abandoner', 'promising', {
    openCart: { cartId: 'c-1', valuePaise: 150_000, categories: ['fashion'], updatedAt: new Date(NOW.getTime() - 3_600_000) },
  });
  return { offerId, customers: { atRisk, atRisk2, likelyBuyer, cart } };
}

export async function linkTelegram(customerId: string, chatId: number) {
  await TelegramLink.create({ chatId, customerId, personaChoice: 'at_risk', firstName: null });
  await Customer.updateOne({ _id: customerId }, { telegramLinked: true });
}

let keySeq = 0;
export const key = (label = 'k') => `test-${label}-${++keySeq}-${randomBytes(3).toString('hex')}`;
