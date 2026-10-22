import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/data/catalog';
import { TelegramSendError } from '../../src/delivery/telegramSender';
import { Decision, Delivery, Offer, RuleSet, TelegramLink, Trigger } from '../../src/models';
import {
  aiFail,
  aiOk,
  connectTestDb,
  dropTestDb,
  FakeTelegram,
  insertCustomer,
  key,
  linkTelegram,
  makeServices,
  proposal,
  resetData,
  ScriptedAi,
  seedFixtures,
} from '../helpers/harness';

let fx: Awaited<ReturnType<typeof seedFixtures>>;

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  fx = await seedFixtures();
});

const req = (customerId: string, over: Record<string, unknown> = {}) => ({
  customerId,
  idempotencyKey: key(),
  type: 'manual' as const,
  source: 'admin_api' as const,
  channel: 'none' as const,
  dataOrigin: 'test' as const,
  ...over,
});

async function offerCounters(code: string) {
  const o: any = await Offer.findOne({ code }).lean();
  return { reserved: o.budget.reservedPaise, issued: o.usage.grantsIssued, total: o.budget.totalPaise };
}

describe('1. eligible offer approved', () => {
  it('AI picks an eligible candidate → validated, reserved, approved and delivered once', async () => {
    const telegram = new FakeTelegram();
    const ai = new ScriptedAi([aiOk(proposal(fx.offerId('WINBACK15')))]);
    const { services } = makeServices({ ai, telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_001);

    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.decision!.status).toBe('approved');
    expect(r.decision!.path).toBe('ai');
    expect(r.decision!.offerSnapshot.code).toBe('WINBACK15');
    expect(r.delivery!.status).toBe('sent');
    expect(telegram.sent).toHaveLength(1);
    // Terms in the message come from the snapshot, not from the AI wording.
    expect(telegram.sent[0].html).toContain('15% off (up to ₹300)');
    expect(telegram.sent[0].html).toContain('We have missed you around here');
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 30_000, issued: 1 });

    // Audit trail is complete.
    const d: any = await Decision.findById(r.decision!._id).lean();
    expect(d!.candidates.map((c: any) => c.code)).toEqual(['WINBACK15']);
    expect(d!.excluded.length).toBeGreaterThan(0);
    expect(d!.validationHistory.map((v: any) => [v.source, v.ok])).toEqual([['ai', true], ['presend', true]]);
    expect(d!.ai.attempts).toHaveLength(1);
    expect(d!.grant.code).toBe('OFR-TEST-01');
  });

  it('gives the AI only permitted context and only eligible candidates', async () => {
    const ai = new ScriptedAi([aiOk(proposal(fx.offerId('WINBACK15')))]);
    const { services } = makeServices({ ai });
    await services.recommendAndDeliver(req(fx.customers.atRisk));
    const sent = JSON.stringify(ai.requests[0]);
    expect(ai.requests[0].candidates.map((c) => c.code)).toEqual(['WINBACK15']);
    // Name, city, age band and the ground-truth persona are never sent to the model.
    for (const forbidden of ['Test T-ATRISK', 'Ludhiana', '25-34', 'persona', 'displayName']) expect(sent).not.toContain(forbidden);
    expect(ai.requests[0].context.segment).toBe('at_risk');
  });

  it('the AI may decide no offer is needed', async () => {
    const ai = new ScriptedAi([aiOk(proposal(null))]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(r.decision!.status).toBe('no_offer');
    expect(r.decision!.outcomeReason).toBe('AI_CHOSE_NO_OFFER');
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 0, issued: 0 });
  });
});

describe('2. ineligible or expired offer rejected', () => {
  it('AI proposing the expired FESTIVE20 is rejected twice, then the validated fallback is used', async () => {
    const expired = fx.offerId('FESTIVE20');
    const ai = new ScriptedAi([aiOk(proposal(expired)), aiOk(proposal(expired))]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(r.decision!.status).toBe('approved');
    expect(r.decision!.path).toBe('fallback');
    expect(r.decision!.offerSnapshot.code).toBe('WINBACK15');
    const aiChecks = r.decision!.validationHistory.filter((v: any) => v.source === 'ai');
    expect(aiChecks.every((v: any) => v.violations[0].rule === 'NOT_A_CANDIDATE')).toBe(true);
    // The retry told the model what was wrong.
    expect(ai.requests[1].previousViolations?.[0].rule).toBe('NOT_A_CANDIDATE');
    expect(await offerCounters('FESTIVE20')).toMatchObject({ reserved: 0, issued: 0 });
  });

  it('a likely buyer gets no discount at all (no AI call when nothing discount-like is eligible)', async () => {
    const ai = new ScriptedAi([aiOk(proposal(fx.offerId('LOYALPTS200'), { headline: 'A thank-you from all of us', body: 'You are one of our favourite shoppers.' }))]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.likelyBuyer));
    expect(r.decision!.status).toBe('approved');
    expect(r.decision!.offerSnapshot.type).toBe('bonus_points');
    const excluded = r.decision!.excluded.find((e: any) => e.code === 'WINBACK15');
    expect(excluded.reasons.map((x: any) => x.rule)).toContain('LIKELY_BUYER_SUPPRESSION');
  });

  it('an offer paused after approval is not delivered (pre-send recheck)', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_002);
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.decision!.status).toBe('approved');
    await Offer.updateOne({ code: 'WINBACK15' }, { status: 'paused' });

    const delivery = await services.delivery.deliver(String(r.decision!._id));
    expect(delivery.status).toBe('cancelled_precheck');
    expect(telegram.sent).toHaveLength(0);
    const d = await Decision.findById(r.decision!._id).lean();
    expect(d!.status).toBe('cancelled');
    expect(d!.validationHistory.at(-1).violations.map((v: any) => v.rule)).toContain('OFFER_INACTIVE');
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 0, issued: 0 });
  });
});

describe('3. fabricated offer id rejected', () => {
  it('never approves or sends a made-up offer id', async () => {
    const telegram = new FakeTelegram();
    const ai = new ScriptedAi([aiOk(proposal('64b7f0c2a1b2c3d4e5f60718')), aiOk(proposal('FREE-MONEY-999'))]);
    const { services } = makeServices({ ai, telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_003);
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.decision!.path).toBe('fallback');
    expect(r.decision!.offerSnapshot.offerId).toBe(fx.offerId('WINBACK15'));
    expect(r.decision!.ai.attempts.map((a: any) => a.outcome)).toEqual(['validation_failed', 'validation_failed']);
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].html).not.toContain('FREE-MONEY');
  });
});

describe('4. discount and budget limits', () => {
  it('a stricter discount cap removes the offer before the AI sees it', async () => {
    await RuleSet.updateOne(
      { active: true },
      { rules: DEFAULT_RULES.map((r) => (r.type === 'MAX_DISCOUNT_PERCENT' ? { ...r, params: { maxPercent: 10 } } : r)) },
    );
    const ai = new ScriptedAi([]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(r.decision!.status).toBe('no_offer');
    expect(ai.requests).toHaveLength(0);
    const ex = r.decision!.excluded.find((e: any) => e.code === 'WINBACK15');
    expect(ex.reasons.map((x: any) => x.rule)).toContain('MAX_DISCOUNT_PERCENT');
  });

  it('budget exhaustion stops further grants', async () => {
    await Offer.updateOne({ code: 'WINBACK15' }, { 'budget.totalPaise': 30_000 }); // room for exactly one grant
    const { services } = makeServices();
    const first = await services.recommendAndDeliver(req(fx.customers.atRisk));
    const second = await services.recommendAndDeliver(req(fx.customers.atRisk2));
    expect(first.decision!.status).toBe('approved');
    expect(second.decision!.status).toBe('no_offer');
    expect(second.decision!.excluded.find((e: any) => e.code === 'WINBACK15').reasons.map((x: any) => x.rule)).toContain('BUDGET_EXHAUSTED');
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 30_000, issued: 1, total: 30_000 });
  });

  it('concurrent requests never overspend the budget', async () => {
    await Offer.updateOne({ code: 'WINBACK15' }, { 'budget.totalPaise': 90_000 }); // room for three
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => insertCustomer(`T-RACE-${i}`, 'at_risk', 'at_risk', { recencyDays: 50, churnRisk: 0.8, purchaseProbability7d: 0.1 })),
    );
    const { services } = makeServices();
    const results = await Promise.all(ids.map((id) => services.recommendAndDeliver(req(id))));
    const approved = results.filter((r) => r.decision!.status === 'approved' && r.decision!.offerSnapshot.code === 'WINBACK15');
    expect(approved).toHaveLength(3);
    const c = await offerCounters('WINBACK15');
    expect(c.reserved).toBeLessThanOrEqual(c.total);
    expect(c).toMatchObject({ reserved: 90_000, issued: 3 });
  });

  it('the frequency cap holds per customer', async () => {
    const { services, clock } = makeServices();
    const first = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(first.decision!.status).toBe('approved');
    clock.advance(60_000);
    const second = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(second.decision!.status).toBe('no_offer'); // holds an unused offer (NO_STACKING)
  });
});

describe('5. malformed AI response', () => {
  it('malformed twice → deterministic fallback (validated)', async () => {
    const ai = new ScriptedAi([aiFail('malformed', 'parse_error'), aiOk({ decision: 'offer', offerId: 42, extra: true })]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(r.decision!.status).toBe('approved');
    expect(r.decision!.path).toBe('fallback');
    expect(r.decision!.ai.attempts.map((a: any) => a.outcome)).toEqual(['malformed', 'schema_invalid']);
    expect(r.decision!.validationHistory.at(-1)).toMatchObject({ source: 'fallback', ok: true });
  });

  it('malformed once, valid on retry → ai_retry', async () => {
    const ai = new ScriptedAi([aiOk({ nonsense: true }), aiOk(proposal(fx.offerId('WINBACK15')))]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(r.decision!.path).toBe('ai_retry');
    expect(r.decision!.status).toBe('approved');
  });

  it('wording that states a different discount is rejected, never sent', async () => {
    const telegram = new FakeTelegram();
    const bad = proposal(fx.offerId('WINBACK15'), { headline: 'Get 40% off now!' });
    const ai = new ScriptedAi([aiOk(bad), aiOk(bad)]);
    const { services } = makeServices({ ai, telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_005);
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.decision!.path).toBe('fallback');
    expect(telegram.sent[0].html).not.toContain('40%');
  });
});

describe('6. Claude API failure', () => {
  for (const outcome of ['timeout', 'api_error', 'rate_limited', 'refusal'] as const) {
    it(`${outcome} → one call, safe validated fallback`, async () => {
      const ai = new ScriptedAi([aiFail(outcome)]);
      const { services } = makeServices({ ai });
      const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
      expect(ai.requests).toHaveLength(1);
      expect(r.decision!.status).toBe('approved');
      expect(r.decision!.path).toBe('fallback');
      expect(r.decision!.outcomeReason).toBe('AI_UNAVAILABLE_OR_REJECTED');
    });
  }

  it('an AI client that throws is treated as an API error', async () => {
    const ai = new ScriptedAi([() => { throw new Error('boom'); }]);
    const { services } = makeServices({ ai });
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk));
    expect(r.decision!.path).toBe('fallback');
  });
});

describe('7. validator failure prevents Telegram delivery', () => {
  it('rules tightened between approval and send → cancelled, nothing sent, reservation released', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_007);
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk, { channel: 'telegram' }));
    await RuleSet.updateOne(
      { active: true },
      { rules: DEFAULT_RULES.map((x) => (x.type === 'MAX_DISCOUNT_PERCENT' ? { ...x, params: { maxPercent: 10 } } : x)) },
    );
    const delivery = await services.delivery.deliver(String(r.decision!._id));
    expect(delivery.status).toBe('cancelled_precheck');
    expect(delivery.failureReason).toContain('MAX_DISCOUNT_PERCENT');
    expect(telegram.sent).toHaveLength(0);
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 0, issued: 0 });
  });

  it('the delivery layer refuses anything that is not approved', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await RuleSet.updateOne({ active: true }, { rules: DEFAULT_RULES.map((x) => (x.type === 'SEGMENT_EXCLUSION' ? { ...x, params: { segments: ['at_risk'] } } : x)) });
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk));
    expect(r.decision!.status).toBe('no_offer');
    await expect(services.delivery.deliver(String(r.decision!._id))).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    expect(telegram.sent).toHaveLength(0);
  });

  it('when no candidate passes validation the decision is rejected and nothing is sent', async () => {
    const telegram = new FakeTelegram();
    // Ban a phrase used by the fallback template so every fallback fails COPY_POLICY.
    await RuleSet.updateOne(
      { active: true },
      { rules: DEFAULT_RULES.map((x) => (x.type === 'COPY_POLICY' ? { ...x, params: { ...(x.params as any), bannedPhrases: ['missed you', 'next order'] } } : x)) },
    );
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_008);
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.decision!.status).toBe('rejected');
    expect(r.delivery).toBeNull();
    expect(telegram.sent).toHaveLength(0);
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 0, issued: 0 });
  });

  it('a blocked user is a permanent failure: link marked blocked, reservation released', async () => {
    const telegram = new FakeTelegram();
    telegram.failNext(new TelegramSendError('blocked', 'blocked'));
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_009);
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.delivery!.status).toBe('failed_permanent');
    expect((await TelegramLink.findOne({ chatId: 9_000_000_009 }).lean())!.status).toBe('blocked');
    expect(await offerCounters('WINBACK15')).toMatchObject({ reserved: 0, issued: 0 });
  });

  it('transient Telegram errors are retried and recorded', async () => {
    const telegram = new FakeTelegram();
    telegram.failNext(new TelegramSendError('network', 'down'), new TelegramSendError('rate_limited', 'slow', 1));
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_010);
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    expect(r.delivery!.status).toBe('sent');
    expect(r.delivery!.attempts.map((a: any) => a.outcome)).toEqual(['failed', 'failed', 'sent']);
    expect(telegram.sent).toHaveLength(1);
  });
});

describe('8. duplicate requests do not send duplicate offers', () => {
  it('the same idempotency key replays the original decision without sending again', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_011);
    const k = key('dup');
    const a = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram', idempotencyKey: k }));
    const b = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram', idempotencyKey: k }));
    expect(b.replayed).toBe(true);
    expect(String(b.decision!._id)).toBe(String(a.decision!._id));
    expect(telegram.sent).toHaveLength(1);
    expect(await Delivery.countDocuments()).toBe(1);
    expect(await offerCounters('WINBACK15')).toMatchObject({ issued: 1 });
  });

  it('concurrent duplicates (same key) produce one decision and one message', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_012);
    const k = key('race');
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram', idempotencyKey: k }))),
    );
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(await Trigger.countDocuments()).toBe(1);
    expect(await Decision.countDocuments()).toBe(1);
    expect(telegram.sent).toHaveLength(1);
  });

  it('different keys for the same customer at once still yield at most one offer', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_013);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }))),
    );
    const approved = settled.filter((s) => s.status === 'fulfilled' && s.value.decision?.status === 'approved');
    expect(approved).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
    const busy = settled.filter((s) => s.status === 'rejected');
    for (const b of busy) expect((b as PromiseRejectedResult).reason.code).toBe('CUSTOMER_BUSY');
  });

  it('calling deliver twice for one decision sends once', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_014);
    const r = await services.orchestrator.recommend(req(fx.customers.atRisk, { channel: 'telegram' }));
    const id = String(r.decision!._id);
    await Promise.all([services.delivery.deliver(id), services.delivery.deliver(id), services.delivery.deliver(id)]);
    expect(telegram.sent).toHaveLength(1);
  });

  it('a claim replayed from Telegram is recorded once and other users cannot claim it', async () => {
    const telegram = new FakeTelegram();
    const { services } = makeServices({ telegram });
    await linkTelegram(fx.customers.atRisk, 9_000_000_015);
    await linkTelegram(fx.customers.cart, 9_000_000_016);
    const r = await services.recommendAndDeliver(req(fx.customers.atRisk, { channel: 'telegram' }));
    const code = r.decision!.grant.code;
    expect(await services.engagement.respond(9_000_000_016, code, 'claimed')).toBe('not_owner');
    expect(await services.engagement.respond(9_000_000_015, code, 'claimed')).toBe('ok');
    expect(await services.engagement.respond(9_000_000_015, code, 'claimed')).toBe('duplicate');
  });
});
