import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { computeAnalytics } from '../analytics/aggregate';
import { AnalyticsQuerySchema, resolveFilters } from '../analytics/filters';
import { describeRule, parseRules, RULE_CATALOG, RULE_TYPES, type RuleSetRecord } from '../domain/rules';
import { estimateCostPaise, SEGMENTS, type OfferRecord } from '../domain/types';
import { OfferCreateSchema, OfferUpdateSchema, VERSIONED_FIELDS } from '../domain/offerInput';
import { computeContactStats } from '../decision/ledger';
import { loadActiveRuleSet, type Clock } from '../decision/orchestrator';
import { AppError, badRequest, conflict, notFound } from '../infra/errors';
import { pingMongo } from '../infra/mongo';
import { Customer, CustomerEvent, Decision, Delivery, EngagementEvent, Offer, RuleSet, TelegramLink, toCustomerContext, toOfferRecord } from '../models';
import { filterEligible } from '../rules/eligibility';
import { termsSummary } from '../rules/terms';
import { validateDecision } from '../rules/validator';
import type { Services } from '../services';
import { silentLogger, type Logger } from '../infra/logger';

export interface ApiDeps {
  services: Services;
  clock: Clock;
  status: () => ServiceStatus;
  /** Records admin actions (who changed what). Optional so lightweight test apps can omit it. */
  logger?: Logger;
}

export interface ServiceStatus {
  aiMode: 'live' | 'fallback_only';
  model: string | null;
  telegram: {
    enabled: boolean;
    botUsername: string | null;
    status: 'disabled' | 'starting' | 'polling' | 'failed' | 'stopped';
    lastError?: { kind: string; message: string; at: Date } | null;
    nextRetryAt?: Date | null;
  };
  maintenance?: { lastRunAt: Date | null; lastError: string | null; lastResult: Record<string, unknown> | null };
  /** Deployed commit (from the host's environment), shown so a deploy or rollback can be confirmed. */
  release?: string | null;
}

const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'must be a valid id');
const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
};
const idParam = (req: Request) => parse(objectId, req.params.id);

/** Offer-level rule issues that make an offer unsendable to anyone (shown on the Offers page). */
function offerRuleIssues(o: OfferRecord, ruleSet: RuleSetRecord, now: Date) {
  const probe = validateDecision({
    proposal: { offerId: o.id, headline: 'Preview', body: 'Preview wording' },
    candidateIds: [o.id],
    offer: { ...o, status: 'active' },
    customer: {
      id: 'probe',
      externalRef: 'probe',
      segment: o.eligibility.segments?.[0] ?? 'promising',
      features: {
        recencyDays: null, frequency90d: 0, monetary90dPaise: 0, aovPaise: 0, churnRisk: 1, purchaseProbability7d: 0,
        discountSensitivity: 0, returnRate: 0, cartAbandonRate: 0, daysSinceSignup: 0, lastOrderAt: null, lastActiveAt: null,
        openCart: { cartId: 'probe', valuePaise: 0, categories: o.terms.categories ?? ['fashion'], updatedAt: now },
      },
      rewardPoints: { balance: 1_000_000, expiringPoints: 0, expiresAt: null },
      preferredCategories: [],
      optedOut: false,
    },
    stats: { approvedInWindow: 0, activeGrants: [], grantsByOffer: {} },
    ruleSet,
    now,
    phase: 'decision',
  });
  return probe.violations.filter((v) => !v.rule.startsWith('COPY'));
}

function decisionSummary(d: any) {
  return {
    id: String(d._id),
    customerId: String(d.customerId),
    customerRef: d.customerRef,
    status: d.status,
    path: d.path,
    decidedAt: d.decidedAt,
    offer: d.offerSnapshot ? { code: d.offerSnapshot.code, name: d.offerSnapshot.name, terms: termsSummary(d.offerSnapshot) } : null,
    copy: d.copy?.headline ? d.copy : null,
    grant: d.grant?.code ? d.grant : null,
    outcomeReason: d.outcomeReason,
    errorCode: d.errorCode,
    candidatesCount: (d.candidates ?? []).length,
    lastValidation: (d.validationHistory ?? []).at(-1) ?? null,
    aiAttempts: (d.ai?.attempts ?? []).map((a: any) => ({ n: a.n, outcome: a.outcome, errorCode: a.errorCode, latencyMs: a.latencyMs })),
    dataOrigin: d.dataOrigin,
  };
}

export function apiRouter(deps: ApiDeps): Router {
  const r = Router();
  const { services, clock } = deps;
  const logger = deps.logger ?? silentLogger;
  const actor = (res: Response) => (res.locals.user as string | undefined) ?? 'local-admin';

  r.get('/health', async (_req, res) => {
    const db = await pingMongo();
    const s = deps.status();
    // HTTP 503 only when the database is down (the service cannot work at all). A failed bot keeps
    // 200 so a host health check does not restart-loop on a token conflict; it is reported as degraded.
    const botFailed = s.telegram.enabled && s.telegram.status === 'failed';
    const maintenanceFailing = Boolean(s.maintenance?.lastError);
    res.status(db.status === 'connected' ? 200 : 503).json({
      status: db.status !== 'connected' || botFailed || maintenanceFailing ? 'degraded' : 'ok',
      db,
      ai: { mode: s.aiMode, model: s.model },
      telegram: s.telegram,
      maintenance: s.maintenance ?? null,
      release: s.release ?? null,
      uptimeSec: Math.round(process.uptime()),
      time: clock.now(),
    });
  });

  r.get('/overview', async (req, res) => {
    // Optional time range (days back from now). Without it, totals are all-time, as before.
    const q = parse(z.object({ days: z.enum(['7', '30', '90']).optional() }), req.query);
    const now = clock.now();
    const days = q.days ? Number(q.days) : null;
    const since = days ? new Date(now.getTime() - days * 86_400_000) : null;
    const decisionMatch: Record<string, unknown> = { preview: { $ne: true }, ...(since ? { decidedAt: { $gte: since } } : {}) };
    const createdMatch = since ? { createdAt: { $gte: since } } : {};
    const occurredMatch = since ? { occurredAt: { $gte: since } } : {};
    // Chart window: the selected range, or the last 30 days for all-time.
    const chartDays = days ?? 30;
    const chartSince = new Date(now.getTime() - chartDays * 86_400_000);

    const [customers, segments, offers, decisionsByStatus, decisionsByPath, deliveriesByStatus, linked, engagement, recent, daily] = await Promise.all([
      Customer.countDocuments(),
      Customer.aggregate([{ $group: { _id: '$segment', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Offer.find().lean(),
      Decision.aggregate([{ $match: decisionMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Decision.aggregate([{ $match: { ...decisionMatch, status: { $in: ['approved', 'cancelled'] } } }, { $group: { _id: '$path', count: { $sum: 1 } } }]),
      Delivery.aggregate([{ $match: createdMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      TelegramLink.countDocuments({ status: 'active' }),
      EngagementEvent.aggregate([{ $match: occurredMatch }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
      Decision.find({ preview: { $ne: true } }).sort({ createdAt: -1 }).limit(8).lean(),
      Decision.aggregate([
        { $match: { preview: { $ne: true }, decidedAt: { $gte: chartSince } } },
        {
          $group: {
            _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$decidedAt', timezone: 'Asia/Kolkata' } }, status: '$status' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const toMap = (rows: { _id: string; count: number }[]) => Object.fromEntries(rows.map((x) => [x._id, x.count]));

    // Daily outcome series with every day present (zeros included), in IST.
    const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const series = new Map<string, { date: string; approved: number; noOffer: number; blocked: number }>();
    for (let i = chartDays - 1; i >= 0; i--) {
      const key = dayKey(new Date(now.getTime() - i * 86_400_000));
      series.set(key, { date: key, approved: 0, noOffer: 0, blocked: 0 });
    }
    for (const row of daily as { _id: { day: string; status: string }; count: number }[]) {
      const point = series.get(row._id.day);
      if (!point) continue;
      if (row._id.status === 'approved') point.approved += row.count;
      else if (row._id.status === 'no_offer') point.noOffer += row.count;
      else if (['rejected', 'cancelled', 'error'].includes(row._id.status)) point.blocked += row.count;
    }

    const offerRecords = offers.map(toOfferRecord);
    const live = offerRecords.filter((o) => o.status === 'active' && o.validTo > now);
    const budget = {
      totalPaise: live.reduce((s, o) => s + o.budget.totalPaise, 0),
      committedPaise: live.reduce((s, o) => s + o.budget.reservedPaise + o.budget.redeemedPaise, 0),
      liveOffers: live.length,
    };

    res.json({
      range: days ? `${days}d` : 'all',
      customers,
      segments: segments.map((s) => ({ segment: s._id, count: s.count })),
      offers: offerRecords.map((rec) => ({
        code: rec.code,
        name: rec.name,
        status: rec.validTo <= now ? 'expired' : rec.status,
        budget: rec.budget,
        usage: rec.usage,
      })),
      budget: { ...budget, availablePaise: budget.totalPaise - budget.committedPaise },
      decisions: toMap(decisionsByStatus),
      paths: toMap(decisionsByPath),
      deliveries: toMap(deliveriesByStatus),
      engagement: toMap(engagement),
      telegramLinked: linked,
      daily: { days: chartDays, timezone: 'Asia/Kolkata', points: [...series.values()] },
      recentDecisions: recent.map(decisionSummary),
      dataNotice: 'All customers are synthetic. Engagement comes from classmates using synthetic profiles; it is descriptive, not causal.',
    });
  });

  // Campaign results: a cohort of decisions in an IST date window, aggregated in MongoDB.
  r.get('/analytics', async (req, res) => {
    const q = parse(AnalyticsQuerySchema, req.query);
    const now = clock.now();
    res.json(await computeAnalytics(resolveFilters(q, now), now));
  });

  r.get('/customers', async (req, res) => {
    const q = parse(
      z.object({
        segment: z.enum(SEGMENTS).optional(),
        q: z.string().max(40).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
        sort: z.enum(['ref', 'name', 'churn', 'buyProbability', 'spend', 'recency']).default('ref'),
        order: z.enum(['asc', 'desc']).default('asc'),
      }),
      req.query,
    );
    const sortField: Record<string, string> = {
      ref: 'externalRef',
      name: 'displayName',
      churn: 'features.churnRisk',
      buyProbability: 'features.purchaseProbability7d',
      spend: 'features.monetary90dPaise',
      recency: 'features.recencyDays',
    };
    const direction = q.order === 'asc' ? 1 : -1;
    const filter: Record<string, unknown> = {};
    if (q.segment) filter.segment = q.segment;
    if (q.q) filter.$or = [{ externalRef: { $regex: `^${q.q.replace(/[^A-Za-z0-9-]/g, '')}`, $options: 'i' } }, { displayName: { $regex: q.q.replace(/[^A-Za-z ]/g, ''), $options: 'i' } }];
    const [items, total] = await Promise.all([
      Customer.find(filter, { features: 1, externalRef: 1, displayName: 1, segment: 1, persona: 1, rewardPoints: 1, telegramLinked: 1, optedOut: 1 })
        .sort({ [sortField[q.sort]]: direction, externalRef: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      Customer.countDocuments(filter),
    ]);
    res.json({ items: items.map((c) => ({ ...c, id: String(c._id), _id: undefined })), page: q.page, pageSize: q.pageSize, total });
  });

  r.get('/customers/:id', async (req, res) => {
    const id = idParam(req);
    const doc = await Customer.findById(id).lean();
    if (!doc) throw notFound('Customer');
    const now = clock.now();
    const ruleSet = await loadActiveRuleSet();
    const customer = toCustomerContext(doc);
    const [events, decisions, offers, stats, link] = await Promise.all([
      CustomerEvent.find({ customerId: id, type: { $ne: 'product_view' } }).sort({ occurredAt: -1 }).limit(25).lean(),
      Decision.find({ customerId: id, preview: { $ne: true } }).sort({ createdAt: -1 }).limit(10).lean(),
      Offer.find({ status: { $ne: 'archived' } }).lean(),
      computeContactStats(id, ruleSet, now),
      TelegramLink.findOne({ customerId: id }).lean(),
    ]);
    const { eligible, excluded } = filterEligible(offers.map(toOfferRecord), { customer, stats, ruleSet, now });
    res.json({
      customer: { ...doc, id: String(doc._id), _id: undefined, decisionLease: undefined },
      telegram: link ? { status: link.status, linkedAt: link.linkedAt } : null,
      stats,
      eligibility: {
        eligible: eligible.map((o) => ({ id: o.id, code: o.code, name: o.name, terms: termsSummary(o) })),
        excluded,
      },
      recentEvents: events.map((e) => ({ type: e.type, occurredAt: e.occurredAt, payload: e.payload })),
      decisions: decisions.map(decisionSummary),
    });
  });

  r.get('/offers', async (_req, res) => {
    const now = clock.now();
    const ruleSet = await loadActiveRuleSet();
    const offers = (await Offer.find().sort({ priority: -1 }).lean()).map(toOfferRecord);
    res.json({ items: offers.map((o) => offerView(o, ruleSet, now)) });
  });

  const offerView = (o: OfferRecord, ruleSet: RuleSetRecord, now: Date) => ({
    ...o,
    termsSummary: termsSummary(o),
    isExpired: o.validTo <= now,
    remainingBudgetPaise: o.budget.totalPaise - o.budget.reservedPaise - o.budget.redeemedPaise,
    ruleIssues: offerRuleIssues(o, ruleSet, now),
  });

  // Create: always starts as a draft, so nothing can be offered until an admin activates it (activation re-checks the rules).
  r.post('/offers', async (req, res) => {
    const input = parse(OfferCreateSchema, req.body);
    const now = clock.now();
    try {
      const created = await Offer.create({
        code: input.code,
        name: input.name,
        description: input.description,
        status: 'draft',
        version: 1,
        type: input.type,
        terms: input.terms,
        eligibility: input.eligibility,
        validFrom: input.validFrom,
        validTo: input.validTo,
        grantValidityHours: input.grantValidityHours,
        priority: input.priority,
        estimatedCostPaise: estimateCostPaise(input.type, input.terms),
        stackable: input.stackable,
        budget: { totalPaise: input.budgetTotalPaise, reservedPaise: 0, redeemedPaise: 0 },
        usage: { maxGrants: input.maxGrants, grantsIssued: 0, maxGrantsPerCustomer: input.maxGrantsPerCustomer, redemptions: 0 },
      });
      const offer = toOfferRecord(created.toObject());
      logger.info('offer created', { event: 'offer_created', user: actor(res), offer: offer.code, type: offer.type });
      res.status(201).json({ offer: offerView(offer, await loadActiveRuleSet(), now) });
    } catch (err: any) {
      if (err?.code === 11000) throw conflict(`An offer with code ${input.code} already exists`, 'DUPLICATE_CODE');
      throw err;
    }
  });

  /**
   * Edit: optimistic concurrency on version. Changing terms, eligibility, validity, budget or limits
   * bumps the version — issued grants keep the snapshot they were promised, and approved-but-unsent
   * decisions are cancelled by the pre-send check. An active offer may never be edited into breaking the rules.
   */
  r.patch('/offers/:id', async (req, res) => {
    const id = idParam(req);
    const body = parse(OfferUpdateSchema, req.body);
    const { expectedVersion, ...changes } = body;
    if (!Object.keys(changes).length) throw badRequest('Nothing to change');
    const doc = await Offer.findById(id).lean();
    if (!doc) throw notFound('Offer');
    const current = toOfferRecord(doc);
    if (current.status === 'archived') throw conflict('Archived offers cannot be edited');
    if (current.version !== expectedVersion) throw conflict('This offer was changed by someone else — reload and try again', 'STALE_VERSION');

    const merged = {
      code: current.code,
      name: changes.name ?? current.name,
      description: changes.description ?? current.description,
      type: changes.type ?? current.type,
      terms: changes.terms ?? current.terms,
      eligibility: changes.eligibility ?? current.eligibility,
      validFrom: changes.validFrom ?? current.validFrom,
      validTo: changes.validTo ?? current.validTo,
      grantValidityHours: changes.grantValidityHours ?? current.grantValidityHours,
      priority: changes.priority ?? current.priority,
      stackable: changes.stackable ?? current.stackable,
      budgetTotalPaise: changes.budgetTotalPaise ?? current.budget.totalPaise,
      maxGrants: changes.maxGrants ?? current.usage.maxGrants,
      maxGrantsPerCustomer: changes.maxGrantsPerCustomer ?? current.usage.maxGrantsPerCustomer,
    };
    const checked = parse(OfferCreateSchema, merged);
    const now = clock.now();
    const committed = current.budget.reservedPaise + current.budget.redeemedPaise;
    if (checked.budgetTotalPaise < committed) {
      throw conflict(`Budget cannot go below the ₹${Math.ceil(committed / 100)} already committed to issued offers`, 'BUDGET_BELOW_COMMITTED');
    }
    if (checked.maxGrants < current.usage.grantsIssued) {
      throw conflict(`Usage limit cannot go below the ${current.usage.grantsIssued} offers already issued`, 'USAGE_BELOW_ISSUED');
    }

    const nextRecord: OfferRecord = {
      ...current,
      name: checked.name,
      description: checked.description,
      type: checked.type,
      terms: checked.terms,
      eligibility: checked.eligibility,
      validFrom: checked.validFrom,
      validTo: checked.validTo,
      grantValidityHours: checked.grantValidityHours,
      priority: checked.priority,
      stackable: checked.stackable,
      estimatedCostPaise: estimateCostPaise(checked.type, checked.terms),
      budget: { ...current.budget, totalPaise: checked.budgetTotalPaise },
      usage: { ...current.usage, maxGrants: checked.maxGrants, maxGrantsPerCustomer: checked.maxGrantsPerCustomer },
    };
    const ruleSet = await loadActiveRuleSet();
    if (current.status === 'active') {
      if (nextRecord.validTo <= now) throw new AppError('BUSINESS_RULE_VIOLATION', 422, 'An active offer cannot be given an end date in the past — pause it instead');
      const issues = offerRuleIssues(nextRecord, ruleSet, now);
      if (issues.length) throw new AppError('BUSINESS_RULE_VIOLATION', 422, 'This change would make an active offer break the business rules', issues);
    }

    const before = { ...merged, type: current.type, terms: current.terms, eligibility: current.eligibility, validFrom: current.validFrom, validTo: current.validTo, grantValidityHours: current.grantValidityHours, stackable: current.stackable, budgetTotalPaise: current.budget.totalPaise, maxGrants: current.usage.maxGrants, maxGrantsPerCustomer: current.usage.maxGrantsPerCustomer };
    const changedVersioned = VERSIONED_FIELDS.filter((f) => JSON.stringify((before as any)[f]) !== JSON.stringify((checked as any)[f]));
    const set: Record<string, unknown> = {
      name: checked.name,
      description: checked.description,
      priority: checked.priority,
      type: checked.type,
      terms: checked.terms,
      eligibility: checked.eligibility,
      validFrom: checked.validFrom,
      validTo: checked.validTo,
      grantValidityHours: checked.grantValidityHours,
      stackable: checked.stackable,
      estimatedCostPaise: nextRecord.estimatedCostPaise,
      'budget.totalPaise': checked.budgetTotalPaise,
      'usage.maxGrants': checked.maxGrants,
      'usage.maxGrantsPerCustomer': checked.maxGrantsPerCustomer,
    };
    const update: Record<string, unknown> = { $set: set };
    if (changedVersioned.length) update.$inc = { version: 1 };
    // Atomic: the version and status must still match, and counters may not have overtaken the new limits.
    const updated = await Offer.findOneAndUpdate(
      {
        _id: id,
        version: expectedVersion,
        status: current.status,
        $expr: {
          $and: [
            { $lte: [{ $add: ['$budget.reservedPaise', '$budget.redeemedPaise'] }, checked.budgetTotalPaise] },
            { $lte: ['$usage.grantsIssued', checked.maxGrants] },
          ],
        },
      },
      update,
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw conflict('This offer changed while you were editing — reload and try again', 'STALE_VERSION');
    const offer = toOfferRecord(updated);
    logger.info('offer updated', { event: 'offer_updated', user: actor(res), offer: offer.code, fromVersion: expectedVersion, toVersion: offer.version, versionedChanges: changedVersioned });
    res.json({ offer: offerView(offer, ruleSet, now) });
  });

  r.post('/offers/:id/status', async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ action: z.enum(['activate', 'pause', 'archive']) }).strict(), req.body);
    const doc = await Offer.findById(id).lean();
    if (!doc) throw notFound('Offer');
    const o = toOfferRecord(doc);
    const now = clock.now();
    const allowed: Record<string, string[]> = { activate: ['draft', 'paused'], pause: ['active'], archive: ['draft', 'active', 'paused'] };
    if (!allowed[body.action].includes(o.status)) throw conflict(`Cannot ${body.action} an offer that is ${o.status}`);
    if (body.action === 'activate') {
      if (o.validTo <= now) throw new AppError('BUSINESS_RULE_VIOLATION', 422, 'Offer has expired and cannot be activated');
      const issues = offerRuleIssues(o, await loadActiveRuleSet(), now);
      if (issues.length) throw new AppError('BUSINESS_RULE_VIOLATION', 422, 'Offer breaks the current business rules', issues);
    }
    const next = { activate: 'active', pause: 'paused', archive: 'archived' }[body.action];
    const updated = await Offer.findOneAndUpdate({ _id: id, status: o.status }, { status: next }, { returnDocument: 'after' }).lean();
    if (!updated) throw conflict('Offer was changed by someone else — reload and try again');
    logger.info('offer status changed', { event: 'offer_status_changed', user: actor(res), offer: o.code, from: o.status, to: next });
    res.json({ offer: toOfferRecord(updated) });
  });

  r.get('/rules', async (_req, res) => {
    const rs = await loadActiveRuleSet();
    const history = await RuleSet.find({}, { version: 1, changeNote: 1, createdAt: 1, active: 1 }).sort({ version: -1 }).limit(10).lean();
    res.json({
      version: rs.version,
      rules: rs.rules.map((rule) => ({ ...rule, description: describeRule(rule), help: RULE_CATALOG[rule.type].help })),
      catalog: RULE_TYPES.map((t) => ({ type: t, help: RULE_CATALOG[t].help })),
      history,
    });
  });

  r.put('/rules', async (req, res) => {
    const body = parse(
      z.object({ expectedVersion: z.number().int().min(1), changeNote: z.string().min(1).max(200), rules: z.array(z.unknown()) }).strict(),
      req.body,
    );
    const parsed = parseRules(body.rules);
    if (!parsed.ok) throw badRequest('Invalid rules', parsed.errors);
    const latest = await RuleSet.findOne().sort({ version: -1 }).lean();
    const nextVersion = (latest?.version ?? 0) + 1;
    // Deactivate the expected version first (optimistic concurrency), then activate the new one.
    const flipped = await RuleSet.updateOne({ version: body.expectedVersion, active: true }, { active: false });
    if (!flipped.modifiedCount) throw conflict('Rules were changed by someone else — reload and try again');
    try {
      await RuleSet.create({ version: nextVersion, active: true, rules: parsed.rules, changeNote: body.changeNote });
    } catch (err) {
      await RuleSet.updateOne({ version: body.expectedVersion }, { active: true });
      throw err;
    }
    logger.info('business rules updated', {
      event: 'rules_updated',
      user: actor(res),
      fromVersion: body.expectedVersion,
      toVersion: nextVersion,
      changeNote: body.changeNote,
    });
    res.status(201).json({ version: nextVersion });
  });

  r.post('/recommendations', async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9:_-]{8,128}$/.test(key)) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'An Idempotency-Key header (8–128 chars) is required');
    const body = parse(
      z.object({ customerId: objectId, channel: z.enum(['telegram', 'none']).default('none'), dryRun: z.boolean().default(false) }).strict(),
      req.body,
    );
    if (body.dryRun && body.channel !== 'none') throw badRequest('A preview cannot be delivered; use channel "none"');
    if (body.channel === 'telegram') {
      const link = await TelegramLink.findOne({ customerId: body.customerId, status: 'active' }).lean();
      if (!link) throw new AppError('NOT_DELIVERABLE', 422, 'This customer is not linked to a Telegram chat');
      if (!services.telegramEnabled) throw new AppError('NOT_DELIVERABLE', 422, 'Telegram is not configured on the server');
    }
    const result = await services.recommendAndDeliver({
      customerId: body.customerId,
      idempotencyKey: `api:${key}`,
      type: body.dryRun ? 'preview' : 'manual',
      source: 'admin_api',
      channel: body.channel,
      dryRun: body.dryRun,
      dataOrigin: 'admin',
    });
    const full = result.decision ? await Decision.findById(result.decision._id).lean() : null;
    if (!result.replayed && !body.dryRun) {
      logger.info('admin recommendation decided', {
        event: 'recommendation_decided',
        user: actor(res),
        customer: full?.customerRef,
        status: full?.status,
        path: full?.path,
        offer: (full?.offerSnapshot as { code?: string } | null)?.code ?? null,
        delivery: result.delivery?.status ?? null,
      });
    }
    res.status(result.replayed ? 200 : 201).json({
      decision: full ? { ...decisionSummary(full), detail: full } : null,
      delivery: result.delivery,
      replayed: result.replayed,
    });
  });

  r.get('/decisions', async (req, res) => {
    const q = parse(
      z.object({
        // `limit` is kept for older callers; `page` + `pageSize` paginate.
        limit: z.coerce.number().int().min(1).max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
        status: z.enum(['no_offer', 'rejected', 'approved', 'dry_run', 'cancelled', 'error', 'pending']).optional(),
        path: z.enum(['ai', 'ai_retry', 'fallback', 'none']).optional(),
        customerId: objectId.optional(),
        q: z.string().max(40).optional(),
        days: z.enum(['7', '30', '90']).optional(),
        sort: z.enum(['newest', 'oldest']).default('newest'),
      }),
      req.query,
    );
    const pageSize = q.pageSize ?? q.limit ?? 50;
    const filter: Record<string, unknown> = { preview: { $ne: true } };
    if (q.status) filter.status = q.status;
    if (q.path) filter.path = q.path;
    if (q.customerId) filter.customerId = q.customerId;
    if (q.q) filter.customerRef = { $regex: `^${q.q.replace(/[^A-Za-z0-9-]/g, '')}`, $options: 'i' };
    if (q.days) filter.decidedAt = { $gte: new Date(clock.now().getTime() - Number(q.days) * 86_400_000) };
    const order = q.sort === 'oldest' ? 1 : -1;
    const [items, total] = await Promise.all([
      Decision.find(filter).sort({ decidedAt: order, _id: order }).skip((q.page - 1) * pageSize).limit(pageSize).lean(),
      Decision.countDocuments(filter),
    ]);
    res.json({ items: items.map(decisionSummary), page: q.page, pageSize, total });
  });

  r.get('/decisions/:id', async (req, res) => {
    const id = idParam(req);
    const d = await Decision.findById(id).lean();
    if (!d) throw notFound('Decision');
    const [deliveries, engagement] = await Promise.all([Delivery.find({ decisionId: id }).lean(), EngagementEvent.find({ decisionId: id }).lean()]);
    res.json({ summary: decisionSummary(d), detail: d, deliveries, engagement });
  });

  r.get('/deliveries', async (req, res) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json({ items: await Delivery.find().sort({ createdAt: -1 }).limit(q.limit).lean() });
  });

  return r;
}
