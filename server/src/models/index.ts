import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import {
  CATEGORIES,
  OFFER_STATUSES,
  OFFER_TYPES,
  PERSONAS,
  SEGMENTS,
  type CustomerContext,
  type OfferRecord,
} from '../domain/types';

const DATA_ORIGINS = ['seed', 'simulated', 'classmate', 'admin', 'test'] as const;

// ---------- customers ----------
const customerSchema = new Schema(
  {
    externalRef: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    persona: { type: String, enum: PERSONAS, required: true },
    city: { type: String, required: true },
    ageBand: { type: String, required: true },
    signupAt: { type: Date, required: true },
    preferredCategories: [{ type: String, enum: CATEGORIES }],
    rewardPoints: {
      balance: { type: Number, default: 0, min: 0 },
      expiringPoints: { type: Number, default: 0, min: 0 },
      expiresAt: { type: Date, default: null },
    },
    features: { type: Schema.Types.Mixed, required: true },
    segment: { type: String, enum: SEGMENTS, required: true, index: true },
    featuresComputedAt: { type: Date, required: true },
    optedOut: { type: Boolean, default: false },
    telegramLinked: { type: Boolean, default: false },
    decisionLease: { holder: { type: String, default: null }, expiresAt: { type: Date, default: null } },
    dataOrigin: { type: String, enum: DATA_ORIGINS, default: 'seed' },
  },
  { timestamps: true },
);
customerSchema.index({ persona: 1, telegramLinked: 1 });
export const Customer = mongoose.model('Customer', customerSchema);
export type CustomerDoc = HydratedDocument<InferSchemaType<typeof customerSchema>>;

// ---------- customerEvents (behaviour and purchase history; append-only) ----------
const customerEventSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  type: {
    type: String,
    required: true,
    enum: ['session_start', 'product_view', 'cart_add', 'checkout_start', 'order_placed', 'order_returned', 'points_earned'],
  },
  occurredAt: { type: Date, required: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  dataOrigin: { type: String, enum: DATA_ORIGINS, default: 'seed' },
});
customerEventSchema.index({ customerId: 1, occurredAt: -1 });
customerEventSchema.index({ type: 1, occurredAt: -1 });
export const CustomerEvent = mongoose.model('CustomerEvent', customerEventSchema);

// ---------- offers (definitions, commercial terms, atomic counters) ----------
const offerSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, match: /^[A-Z0-9_]{3,24}$/ },
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 500 },
    status: { type: String, enum: OFFER_STATUSES, default: 'draft' },
    version: { type: Number, default: 1, min: 1 },
    type: { type: String, enum: OFFER_TYPES, required: true },
    terms: { type: Schema.Types.Mixed, required: true },
    eligibility: { type: Schema.Types.Mixed, default: {} },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    grantValidityHours: { type: Number, required: true, min: 1, max: 720 },
    priority: { type: Number, default: 50, min: 0, max: 100 },
    estimatedCostPaise: { type: Number, required: true, min: 0 },
    stackable: { type: Boolean, default: false },
    budget: {
      totalPaise: { type: Number, required: true, min: 1 },
      reservedPaise: { type: Number, default: 0, min: 0 },
      redeemedPaise: { type: Number, default: 0, min: 0 },
    },
    usage: {
      maxGrants: { type: Number, required: true, min: 1 },
      grantsIssued: { type: Number, default: 0, min: 0 },
      maxGrantsPerCustomer: { type: Number, default: 1, min: 1 },
      redemptions: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true, minimize: false },
);
offerSchema.index({ status: 1, validFrom: 1, validTo: 1 });
export const Offer = mongoose.model('Offer', offerSchema);

// ---------- ruleSets (versioned; exactly one active) ----------
const ruleSetSchema = new Schema({
  version: { type: Number, required: true, unique: true },
  active: { type: Boolean, required: true },
  rules: { type: Schema.Types.Mixed, required: true },
  changeNote: { type: String, default: '' },
  createdAt: { type: Date, default: () => new Date() },
});
ruleSetSchema.index({ active: 1 }, { unique: true, partialFilterExpression: { active: true } });
export const RuleSet = mongoose.model('RuleSet', ruleSetSchema);

// ---------- triggers (recommendation requests; deduplicated) ----------
const triggerSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true },
    requestHash: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: { type: String, enum: ['manual', 'bot_request', 'preview'], required: true },
    source: { type: String, enum: ['admin_api', 'bot'], required: true },
    channel: { type: String, enum: ['telegram', 'none'], required: true },
    status: { type: String, enum: ['received', 'processing', 'completed', 'failed', 'skipped'], default: 'received' },
    decisionId: { type: Schema.Types.ObjectId, ref: 'Decision', default: null },
    error: { code: String, message: String },
    dataOrigin: { type: String, enum: DATA_ORIGINS, default: 'admin' },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
triggerSchema.index({ customerId: 1, createdAt: -1 });
export const Trigger = mongoose.model('Trigger', triggerSchema);

// ---------- decisions (decision + validation + audit in one document) ----------
const decisionSchema = new Schema(
  {
    triggerId: { type: Schema.Types.ObjectId, ref: 'Trigger', required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerRef: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'no_offer', 'rejected', 'approved', 'dry_run', 'cancelled', 'error'],
      default: 'pending',
    },
    path: { type: String, enum: ['ai', 'ai_retry', 'fallback', 'none'], default: 'none' },
    ruleSetVersion: { type: Number, required: true },
    decidedAt: { type: Date, required: true }, // from the injected clock (frequency caps use this)
    preview: { type: Boolean, default: false }, // dashboard preview: never reserved, granted or sent
    contextSnapshot: { type: Schema.Types.Mixed, required: true },
    candidates: { type: Schema.Types.Mixed, default: [] },
    excluded: { type: Schema.Types.Mixed, default: [] },
    ai: { type: Schema.Types.Mixed, default: { attempts: [] } },
    proposal: { type: Schema.Types.Mixed, default: null },
    validationHistory: { type: Schema.Types.Mixed, default: [] },
    offerSnapshot: { type: Schema.Types.Mixed, default: null },
    copy: { headline: String, body: String },
    renderedMessage: { type: String, default: null },
    reservation: { type: Schema.Types.Mixed, default: null },
    grant: {
      code: { type: String },
      status: { type: String, enum: ['issued', 'claimed', 'declined', 'redeemed', 'expired', 'void'] },
      issuedAt: Date,
      expiresAt: Date,
    },
    outcomeReason: { type: String, default: null },
    errorCode: { type: String, default: null },
    correlationId: { type: String, required: true },
    dataOrigin: { type: String, enum: DATA_ORIGINS, default: 'admin' },
  },
  { timestamps: true, minimize: false },
);
decisionSchema.index({ customerId: 1, decidedAt: -1 });
decisionSchema.index({ status: 1, createdAt: -1 });
decisionSchema.index({ 'grant.code': 1 }, { unique: true, partialFilterExpression: { 'grant.code': { $type: 'string' } } });
export const Decision = mongoose.model('Decision', decisionSchema);

// ---------- telegramLinks (chat ↔ synthetic customer; minimal personal data) ----------
const telegramLinkSchema = new Schema(
  {
    chatId: { type: Number, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    firstName: { type: String, default: null, maxlength: 64 },
    personaChoice: { type: String, enum: PERSONAS, required: true },
    status: { type: String, enum: ['active', 'blocked', 'unlinked'], default: 'active' },
    linkedAt: { type: Date, default: () => new Date() },
    lastInteractionAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
export const TelegramLink = mongoose.model('TelegramLink', telegramLinkSchema);

// ---------- deliveries ----------
const deliverySchema = new Schema(
  {
    decisionId: { type: Schema.Types.ObjectId, ref: 'Decision', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerRef: { type: String, required: true },
    channel: { type: String, enum: ['telegram'], required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['sending', 'sent', 'failed_retryable', 'failed_permanent', 'cancelled_precheck'],
      default: 'sending',
    },
    attempts: { type: Schema.Types.Mixed, default: [] },
    providerMessageId: { type: String, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);
deliverySchema.index({ decisionId: 1 });
deliverySchema.index({ createdAt: -1 });
export const Delivery = mongoose.model('Delivery', deliverySchema);

// ---------- engagementEvents ----------
const engagementSchema = new Schema({
  decisionId: { type: Schema.Types.ObjectId, ref: 'Decision', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  grantCode: { type: String, required: true },
  type: { type: String, enum: ['delivered', 'claimed', 'declined', 'expired'], required: true },
  idempotencyKey: { type: String, required: true, unique: true },
  occurredAt: { type: Date, required: true },
  dataOrigin: { type: String, enum: DATA_ORIGINS, default: 'classmate' },
});
engagementSchema.index({ decisionId: 1, type: 1 });
export const EngagementEvent = mongoose.model('EngagementEvent', engagementSchema);

// ---------- adminSessions (server-side dashboard sessions; only a keyed hash of the token is stored) ----------
const adminSessionSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  createdAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
// MongoDB deletes sessions automatically once their absolute expiry has passed.
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AdminSession = mongoose.model('AdminSession', adminSessionSchema);

export async function ensureIndexes(): Promise<void> {
  await Promise.all(
    [Customer, CustomerEvent, Offer, RuleSet, Trigger, Decision, TelegramLink, Delivery, EngagementEvent, AdminSession].map((m) => m.syncIndexes()),
  );
}

// ---------- mapping helpers ----------
type Lean = Record<string, any>;

export function toOfferRecord(d: Lean): OfferRecord {
  return {
    id: String(d._id),
    code: d.code,
    name: d.name,
    description: d.description ?? '',
    status: d.status,
    version: d.version,
    type: d.type,
    terms: d.terms ?? {},
    eligibility: d.eligibility ?? {},
    validFrom: new Date(d.validFrom),
    validTo: new Date(d.validTo),
    grantValidityHours: d.grantValidityHours,
    priority: d.priority,
    estimatedCostPaise: d.estimatedCostPaise,
    stackable: Boolean(d.stackable),
    budget: { totalPaise: d.budget.totalPaise, reservedPaise: d.budget.reservedPaise ?? 0, redeemedPaise: d.budget.redeemedPaise ?? 0 },
    usage: {
      maxGrants: d.usage.maxGrants,
      grantsIssued: d.usage.grantsIssued ?? 0,
      maxGrantsPerCustomer: d.usage.maxGrantsPerCustomer ?? 1,
      redemptions: d.usage.redemptions ?? 0,
    },
  };
}

export function toCustomerContext(d: Lean): CustomerContext {
  const f = d.features ?? {};
  return {
    id: String(d._id),
    externalRef: d.externalRef,
    segment: d.segment,
    features: {
      ...f,
      lastOrderAt: f.lastOrderAt ? new Date(f.lastOrderAt) : null,
      lastActiveAt: f.lastActiveAt ? new Date(f.lastActiveAt) : null,
      openCart: f.openCart ? { ...f.openCart, updatedAt: new Date(f.openCart.updatedAt) } : null,
    },
    rewardPoints: {
      balance: d.rewardPoints?.balance ?? 0,
      expiringPoints: d.rewardPoints?.expiringPoints ?? 0,
      expiresAt: d.rewardPoints?.expiresAt ? new Date(d.rewardPoints.expiresAt) : null,
    },
    preferredCategories: d.preferredCategories ?? [],
    optedOut: Boolean(d.optedOut),
  };
}
