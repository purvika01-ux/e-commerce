# Offerly AI — Architecture

> Status: **design document**. No application code exists yet.
> Consistent with: `Hackathon_2_Brief.pdf` (source of truth), `CLAUDE.md` (guardrails), `docs/PROJECT_PLAN.md` (requirements and phases).
> Related: `docs/API_SPEC.md` (API contracts), `docs/TESTING.md` (test harness and matrix).

Labels used in this document:

- **[PDF]** — required by the brief.
- **[CLAUDE.md]** — a project guardrail set by the user.
- **[REC]** — a design recommendation.
- **[ASSUMPTION]** — an unresolved point; the reading chosen here.

---

## 1. Overview

Offerly AI is a **modular monolith**: one Node.js + Express process (TypeScript) that hosts the REST API, the Telegram bot, the decision pipeline and a lightweight in-process scheduler. It talks to MongoDB through Mongoose.

A separate React + Vite single-page app (TypeScript, Tailwind, Motion, Lucide) is the admin dashboard. In production the Express server serves the dashboard's built static files from the same origin.

There are no microservices, queues, Docker or Python [CLAUDE.md].

```
                ┌──────────────────────── Node.js process (server/) ───────────────────────────┐
 Admin browser  │                                                                              │
 (React SPA) ──▶│  HTTP layer (Express)                                                        │
                │   ├─ middleware: requestId · auth · rate-limit · zod request validation     │
                │   └─ routes: customers · offers · rules · recommendations · decisions ·     │
                │              deliveries · redemptions · telegram · analytics · health        │
                │                                                                              │
 Telegram ─────▶│  Bot adapter (webhook in prod / long-polling in dev)                         │
 servers   ◀────│   └─ commands & button callbacks ──▶ application services                   │
                │                                                                              │
                │  Application services                                                        │
                │   ├─ Event ingestion & trigger service ── triggers (deduplicated)            │
                │   ├─ Decision orchestrator ── the ONLY pipeline from trigger to approval     │
                │   │    ├─ Context builder (customer features, permitted fields only)         │
                │   │    ├─ Rule engine: deterministic eligibility filter                      │
                │   │    ├─ AI service (Anthropic SDK) ──▶ proposal (untrusted)                │
                │   │    ├─ Fallback selector (deterministic)                                   │
                │   │    ├─ Independent validator (pure functions)                              │
                │   │    └─ Budget/usage ledger (atomic reservations)                           │
                │   ├─ Delivery service ── accepts only approved decisionIds                    │
                │   │    ├─ Telegram channel adapter (required)                                 │
                │   │    └─ Email channel adapter (optional; disabled unless configured)        │
                │   ├─ Engagement & redemption service                                          │
                │   ├─ Analytics service (aggregations over persisted events)                   │
                │   └─ Scheduler (setInterval jobs: inactivity scan, expiry sweep, lease reaper)│
                │                                                                              │
                │  Infrastructure: config (zod-validated env) · logger · Mongo repositories    │
                └──────────────────────────────────────────┬───────────────────────────────────┘
                                                           ▼
                                                  MongoDB (Atlas M0 / local)
                                                           ▲
                                  Seed CLI (npm run seed) ─┘   synthetic data generator
```

### Module layout [REC]

The layout extends `PROJECT_PLAN.md` §6.1.

```
server/src/
  config/        env schema (zod), loads and validates config at startup, never logs values
  infra/         mongo connection, logger, requestContext (AsyncLocalStorage), clock, rng
  models/        Mongoose schemas (one file per collection)
  domain/        shared zod schemas & types: Offer, Rule, Decision, Proposal, Money …
  data/          synthetic generator (personas, distributions), seed CLI
  features/      customer feature builder (RFM, churn risk, segment, discount sensitivity)
  rules/         rule-type catalogue, eligibility filter, independent validator (pure)
  ai/            Anthropic client adapter, prompt, tools, proposal schema, mock adapter
  decision/      orchestrator, fallback selector, budget ledger
  delivery/      delivery service, telegram channel, email channel, message renderer
  bot/           bot commands, callback handlers, persona linking
  triggers/      event ingestion, trigger detection, scheduler jobs
  engagement/    claims, declines, redemptions
  analytics/     aggregation queries
  routes/        Express routers (thin; call services)
  app.ts         builds the Express app with injected dependencies (testable)
  server.ts      process entry: config → db → app → bot → scheduler
server/tests/    unit/, integration/, pipeline/, fixtures/, helpers/
client/src/      app shell, pages, components, design tokens, api client
```

### Dependency injection [REC]

All side-effecting collaborators are passed in through a single `Deps` object built in `server.ts`:

- `clock`, `rng`;
- `aiClient`;
- `telegramSender`, `emailSender`;
- the repositories;
- `logger`.

Tests pass fakes for any of these. This is the basis of the test harness (`TESTING.md` §2).

---

## 2. Component responsibilities

| Component | Responsibility | Must never |
|---|---|---|
| **Frontend (React SPA)** | Admin UI for customers, offers, rules, decisions, deliveries and analytics. Clearly labels synthetic data and fallback decisions. | Hold secrets, or call Anthropic or Telegram directly |
| **HTTP layer** | Validate and authenticate requests, attach a `requestId`, call services, map errors to the standard format | Contain business logic |
| **Rule engine (eligibility)** | Pure function `filterEligible(context, offers, ruleSet, now) → {eligible[], excluded[{offerId, reasons[]}]}` | Call the AI or the database (inputs are passed in) |
| **Independent validator** | Pure function `validate(candidateDecision, context, offerSnapshot, ruleSet, now) → {ok, violations[]}`. Re-derives every constraint from first principles. | Read the AI's reasoning or confidence; reuse the eligibility result as proof |
| **AI service** | Builds a bounded prompt and runs the agent loop (§4), then returns an untrusted `Proposal` | Write to the database, send messages, see ineligible offers or other customers |
| **Fallback selector** | Deterministic choice among eligible offers (priority, then expected value, then id) plus a template message | Bypass the validator |
| **Decision orchestrator** | Runs the pipeline in §5. It is the only code path that can set a decision to `approved`. | Send messages itself; it hands off a `decisionId` |
| **Budget/usage ledger** | Atomic reserve, commit and release of budget and usage on the `offers` document | Read-modify-write without a guard condition |
| **Delivery service** | Loads an **approved** decision by id, rechecks time- and budget-sensitive conditions, renders the message, sends it idempotently and records the attempt | Accept free text or a raw proposal |
| **Telegram adapter** | Wraps the Bot API: send message, answer callback, verify webhook secret | Be constructed in `NODE_ENV=test` with a real token |
| **Email adapter (optional)** | Same interface as Telegram; only active when email env vars are present | Be required for any core flow |
| **Event & trigger service** | Ingests synthetic or bot events, detects triggers (cart abandonment, inactivity, …) and creates deduplicated `triggers` | Run the pipeline twice for the same idempotency key |
| **Engagement service** | Records claims, declines and redemptions with replay protection | Redeem a grant twice or after expiry |
| **Analytics service** | Aggregates persisted events, with every figure labelled as observed, simulated or experimental | Show hardcoded numbers; claim causation |
| **Scheduler** | In-process intervals: inactivity scan, grant expiry sweep, stale-lease reaper | Duplicate work across restarts (all jobs are idempotent) |

---

## 3. Data model (MongoDB)

### Conventions

- **Money** is stored as integer **paise** (`…Paise`) to avoid floating-point errors. The UI shows rupees.
- **Times** are UTC `Date`s. Quiet hours are evaluated in a configured IANA timezone (default `Asia/Kolkata`) [ASSUMPTION].
- All collections have `createdAt` and `updatedAt` (Mongoose timestamps) unless they are append-only.
- Every collection whose data could appear in analytics carries `dataOrigin`:
  - `seed` — synthetic generator;
  - `simulated` — simulator or admin-simulated event;
  - `classmate` — a real Telegram interaction on a synthetic profile;
  - `test` — test fixtures only.
- Mongoose schemas enforce types, enums and required fields. The **domain zod schemas** in `domain/` are the source of truth, and Mongoose mirrors them.
- **No Mongo transactions are required.** Correctness comes from single-document atomic conditional updates plus unique indexes, so the design works on a standalone local `mongod` as well as Atlas [REC].

### 3.1 Collection overview

| # | Collection | Purpose | First version? |
|---|---|---|---|
| 1 | `customers` | Synthetic customer profiles, derived features, segment, contact state, decision lease | **Essential** |
| 2 | `customerEvents` | Behavioural history: sessions, product views, cart add/remove, checkout start, orders, returns, points | **Essential** |
| 3 | `offers` | Offer definitions: commercial terms, eligibility, validity, budget and usage counters, version | **Essential** |
| 4 | `ruleSets` | Versioned, structured business rules (one active version) | **Essential** |
| 5 | `triggers` | Recommendation requests, deduplicated by idempotency key | **Essential** |
| 6 | `decisions` | Full decision audit: context snapshot, candidates, proposal, validation, approval, grant | **Essential** |
| 7 | `telegramLinks` | Telegram chat ↔ synthetic customer mapping | **Essential** |
| 8 | `deliveries` | Delivery attempts and status per decision and channel | **Essential** |
| 9 | `engagementEvents` | Claims, declines, redemptions (and simulated conversions) | **Essential** (redemption may land in M7) |
| 10 | `adminAuditLog` | Who changed which offer or rule, and when (before/after) | **Essential-lite**: needed once offers and rules are editable |
| 11 | `offerVersions` | Immutable snapshots of each offer version | **Later** (decisions already embed the snapshot they used) |
| 12 | `experiments` | Holdout/control definitions | **Later**, optional; assignment is deterministic hashing, so no assignment collection is needed |
| 13 | `segmentDefinitions` | UI-editable segment thresholds | **Later**; V1 segment thresholds live in the active `ruleSet` under `segmentation` |

**Budget and usage accounting** is kept on the `offers` document as atomic counters (§3.4). It is reconciled from `decisions` and `engagementEvents`, so V1 needs no separate ledger collection.

### 3.2 `customers`

| Field | Type / constraint | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `externalRef` | string, unique, e.g. `CUST-000123` | Human-friendly id |
| `displayName` | string | **Synthetic** name, generated |
| `persona` | enum: `loyal_high_value`, `deal_seeker`, `new_customer`, `at_risk`, `dormant`, `cart_abandoner`, `window_shopper`, `occasional` | The generator's "true" persona (ground truth for evaluation; never shown to the AI) |
| `city`, `ageBand`, `signupAt` | string / enum / Date | Synthetic demographics. **[REC]** The AI does not receive `ageBand` (unnecessary). |
| `preferredCategories` | string[] | From the generator |
| `rewardPoints` | `{balance:int≥0, expiringPoints:int≥0, expiresAt?:Date}` | |
| `features` | `{recencyDays, frequency90d, monetary90dPaise, aovPaise, churnRisk:0..1, purchaseProbability7d:0..1, discountSensitivity:0..1, returnRate:0..1, cartAbandonRate:0..1, lastOrderAt?, lastActiveAt?, openCart?:{cartId, valuePaise, items, updatedAt}}` | Recomputed by the feature builder after events change |
| `segment` | enum (`champion`, `loyal`, `promising`, `new`, `at_risk`, `hibernating`, `price_sensitive`, `window_shopper`) | Derived from features and segmentation thresholds |
| `featuresComputedAt` | Date | |
| `contactState` | `{optedOut:bool, lastOfferIssuedAt?:Date, activeGrantCount:int≥0}` | Read by validators; updated atomically |
| `decisionLease` | `{holder?:string, expiresAt?:Date}` | Per-customer mutex (§5.3) |
| `dataOrigin` | enum | `seed` for generated customers |

**Indexes:** `{externalRef:1}` unique; `{segment:1}`; `{persona:1}`; `{'features.lastActiveAt':1}` (inactivity scan); `{'decisionLease.expiresAt':1}` (sparse).

**Lifecycle:** created by seed → features updated as events arrive → may be linked to a Telegram chat → never hard-deleted in V1 (re-seeding drops the whole database in dev).

### 3.3 `customerEvents` (behaviour and purchase history)

| Field | Type / constraint |
|---|---|
| `customerId` | ObjectId → customers, required |
| `type` | enum: `session_start`, `product_view`, `search`, `cart_add`, `cart_remove`, `checkout_start`, `order_placed`, `order_returned`, `points_earned`, `points_redeemed`, `points_expiring` |
| `occurredAt` | Date, required |
| `payload` | Discriminated by `type`. E.g. `order_placed: {orderId, items:[{sku, category, pricePaise, qty}], totalPaise, discountPaise, grantId?}`; `cart_add: {cartId, sku, category, pricePaise}` |
| `sessionId` | string, optional |
| `idempotencyKey` | string, unique (sparse) — bot or admin-simulated events |
| `dataOrigin` | enum |

**Indexes:** `{customerId:1, occurredAt:-1}`; `{type:1, occurredAt:-1}`; `{idempotencyKey:1}` unique sparse.

**Lifecycle:** append-only. Purchase history is the `order_placed` and `order_returned` subset (no separate `orders` collection in V1) [REC].

### 3.4 `offers` (definitions, commercial terms and counters)

| Field | Type / constraint | Notes |
|---|---|---|
| `code` | string, unique, e.g. `WINBACK15` | Internal key |
| `name`, `description` | string (≤80, ≤500) | Marketing-facing |
| `status` | enum: `draft`, `active`, `paused`, `archived` | `expired` is derived from `validTo < now` (no write needed) |
| `version` | int ≥ 1 | Increments on any **commercial-term** or eligibility change |
| `type` | enum: `percent_off`, `flat_off`, `free_shipping`, `bonus_points` | |
| `terms` | `{percentOff?:1..90, maxDiscountPaise?:int>0, flatOffPaise?:int>0, bonusPoints?:int>0, minOrderPaise:int≥0, categories?:string[]}` | **Commercial terms. Only humans edit these.** A cross-field zod refinement checks that the right fields exist for the `type`. |
| `eligibility` | `{segments?:enum[], minChurnRisk?, maxPurchaseProbability?, minDaysSinceLastOrder?, requiresOpenCart?:bool, newCustomersOnly?:bool, minRewardPoints?}` | Offer-specific targeting |
| `validFrom`, `validTo` | Date, `validTo > validFrom` | |
| `grantValidityHours` | int 1..720 | How long an issued offer stays redeemable |
| `priority` | int 0..100 | Used by the fallback selector and tie-breaks |
| `estimatedCostPaise` | int ≥ 0 | Worst-case liability per grant (computed: flat, or `percent × assumed basket`, capped by `maxDiscountPaise`) |
| `budget` | `{totalPaise:int>0, reservedPaise:int≥0, redeemedPaise:int≥0}` | Invariant: `reserved + redeemed ≤ total` |
| `usage` | `{maxGrants:int>0, grantsIssued:int≥0, maxGrantsPerCustomer:int≥1, redemptions:int≥0}` | Invariant: `grantsIssued ≤ maxGrants` |
| `stackable` | bool (default false) | See the stacking policy (§6.3) |
| `createdBy`, `updatedBy` | string (admin id) | |

**Indexes:** `{code:1}` unique; `{status:1, validFrom:1, validTo:1}`.

**Lifecycle:** `draft → active ⇄ paused → archived`.
- Editing an `active` offer's terms bumps its `version`.
- Grants already issued keep the **snapshot** stored in their decision, so a customer always gets what they were promised.
- An offer cannot be deleted once it has decisions; it is archived instead.

**Atomic reservation** (a single `findOneAndUpdate`):

```js
filter: { _id, status: 'active', version: expectedVersion,
          validFrom: { $lte: now }, validTo: { $gt: now },
          $expr: { $and: [
            { $lte: [ { $add: ['$budget.reservedPaise', '$budget.redeemedPaise', cost] }, '$budget.totalPaise' ] },
            { $lt:  [ '$usage.grantsIssued', '$usage.maxGrants' ] } ] } }
update: { $inc: { 'budget.reservedPaise': cost, 'usage.grantsIssued': 1 } }
```

No document returned means the reservation is refused (`BUDGET_EXHAUSTED`, `USAGE_LIMIT`, `OFFER_CHANGED` or `OFFER_INACTIVE`). The orchestrator re-reads the offer to classify which.

**Release** happens on delivery failure, grant expiry or decline: `$inc reservedPaise: -cost`, guarded so the counter can't go negative. **Redemption** moves `cost` from reserved to redeemed, using the actual discount (≤ the reserved cost) and releasing any difference.

### 3.5 `ruleSets` (configurable business rules)

There is one document per **version**, and exactly one is `active: true` (enforced with a partial unique index).

| Field | Type |
|---|---|
| `version` | int, unique |
| `active` | bool |
| `rules` | array of `{key, type, enabled, params, description}`. `params` is validated by the zod schema for `type` (§6.2). |
| `segmentation` | thresholds for segment derivation (e.g. `atRisk: {minRecencyDays: 45, minFrequency: 2}`) |
| `changeNote`, `createdBy`, `createdAt` | |

**Indexes:** `{version:1}` unique; `{active:1}` partial unique where `active: true`.

**Lifecycle:**
- Every save creates version `n+1` and atomically flips `active`, with an optimistic `expectedVersion` check. A mismatch returns 409.
- Old versions are kept, which gives history and rollback.
- Each decision records the `ruleSetVersion` it was validated against.

### 3.6 `triggers` (recommendation requests)

| Field | Type |
|---|---|
| `idempotencyKey` | string, **unique** |
| `customerId` | ObjectId |
| `type` | enum: `manual`, `cart_abandoned`, `inactivity`, `points_expiring`, `purchase_frequency_drop`, `bot_request`, `campaign` |
| `source` | enum: `admin_api`, `bot`, `scheduler`, `simulator` |
| `requestedChannel` | enum: `telegram`, `email`, `none` (decide only) |
| `status` | enum: `received`, `processing`, `completed`, `failed`, `skipped` |
| `decisionId` | ObjectId, optional |
| `error` | `{code, message}`, optional |
| `dataOrigin`, `createdAt`, `completedAt` | |

**Indexes:** `{idempotencyKey:1}` unique; `{customerId:1, createdAt:-1}`; `{status:1, createdAt:1}`.

**Idempotency key formats** [REC]:

| Trigger | Key |
|---|---|
| Cart abandonment | `cart_abandoned:{customerId}:{cartId}` |
| Inactivity | `inactivity:{customerId}:{ISO-week}` |
| Points expiring | `points_expiring:{customerId}:{expiresAt-date}` |
| Bot request | `bot:{chatId}:{telegramUpdateId}` |
| Admin / API | client-supplied `Idempotency-Key` header (UUID) |

### 3.7 `decisions` (decision, validation result and audit record)

This is the central audit document. It is append-mostly: once a decision is finalised, only status, delivery and grant fields change.

| Field | Notes |
|---|---|
| `triggerId`, `customerId`, `correlationId` | Links |
| `status` | `pending` → one of `no_offer`, `rejected`, `approved`, `holdout_suppressed`, `dry_run` (admin preview: steps 2–7 only, no reservation, grant or send), `error`. Later, `approved` → `cancelled` (failed the pre-send recheck). |
| `path` | `ai`, `ai_retry`, `fallback`, `none` |
| `ruleSetVersion` | int |
| `contextSnapshot` | The exact **permitted** customer fields given to the AI and validator (no persona, no PII) |
| `candidates` | `[{offerId, offerVersion, code, score}]` — eligible offers |
| `excluded` | `[{offerId, reasons:[ruleKey…]}]` — why others were filtered out |
| `ai` | `{model, promptVersion, attempts:[{startedAt, latencyMs, toolCalls:[{name, ok}], outcome:'ok'|'timeout'|'api_error'|'rate_limited'|'schema_invalid'|'validation_failed', rawProposal?(redacted, truncated), errorCode?}], usage?:{inputTokens, outputTokens}}` |
| `proposal` | Parsed proposal actually used: `{offerId or null, copy:{headline, body}, rationale}`. The rationale is **display only**. |
| `validation` | `{ok, validatorVersion, checkedAt, violations:[{ruleKey, code, message}]}`. Every validator run is appended to `validationHistory[]`, including the pre-send recheck. |
| `offerSnapshot` | Full copy of the offer's `type`, `terms`, `version` and `code` at approval. **This is what the customer is promised.** |
| `reservation` | `{costPaise, reservedAt, releasedAt?, releaseReason?}` |
| `grant` | `{code (random, unique, e.g. OFR-7KQ2-M9), status:'issued'|'claimed'|'redeemed'|'expired'|'declined'|'void', issuedAt, expiresAt}` |
| `holdout` | `{experimentKey, assigned:bool}`, optional |
| `dataOrigin` | |

**Indexes:** `{triggerId:1}` unique (one decision per trigger); `{customerId:1, createdAt:-1}`; `{status:1, createdAt:-1}`; `{'grant.code':1}` unique sparse; `{'grant.status':1, 'grant.expiresAt':1}` (expiry sweep).

**Validation results live inside the decision** so the audit is a single read. Admin edits go to `adminAuditLog`.

### 3.8 `telegramLinks`

| Field | Notes |
|---|---|
| `chatId` | number, **unique** |
| `customerId` | ObjectId → customers, **unique** (one classmate per synthetic profile) |
| `firstName` | optional, for the greeting only [CLAUDE.md data minimisation] |
| `personaChoice` | the persona the classmate picked |
| `status` | `active`, `blocked` (bot got a 403), `unlinked` (`/stop`) |
| `linkedAt`, `lastInteractionAt` | |

No username, phone number or other Telegram profile data is stored.

**Lifecycle:**
- `/start` shows the persona picker. A pick links the chat to an **unlinked synthetic customer of that persona**, chosen atomically (§7.1).
- `/stop` sets the status to `unlinked`, sets `customers.contactState.optedOut = true`, and clears `firstName`.

### 3.9 `deliveries`

| Field | Notes |
|---|---|
| `decisionId`, `customerId`, `channel` (`telegram` / `email`) | |
| `idempotencyKey` | `deliver:{decisionId}:{channel}`, **unique** |
| `status` | `queued` → `sending` → `sent` / `failed_retryable` / `failed_permanent` / `cancelled_precheck` |
| `attempts` | `[{at, outcome, errorCode?, httpStatus?, retryAfterSec?}]`, at most 3 |
| `providerMessageId` | e.g. Telegram `message_id` |
| `renderedMessageHash` | sha256 of the exact text sent; the text itself is kept in the decision copy and terms snapshot |
| `nextAttemptAt` | for retryable failures |

**Indexes:** `{idempotencyKey:1}` unique; `{decisionId:1}`; `{status:1, nextAttemptAt:1}`.

### 3.10 `engagementEvents`

| Field | Notes |
|---|---|
| `decisionId`, `customerId`, `grantCode` | |
| `type` | `delivered`, `claimed`, `declined`, `redeemed`, `expired`, `conversion_simulated` |
| `idempotencyKey` | **unique** (e.g. `redeem:{grantCode}`, `claim:{grantCode}`, `cb:{callbackQueryId}`) |
| `payload` | e.g. `redeemed: {orderValuePaise, discountPaise}` |
| `dataOrigin` | `classmate`, `simulated` or `seed` — drives analytics labels |
| `occurredAt` | |

**Indexes:** `{idempotencyKey:1}` unique; `{decisionId:1, type:1}`; `{type:1, occurredAt:-1}`.

**Redemption replay protection** has two layers:
1. the unique `redeem:{grantCode}` key;
2. an atomic `decisions.findOneAndUpdate({'grant.code', 'grant.status': {$in: ['issued','claimed']}, 'grant.expiresAt': {$gt: now}}, {$set: {'grant.status': 'redeemed'}})`.

### 3.11 `adminAuditLog`

`{actor, action ('offer.create'|'offer.update'|'offer.status'|'rules.update'|'telegram.unlink'|…), entityType, entityId, before?, after?, at, requestId}`. Append-only, indexed by `{entityType, entityId, at:-1}`.

### 3.12 Later collections

- **`offerVersions`**: `{offerId, version, terms, eligibility, createdAt}`. Decisions already embed snapshots, so this only adds browsing history.
- **`experiments`**: `{key, holdoutPercent, status, startAt, endAt}`.
  - Assignment is `hash(customerId + key) mod 100 < holdoutPercent`. It is deterministic and needs no stored assignments.
  - A holdout customer's eligible decision is fully validated, then recorded as `holdout_suppressed` without being sent. This keeps the comparison fair.

---

## 4. The agent: permissions and tools

### 4.1 Design

The AI is a **bounded agent**. It can only *read* a pre-scoped, already-filtered view of the world and *propose*. Two execution modes share the same proposal schema and validator:

- **Mode A — single structured call (V1, M8).** The orchestrator pre-loads the permitted context and the eligible candidates into the prompt. Claude returns one structured proposal through a forced tool call / structured output. This is the cheapest and most predictable mode.
- **Mode B — bounded tool loop (enhancement, M13) [REC].** Claude receives a short brief and may call read-only tools to inspect context and compare candidates before calling `submit_proposal`. Limits: at most **5** tool calls, a **15 s** total timeout and a fixed `max_tokens`. This demonstrates the agentic behaviour.

In both modes:
- the customer id and the candidate set are **bound server-side in a closure**, so the model cannot query a different customer or offer;
- every tool result is computed by deterministic code;
- model output is untrusted.

Confirm current SDK parameter names and model ids with the `claude-api` skill at implementation time [CLAUDE.md].

### 4.2 Tool catalogue

| Tool | Input (zod) | Output | Purpose | Permission | Failure behaviour |
|---|---|---|---|---|---|
| `get_customer_context` | `{}` (customer bound) | `{segment, features{recencyDays, frequency90d, aovRupees, churnRisk, purchaseProbability7d, discountSensitivity, cartAbandonRate}, openCart?{valueRupees, categories}, rewardPoints{balance, expiringSoon}, preferredCategories, recentActivity:[{type, daysAgo, category?}] (≤10)}` | Inspect permitted synthetic context | Read-only; excludes persona, name, city, age, events older than 90 days | DB error → tool returns `{error:'unavailable'}`; the orchestrator aborts the AI path and falls back |
| `list_eligible_offers` | `{}` | `[{offerId, code, name, type, termsSummary (rendered deterministically), categories, priority}]` | See the already-eligible candidates only | Read-only; the list is fixed before the agent starts | Empty list never happens (the AI is not invoked when there are no candidates) |
| `compare_candidates` | `{offerIds: string[1..5]}` | `[{offerId, estimatedCostRupees, expectedValueScore, fitNotes[]}]` | Deterministic scoring help (e.g. cart-category match, cost) | Read-only; unknown ids → `{error:'not_a_candidate', offerId}` | Errors are returned to the model as tool results, not thrown |
| `submit_proposal` (terminal) | `Proposal` (below) | — | The final answer | Ends the loop; the output is **only a proposal** | Invalid schema → recorded as `schema_invalid` → one retry (with errors) → fallback |

**`Proposal` schema (strict, `additionalProperties: false`):**

```ts
{
  decision: 'offer' | 'no_offer',
  offerId: string | null,           // must be one of the candidate ids when decision='offer'
  copy: {                           // required when decision='offer'
    headline: string (1..60),
    body: string (1..280)
  } | null,
  rationale: string (1..400),       // stored for display only; never used in validation
  confidence?: number (0..1)        // stored only; never used in validation
}
```

The agent **cannot** do any of the following, and no tool for them exists:
- send messages;
- create or edit offers or terms;
- change rules or budgets;
- set a decision's status;
- approve its own output;
- invoke the validator;
- see other customers.

**Copy policy:**
- The AI writes **wording only**. It must **not** include numbers attached to money or percentages, currency symbols, dates, codes or URLs.
- The commercial terms block (value, minimum spend, expiry, grant code) is **rendered deterministically** from `offerSnapshot` and appended by the message renderer (§6.4).
- The validator enforces this (`COPY_CONTAINS_TERMS`).

---

## 5. Decision and validation pipeline

### 5.1 Exact order

| # | Step | Writes | On failure |
|---|---|---|---|
| 1 | **Validate request & deduplicate trigger.** Zod-validate the input. `insertOne` into `triggers` with the unique `idempotencyKey`. | `triggers` (received) | Bad input → 400, nothing written. Duplicate key → return the existing trigger/decision (`deduplicated: true`); no new work. |
| 1b | **Acquire the customer decision lease** (§5.3) | `customers.decisionLease` | Lease held → trigger `skipped` (`CUSTOMER_BUSY`) and 409 for the API. The bot/scheduler retries later under the same key. |
| 2 | **Load customer context.** Customer + features (recompute if stale > 15 min) + recent events. | — | DB error → trigger `failed`, release the lease, **no send** (fail closed). |
| 3 | **Load active offers and the active rule set** | — | Same as step 2 |
| 4 | **Deterministic eligibility filter** → `eligible[]`, `excluded[]` | `decisions` (pending: snapshot, candidates, excluded, ruleSetVersion) | No candidates → `status: no_offer`, `path: none`; done. **The AI is not called.** |
| 4b | **Holdout check** (only if an experiment is active) | — | Assigned to holdout → continue through validation using the fallback choice, then `holdout_suppressed` (no send) |
| 5 | **AI selects & personalises** (Mode A/B), timeout 15 s, `max_tokens` capped | `decisions.ai.attempts[]` | Timeout / API error / 429 / 5xx → `path: fallback` (no AI retry on 429; one retry on schema or validation failure) |
| 6 | **Schema-validate the proposal and check `offerId ∈ candidates`** | — | Invalid or fabricated id → retry once with the error list, then fallback |
| 7 | **Independent validation** of the selected offer + copy against the *current* rule set and freshly re-read offer (§6.2) | `decisions.validationHistory[]` | Violations → retry the AI once with the violations, then fallback. **The fallback is validated too.** If the fallback fails → `status: rejected`, no send. Validator exception → `status: error`, no send. |
| 7b | **`no_offer` from the AI** is accepted (it is always safe) | `decisions` (no_offer, path ai) | — |
| 8 | **Reserve budget & usage** (atomic `findOneAndUpdate`, §3.4), guarded by `offer.version == snapshot.version` | `offers` counters; `decisions.reservation` | Refused → re-read the offer and classify the reason; if another candidate remains, retry steps 7–8 with the next fallback candidate (at most 2), else `rejected` |
| 8b | **Atomically update customer contact state** (`contactState.activeGrantCount < cap`, `lastOfferIssuedAt` past the cool-down) | `customers.contactState` | Refused → release the reservation, then `rejected (FREQUENCY_CAP)` |
| 9 | **Persist the approved decision**: `status: approved`, `offerSnapshot`, grant code, `grant.expiresAt` | `decisions` | Write fails → release the reservation and contact state (compensation), `status: error`, no send |
| — | **Release the lease;** trigger `completed` | `customers`, `triggers` | |
| 10 | **Deliver** (only if a channel is requested and linked). The delivery service loads the decision by id and requires `status: approved`. It **rechecks** expiry, offer status, opt-out, quiet hours and the grant status, and re-runs the validator against the current rule set. Then it inserts a `deliveries` row with a unique key and sends. | `deliveries`, `decisions.validationHistory[]` | Recheck fails → `deliveries.cancelled_precheck`, `decision.status: cancelled`, release the reservation. Send fails → see §5.4. |
| 11 | **Record outcomes:** `engagementEvents.delivered`; later claimed, declined, redeemed or expired (button callbacks, the redemption API, the expiry sweep) | `engagementEvents`, `decisions.grant`, `offers` counters | Duplicate callbacks are absorbed by the unique `idempotencyKey` |

**Invariant:** a message can only be produced by `DeliveryService.deliver(decisionId)`, and that function refuses anything that is not `approved` with a passing validation recorded **at send time**.

### 5.2 Transaction boundaries

There are no multi-document transactions. Each of these is a **single-document atomic operation**:
1. trigger insert (unique key);
2. lease acquire and release;
3. offer reservation;
4. customer contact-state update;
5. decision state transitions (`findOneAndUpdate` with an expected current status);
6. delivery insert (unique key) and status transitions;
7. redemption (grant status guard).

Multi-step consistency comes from **ordering plus compensation**: reservations are released if a later step fails. A periodic **reconciler** (scheduler, every 10 min) recomputes `reservedPaise` and `grantsIssued` from decisions and logs any drift. This is defence in depth.

### 5.3 Concurrency

- **Same trigger twice** (double click, Telegram re-delivering an update): the unique `triggers.idempotencyKey` means exactly one runs.
- **Different triggers, same customer, at the same time:** a per-customer **lease**.
  - Acquire with `customers.findOneAndUpdate({_id, $or: [{'decisionLease.expiresAt': {$lt: now}}, {'decisionLease.expiresAt': {$exists: false}}]}, {$set: {decisionLease: {holder: triggerId, expiresAt: now + 60s}}})`.
  - This serialises frequency-cap decisions per customer. Stale leases expire on their own.
- **Many customers claiming the same offer budget:** the guarded `$inc` on `offers` can never push `reserved + redeemed` past `total`, or `grantsIssued` past `maxGrants`.
- **An offer or rules changed mid-pipeline:**
  - the reservation filter includes `version: snapshot.version`;
  - the pre-send recheck uses the *current* rule set.
  - A stale decision is therefore never sent. It is cancelled and its reservation released.

### 5.4 Retries and idempotency

| Operation | Retry policy |
|---|---|
| Claude call | At most 1 retry for **schema or validation failure**, carrying the error feedback. **No retry** on timeout, 429 or 5xx in the request path: go straight to fallback, to keep latency bounded. Uses the SDK's built-in retries set to 0 or 1 [REC]. |
| Telegram send | Up to 3 attempts with backoff. Honour `retry_after` on 429. Network or 5xx → `failed_retryable`. 400 (bad request) → `failed_permanent`. 403 (blocked) → `failed_permanent` + `telegramLinks.status = blocked` + release the reservation. Retries reuse the same `deliveries` row (same idempotency key). |
| Telegram sent-but-unknown | If the outcome is unknown (timeout after send), mark `failed_retryable`. On retry, accept a tiny risk of a duplicate message rather than lose the offer. The *grant* is still single, so the customer cannot redeem twice. **[ASSUMPTION]** This is acceptable for the hackathon. |
| Redemption | Idempotent by `redeem:{grantCode}`. Replays return the original result with `200` and `replayed: true`. |

### 5.5 Failure summary (fail closed)

| Failure | Result |
|---|---|
| Any failure in steps 2–9 | Ends in `no_offer`, `rejected` or `error`, and **never** sends |
| Validator throws or returns malformed output | Treated as a failure, not a pass |
| DB unreachable | 503 from the API; the bot replies "Offers are unavailable right now"; nothing is sent |

---

## 6. Dynamic offers and business rules

### 6.1 Offers are data, not code

Admins can do all of the following from the UI, with no code change:
- create, edit, activate, pause and archive offers;
- set terms, eligibility, validity, budget, usage limits, grant validity, priority and stacking.

Validation is done by the shared zod schema, which the API and the frontend form both use. Changes are written to `adminAuditLog`. Editing commercial terms or eligibility on an active offer bumps `version`. In-flight decisions on the old version fail their reservation or recheck, and issued grants keep their snapshot.

### 6.2 Rule-type catalogue (structured, UI-editable)

Each rule is `{key, type, enabled, params, description}`. The **type** decides which validator check runs and which zod schema the params follow. Marketing users edit **params and enabled** through form controls with plain-language labels. New *types* require code, which is intentional: it keeps enforcement exact.

| Type | Params (defaults) | Plain-language label | Enforced in |
|---|---|---|---|
| `MAX_DISCOUNT_PERCENT` | `{maxPercent: 25}` | "No offer may give more than **25%** off" | eligibility + validator |
| `MAX_DISCOUNT_AMOUNT` | `{maxPaise: 50000}` | "No single offer may be worth more than **₹500**" | eligibility + validator |
| `MIN_ORDER_FOR_DISCOUNT` | `{minPaise: 49900}` | "Discounts need a minimum basket of **₹499**" (offer `minOrderPaise` must be ≥ this) | eligibility + validator + redemption |
| `FREQUENCY_CAP` | `{maxOffers: 2, windowDays: 7}` | "At most **2** offers per customer every **7** days" | eligibility + validator + atomic contact state |
| `PURCHASE_COOLDOWN` | `{days: 3}` | "Don't send offers within **3** days of a purchase" | eligibility + validator |
| `NO_STACKING` | `{maxActiveGrants: 1}` | "A customer can hold at most **1** unused offer" (unless `stackable` offers are allowed below) | eligibility + validator + atomic contact state |
| `ALLOW_STACKABLE_WITH` | `{types: ['bonus_points']}` | "Bonus-points offers may be held alongside a discount" | validator |
| `LIKELY_BUYER_SUPPRESSION` | `{maxPurchaseProbability: 0.7, appliesToTypes: ['percent_off','flat_off']}` | "Don't give discounts to customers already **70%+** likely to buy" (lost-margin rule [PDF problem statement]) | eligibility + validator |
| `SEGMENT_EXCLUSION` | `{segments: []}` | "Never send offers to these segments" | eligibility + validator |
| `RETURN_ABUSE_EXCLUSION` | `{maxReturnRate: 0.4}` | "Skip customers who return more than **40%** of orders" | eligibility + validator |
| `QUIET_HOURS` | `{startHour: 22, endHour: 8, timezone: 'Asia/Kolkata'}` | "Don't send between **10 pm** and **8 am**" | pre-send recheck (defers rather than rejects; the decision stays `approved` until `grant.expiresAt`) |
| `DAILY_SEND_CAP` | `{maxPerDay: 200}` | "Send at most **200** offers per day in total" | pre-send recheck (count of today's `deliveries.sent`) |
| `COPY_POLICY` | `{maxHeadline: 60, maxBody: 280, bannedPhrases: ['guaranteed','last chance ever','100% free']}` | "Message wording rules" | validator |
| `OFFER_EXPIRY_BUFFER` | `{minHoursRemaining: 2}` | "Don't send an offer that expires in under **2** hours" | validator + pre-send recheck |

Always-on checks (**not configurable**; they are safety invariants):
- the offer exists, is `active`, is inside `validFrom`/`validTo`, and its version matches;
- the offer is among the eligible candidates;
- the customer is not opted out and has an active link for the channel;
- budget and usage have headroom;
- `maxGrantsPerCustomer` is not exceeded;
- the copy contains no terms (`COPY_CONTAINS_TERMS`), no URLs and no markup;
- the proposal schema is valid.

**The eligibility filter and the validator are separate implementations of the same constraints [REC].** The validator re-reads the offer and recomputes everything from the context snapshot and the current rule set. It never trusts the filter's output, so a bug in one is caught by the other. Tests assert that they agree on fixtures (`TESTING.md` U-30).

**Rule edits:**
- Saving creates a new `ruleSets` version (optimistic concurrency via `expectedVersion`).
- The **rule impact preview** (dry-run eligibility over all customers with the proposed params) is an **optional enhancement** (M13).

### 6.3 Stacking policy

Default: `NO_STACKING {maxActiveGrants: 1}`. A customer with an unredeemed, unexpired grant receives no new discount offer. Exception: offers whose type is listed in `ALLOW_STACKABLE_WITH` and that are marked `stackable: true`. Redemption also enforces **one grant per order** [ASSUMPTION].

### 6.4 Commercial terms vs AI wording

The final Telegram message has two clearly separated parts:

```
🎁 *{AI headline}*                      ← AI-written, validated, Markdown-escaped
{AI body}                               ← AI-written, validated, Markdown-escaped
────────────
💸 15% off (up to ₹300)                 ← rendered from offerSnapshot.terms (deterministic)
🛒 Min. order ₹999 · Fashion only
⏳ Valid until 25 Oct, 9:00 pm
🔑 Code: OFR-7KQ2-M9
[ ✅ Claim ]  [ 🙅 Not interested ]  [ 🧾 My offers ]
```

The AI cannot alter the terms block. The fallback uses template headlines and bodies per offer type and segment. All copy is escaped for Telegram MarkdownV2 (or sent as HTML with escaping) [REC].

### 6.5 Event-based triggers without duplicates

Detection runs in two places: on event ingestion (cart events, bot actions) and in scheduler scans (inactivity, points expiry).

| Trigger | Condition (configurable thresholds in the rule set) | Idempotency key | Re-evaluation |
|---|---|---|---|
| Cart abandonment | Open cart with value ≥ X, no `checkout_start`/`order_placed` within N minutes (default 30) | `cart_abandoned:{customerId}:{cartId}` | A new cart id gives a new trigger. The same cart never fires twice. |
| Inactivity | `recencyDays ≥ 30` and churn risk ≥ 0.5 | `inactivity:{customerId}:{ISO-week}` | At most once per week |
| Points expiring | Expiring points > 0 and `expiresAt` within 7 days | `points_expiring:{customerId}:{date}` | Once per expiry date |
| Purchase-frequency drop | `frequency90d` below 50% of the customer's prior 90-day frequency | `freq_drop:{customerId}:{ISO-month}` | Monthly |
| Bot "show me an offer" | User action | `bot:{chatId}:{updateId}` | Each tap is unique, but the frequency cap and stacking rules still apply |

Even if two different triggers fire for one customer close together, the lease plus `FREQUENCY_CAP` and `NO_STACKING` make the second decision `no_offer` or `rejected`. **No duplicate offer reaches the customer.**

**Demo flow [REC]:** the bot offers "🛍️ Simulate: browse / add to cart / leave". This writes `dataOrigin: classmate` events to the linked synthetic customer and shows real-time triggering.

---

## 7. Telegram and email delivery

### 7.1 Telegram (required [PDF])

**Library:** grammY or Telegraf, chosen in M3 and then used consistently [CLAUDE.md].

**Mode:**
- Development: **long polling**.
- Production: **webhook** at `POST /api/telegram/webhook`, verified by the `X-Telegram-Bot-Api-Secret-Token` header.

**Commands and actions:**
- `/start` sends a welcome and a synthetic-data notice, then the persona picker. Linking chooses an unlinked customer with the matching persona via `findOneAndUpdate` on a candidate plus an insert into `telegramLinks` (unique `customerId`).
- `/offer` creates a `bot_request` trigger.
- `/myoffers` lists active grants.
- `/profile` shows the synthetic profile summary.
- `/stop` opts out and unlinks.
- `/help` lists the commands.
- Callback buttons:
  - `claim:{grantCode}` and `decline:{grantCode}`;
  - `redeem:{grantCode}` for a **simulated** checkout with a synthetic basket ≥ min order, labelled as a simulation;
  - simulation actions.

**Throttling [REC]:** a simple in-process limiter keeps sends to ≤ 25 msgs/s globally and ≤ 1 msg/s per chat.

**Rule:** never send to a chat without an active link, and never to an opted-out customer.

### 7.2 Email (optional [CLAUDE.md])

Email uses the same `ChannelAdapter` interface: `send(renderedMessage, recipient) → {providerMessageId}`. It is enabled only when the SMTP env vars are set.

Synthetic customers have **no real email addresses**. Email delivery would go to an admin-configured test inbox only [ASSUMPTION]. It is out of scope until the core is done.

---

## 8. Observability and evaluation

### 8.1 Logs and correlation

- **Structured JSON logs** (e.g. pino [REC]) with the fields `level, time, msg, requestId, correlationId, triggerId?, decisionId?, customerRef?, component`.
- **Redaction paths:** `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, `authorization`, `cookie`, and the bot token inside URLs. Never log full prompts with secrets. Model raw output is stored truncated (≤ 2 KB) in the decision, not in logs.
- **Correlation:**
  - `requestId` comes from the `X-Request-Id` header (or a generated UUID) and is echoed in responses and error bodies.
  - `correlationId = triggerId`. It is propagated via AsyncLocalStorage through AI, validator, delivery and engagement, so one id traces a whole offer journey.
- **Error reporting:**
  - Errors are typed (`AppError {code, httpStatus, safeMessage}`). Unknown errors become 500s with a generic message, with the stack logged server-side only.
  - The process logs unhandled rejections and shuts down gracefully (closes the bot and the DB).
  - **[REC]** No external error service; logs are the source.

### 8.2 Decision audit fields

Every decision stores:
- `triggerId`, `correlationId`, `ruleSetVersion`, `contextSnapshot`;
- `candidates` and `excluded` (with reasons);
- the AI attempts (model, prompt version, latency, outcome, token usage) and `path`;
- the proposal (including the rationale, for display);
- `validationHistory` (every run, with violations);
- `offerSnapshot`, `reservation`, the grant lifecycle and delivery references.

The Decision Log UI shows all of this in plain language.

### 8.3 Operational metrics

Computed from the database, not hardcoded:

- **Pipeline funnel:** triggers → decisions → approved → sent → claimed → redeemed.
- **Shares and rejections:** AI vs fallback share, validator rejections by rule, AI failure types.
- **Latency:** p50/p95 AI latency and decision latency.
- **Money:** budget used per offer (reserved, redeemed, remaining) and discount cost.
- **Delivery:** success rate and failures by reason.
- **Health:** `GET /api/health` reports process, DB and bot status.

### 8.4 Synthetic vs measured: labelling

Every analytics figure is tagged by `dataOrigin`:

| Badge | Source | Meaning |
|---|---|---|
| **Observed (classmates)** | `classmate` | Real interactions by classmates on synthetic profiles. Real behaviour, but a tiny and non-representative sample. |
| **Simulated** | `seed` / `simulated` | Produced by the generator or simulator. These show system behaviour, **not** market truth. |
| **Experimental** | Holdout comparisons | Shown with sample size and a "directional only" note when n is small |

The UI shows these badges on every chart, and a persistent "Synthetic data" banner.

### 8.5 Evaluating recommendation quality (without claiming causation)

1. **Rule compliance (hard metric).** Share of sent offers that passed validation at send time. **Must be 100%.** Also counts violations caught before sending.
2. **Relevance against ground truth.** The generator knows each customer's *true* persona and latent propensities, which are hidden from the AI. Score decisions against a **relevance rubric** (`TESTING.md` §9). Examples:
   - an at-risk customer gets a win-back offer;
   - a likely buyer gets no discount;
   - a cart abandoner gets an offer matching the cart's categories;
   - a points holder near expiry gets a points nudge.

   Report the **rubric pass rate** by persona for AI vs fallback.
3. **Cost efficiency.** Expected discount cost per approved offer; share of discount spend going to low-purchase-probability customers (higher is better: it is less "lost margin").
4. **Engagement (observed, classmates).** Claim, decline and redemption rates. These are reported as **descriptive** results, never as "offers caused X".
5. **Uplift (optional, experimental).** A deterministic holdout. Compare simulated conversion between treated and holdout synthetic customers.
   - **Caveat:** simulated conversion comes from our own propensity model, so uplift on it validates the *pipeline mechanics*, not real-world effectiveness.
   - Observed classmate numbers are too small for causal claims.
   - The UI and README state this explicitly [CLAUDE.md].

---

## 9. Security architecture (summary)

**Configuration**
- Zod-validated env at startup.
- `ANTHROPIC_API_KEY` is required unless `AI_MODE=off`. `TELEGRAM_BOT_TOKEN` is required unless `TELEGRAM_MODE=off`.
- Errors name the variable, never its value.
- There are no `VITE_` secrets.

**Admin authentication [REC]**
- A single admin account from `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` (bcrypt), plus a signed, httpOnly, `SameSite=Strict` session cookie (JWT, signed with `SESSION_SECRET`, 8 h expiry).
- One role (`admin`) in V1. All `/api/*` routes except health and the Telegram webhook require it.
- **CSRF:** a `SameSite=Strict` cookie plus a required custom header (`X-Requested-With: offerly`) on mutating requests.

**Request protection**
- `helmet`, a strict CORS origin (the dashboard origin only), JSON body limit 100 KB.
- zod validation for every body, query and params; Mongo operator injection is blocked because zod rejects unknown keys and `$`-prefixed keys.
- Rate limits: login 5/min/IP, recommendations 30/min/admin, webhook 120/min.

**Telegram**
- Webhook verified by the secret header.
- The callback payload carries only the grant code; ownership is checked by matching `chatId → customerId` to the grant's `customerId`.

**AI**
- The prompt contains only permitted synthetic fields.
- Model output is untrusted and schema-validated. Copy is escaped before rendering.

**Honest scope:** this is hackathon-grade security, with one admin and no multi-tenant RBAC. The README will state what is and is not protected [CLAUDE.md].

---

## 10. Milestone sequence

These milestones refine `PROJECT_PLAN.md` §6.2 phases into small, independently testable steps. The phase mapping is shown in brackets.

Rules that apply to every milestone [CLAUDE.md]:
- one milestone per prompt;
- run tests, typecheck, lint and build before reporting;
- recommend a commit message, but **don't commit unless asked**;
- report in the 6-point format.

Rules that apply to each one:

> **Common definition of done:**
> - The scope is implemented.
> - The listed automated tests are written and **actually pass**.
> - `tsc --noEmit` is clean.
> - Lint is clean (once configured).
> - Build succeeds where applicable.
> - Docs are updated where now inaccurate.
> - No secrets are in tracked files.
> - Manual steps have been done or are reported as not done.

### M1 — Server scaffold, config, health and verified DB connection [Phase 0]

**Scope**
- `server/` TypeScript + Express app factory.
- Zod env config.
- Mongo connection with retry.
- Logger with redaction.
- Request id middleware.
- Standard error handler.
- `GET /api/health`.
- `.gitignore` (including `.env*` except `.env.example`), `.env.example`.
- Vitest + Supertest setup, with an in-memory MongoDB for tests (`mongodb-memory-server` [REC]).

**Files:** `server/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{app,server}.ts`, `src/config/*`, `src/infra/{mongo,logger,requestContext,errors}.ts`, `src/routes/health.ts`, `tests/integration/health.test.ts`, `tests/unit/config.test.ts`, root `.gitignore`, `.env.example`.

**Acceptance criteria**
- With a valid `MONGODB_URI`, the health endpoint returns `200 {status:'ok', db:{status:'connected', latencyMs}}`.
- With the DB down, it returns `503 {status:'degraded', db:{status:'disconnected'}}`.
- A missing required env var gives a startup error naming the variable, without its value.

**Tests:** health (connected / disconnected), config (missing / invalid / redaction), error handler format, request id echo.

**Manual:** run `npm run dev`, then `curl localhost:PORT/api/health` against local Mongo **and** Atlas. Check `git status` shows no `.env`.

**Dependencies:** none.

### M2 — Domain schemas, models, synthetic data generator and seed CLI [Phase 1]

**Scope**
- Zod domain schemas and Mongoose models for `customers` and `customerEvents`.
- A seeded generator: personas, skewed spend, log-normal order values, seasonality, cart abandonment, returns, points.
- The feature builder and segment derivation.
- `npm run seed -- --customers 1000 --seed 42`.

**Files:** `src/domain/*`, `src/models/{customer,customerEvent}.ts`, `src/data/{personas,generator,distributions,seed}.ts`, `src/features/*`, tests.

**Acceptance criteria**
- The same seed produces identical output.
- Distribution sanity checks hold: top 20% of customers ≥ 55% of revenue; cart abandonment 55–80%; each persona's feature ranges are distinguishable.
- No real PII.

**Tests:**
- generator determinism;
- distribution assertions;
- feature-builder unit tests (RFM, churn risk, segment boundaries);
- model validation rejects bad docs.

**Manual:** seed, then inspect a few customers in Mongo or the shell; spot-check realism.

**Dependencies:** M1.

### M3 — Telegram bot registration and persona linking (no offers yet) [Phase 0/3]

This milestone comes early so the bot link can be shared early [PDF] and `/start` chats are captured.

**Scope**
- Choose grammY or Telegraf.
- `telegramLinks` model.
- Bot adapter with polling in dev; `/start` (persona picker, linking), `/profile`, `/stop`, `/help`.
- `TELEGRAM_MODE=off|polling|webhook`.
- A test-mode guard that refuses a real client under test.

**Files:** `src/bot/*`, `src/models/telegramLink.ts`, `src/delivery/telegramChannel.ts` (send only), tests with a fake Telegram API.

**Acceptance criteria**
- `/start` → persona → linked to a unique synthetic customer.
- A second `/start` doesn't create a second link.
- `/stop` opts out.
- Concurrent persona picks never double-assign a customer.

**Tests:** linking, duplicate `/start`, concurrent linking, `/stop`, malformed updates ignored, no real network in tests.

**Manual:**
- The **user** creates the bot in @BotFather and puts the token in `.env`.
- Run, `/start` from your own account, and check the link record.
- **Share the bot link with classmates.**

**Dependencies:** M2.

### M4 — Offers, rule sets, admin auth and CRUD API [Phase 2]

**Scope**
- `offers`, `ruleSets` and `adminAuditLog` models with zod schemas (the rule-type catalogue, §6.2).
- Admin login and session.
- Auth, offers and rules endpoints per `API_SPEC.md` §3, §5 and §6, plus the read-only customer endpoints (§4).
- A default rule set and sample offers created by the seed.

**Acceptance criteria**
- Invalid offer terms are rejected with field errors.
- A rule save creates a new version; a stale `expectedVersion` → 409.
- Every mutation is audited.
- Unauthenticated requests → 401.

**Tests:** schema unit tests (every rule type: valid and invalid params), API integration (CRUD, versioning, 401/403/409), audit entries written.

**Manual:** log in via curl/Postman, create and pause an offer, edit a rule, and view the history.

**Dependencies:** M1 and M2.

### M5 — Eligibility engine and independent validator (pure) [Phase 2]

**Scope:** `rules/eligibility.ts`, `rules/validator.ts`, the copy policy checker, the deterministic fallback selector, and template copy.

**Acceptance criteria**
- Every rule type and always-on check is enforced in both the filter and the validator.
- The validator ignores rationale and confidence.
- The two implementations agree on the fixture matrix.

**Tests:** `TESTING.md` U-01…U-35 and U-42 (boundary values, each rule on/off, expired/paused, copy containing terms, fabricated ids).

**Manual:** none beyond reviewing the test report.

**Dependencies:** M4.

### M6 — Decision orchestrator with fallback-only path, ledger and recommendations API [Phase 3]

**Scope**
- `triggers` and `decisions` models.
- The orchestrator (steps 1–9) using an `AiClient` that is **disabled** (`AI_MODE=off`, so it always takes the fallback path).
- Lease, atomic reservation, contact-state update and compensation.
- `POST /api/recommendations`, `GET /api/decisions[/:id]`.
- The reconciler job.

**Acceptance criteria**
- Duplicate idempotency keys return the same decision.
- Concurrent requests never overspend the budget or exceed the frequency cap.
- DB failure → no approval.
- The audit fields are complete.

**Tests:** pipeline, concurrency, fault and API tests listed for M6 in `TESTING.md` §13 (P-xx with the fallback path, C-01…C-04, C-09, C-10, F-07…F-09, F-16, I-18…I-24).

**Manual:** call the API for a few seeded customers and inspect the decisions.

**Dependencies:** M5.

### M7 — Delivery service and thin end-to-end slice via Telegram [Phase 3]

**Scope**
- `deliveries` and `engagementEvents` models.
- The delivery service with pre-send recheck, idempotent sends and retry/backoff.
- The message renderer (AI copy + deterministic terms block).
- Bot `/offer`, `/myoffers`, and Claim / Not interested / simulated Redeem buttons.
- The redemption service with replay protection.
- The grant expiry sweep.

**Acceptance criteria**
- A linked classmate taps `/offer` and receives a validated offer.
- Claim and redeem are recorded once.
- A changed rule or paused offer between approval and send → cancelled, not sent.
- A blocked user → permanent failure, reservation released.

**Tests:** the M7 row of `TESTING.md` §13 (D-01…D-11, D-13…D-15, R-01…R-08, C-05, C-06, F-10…F-12, I-25…I-29).

**Manual:** **test on one classmate** [PDF]: `/start` → `/offer` → claim → redeem. Then pause the offer and confirm nothing is sent.

**Dependencies:** M3 and M6.

### M8 — Claude AI adapter (Mode A) with retry and fallback [Phase 4]

**Scope**
- `ai/anthropicClient.ts` (official SDK, model from `CLAUDE_MODEL`, timeout, `max_tokens`).
- Prompt v1, the proposal schema, a forced structured output.
- Retry-once-with-violations, then fallback.
- A mock adapter for tests.
- Token-usage recording.

**Acceptance criteria**
- Valid proposals are used.
- Every invalid kind (schema, fabricated id, terms in copy, banned phrase) → retry then fallback.
- Timeout, 429 and 5xx → fallback.
- No live calls in tests.

**Tests:** A-01…A-13, the AI-path P tests, fault injection F-01…F-06, S-10, and relevance EV-01…EV-09 (A-14/A-15 belong to Mode B in M13).

**Manual:** one live call per persona with a real key (a small spend); review the copy quality.

**Dependencies:** M6.

### M9 — Dashboard foundation: shell, auth, offers and rules editor [Phase 5]

**Scope**
- `client/` Vite + React + TS + Tailwind + Motion + Lucide.
- Design tokens, layout, navigation, login.
- Offers list and form (shared zod schema).
- Plain-language rules editor with version history.
- Synthetic-data banner; loading, empty and error states.

**Acceptance criteria**
- A non-technical user can pause an offer and change "max discount" with no help (hallway test).
- Validation errors appear inline.
- Keyboard accessible.
- Responsive at 375 px.

**Tests:** RTL (FE-01…FE-10), build passes.

**Manual:** hallway usability test with a classmate.

**Dependencies:** M4 (API). Can run in parallel with M7 and M8.

### M10 — Dashboard: customers, decision log, deliveries and analytics [Phase 5/6]

**Scope**
- Customer list and detail.
- Decision log with a plain-language explanation and an AI/fallback badge.
- Deliveries view.
- Analytics endpoints and charts with Observed / Simulated / Experimental badges.

**Acceptance criteria**
- Every number comes from the API.
- Badges are shown.
- Empty states appear when there's no data.

**Tests:** analytics aggregation integration tests (AN-01…AN-06); FE-11…FE-16.

**Dependencies:** M6–M9.

### M11 — Event triggers and real-time behaviour [Phase 6]

**Scope**
- Event ingestion API.
- Trigger detection (cart abandonment, inactivity, points expiring, frequency drop).
- Scheduler jobs.
- Bot "simulate shopping" actions.

**Acceptance criteria**
- Each trigger fires once per idempotency window.
- Re-evaluation respects the cap.
- No duplicate sends.

**Tests:** T-01…T-10.

**Manual:** in the bot, simulate add-to-cart then leave, and receive a cart offer within the configured delay.

**Dependencies:** M7.

### M12 — Deployment and hardening [Phase 7]

**Scope**
- Webhook mode with secret verification.
- Rate limits, helmet, CORS.
- Production build serving the SPA.
- Always-on hosting (**the user must approve the host**).
- Atlas network config.
- Final secret scan.

**Acceptance criteria**
- The bot responds on the deployed URL.
- Health is green.
- The bot survives a restart without losing links.
- `/api/*` requires auth.

**Tests:** S-01…S-12 security tests.

**Manual:** a fresh-clone README walkthrough, and a test with several classmates.

**Dependencies:** M7 (at minimum); ideally M8–M11.

### M13 — Optional enhancements (only after M1–M12 are green) [§4.2 of the plan]

These are **optional** and can be done in any order:
- holdout experiment and simulated population conversions;
- rule impact preview;
- agent Mode B tool loop;
- email channel;
- A/B copy variants;
- CSV export;
- Hindi/Punjabi copy.

Each needs its own acceptance tests.

**Minimum viable submission:** M1–M8 + M9 (basic) + M12. M10 and M11 are strongly recommended for the judging criteria.

---

## 11. Assumptions and open decisions

| # | Item | Current assumption | Needs user decision? |
|---|---|---|---|
| A1 | Classmate ↔ profile linking | The classmate picks a persona and gets an unlinked synthetic customer of that persona | Confirm (PROJECT_PLAN §9 Q1) |
| A2 | Hosting | Always-on host TBD; webhook in production | **Yes**, before M12 (§9 Q2) |
| A3 | AI personalisation scope | The AI chooses the offer and writes wording only. **Commercial terms are fixed per offer** (no AI-chosen discount values). This narrows PROJECT_PLAN §5 step 5 ("value") for safety; parameter tiers could be added later as distinct offers. | Confirm |
| A4 | Redemption | There is no store [PDF], so redemption is **simulated**: a bot button or admin API with a synthetic basket, labelled as a simulation | Confirm |
| A5 | Email | Optional, test inbox only, after the core | No |
| A6 | Transactions | Not used; atomic single-document updates + compensation | No (revisit if a requirement appears) |
| A7 | Timezone | `Asia/Kolkata` for quiet hours and display | No |
| A8 | Segments | Thresholds live in the rule set (editable as params); a dedicated `segmentDefinitions` collection comes later | No |
| A9 | Product domain | General marketplace (electronics, fashion, grocery, home, beauty) | Confirm (§9 Q5) |
