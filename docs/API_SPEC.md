# Offerly AI — API Specification (v1, initial)

> Status: this was written as the **design contract before implementation**. The table below shows what is actually implemented (commit `08b828b` and later). Where the code and this document differ, the code and its tests are authoritative.

## Implementation status

| Endpoint | Status | Notes |
|---|---|---|
| `GET /api/health` | ✅ Implemented | Public. Adds `release`, `uptimeSec`, bot state and maintenance state. Returns 503 only when the database is down. |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | ✅ Implemented | **Server-side sessions** (MongoDB `adminsessions`), not the JWT design in §3. The cookie is `offerly_session`, or `__Host-offerly_session` in production. CSRF uses the `X-Requested-With: offerly` header plus an Origin / Sec-Fetch-Site check. |
| `GET /api/overview` | ✅ Implemented | Dashboard summary (not in the original design) |
| `GET /api/customers`, `GET /api/customers/:id` | ✅ Implemented | `:id` also returns the current eligibility preview |
| `POST /api/customers/:id/events` | ❌ Not implemented | Event triggers are still future work |
| `GET /api/offers`, `POST /api/offers/:id/status` | ✅ Implemented | Activate / pause / archive. Activation is refused if the offer breaks the current rules. |
| `POST /api/offers`, `PATCH /api/offers/:id` | ❌ Not implemented | Offers come from `server/src/data/catalog.ts` via the seed |
| `GET /api/rules`, `PUT /api/rules` | ✅ Implemented | `GET` includes plain-language descriptions and the last 10 versions |
| `GET /api/rules/catalog`, `/history`, `/versions/:version`, `/preview` | ❌ Not implemented | History is part of `GET /api/rules` |
| `POST /api/recommendations` | ✅ Implemented | `channel`: `none` or `telegram`; `dryRun` for a preview |
| `GET /api/decisions`, `GET /api/decisions/:id` | ✅ Implemented | |
| `GET /api/deliveries` | ✅ Implemented | Retry endpoint not implemented |
| `POST /api/redemptions`, `GET /api/engagement` | ❌ Not implemented | Claims and declines come from Telegram buttons; redemption isn't implemented |
| `/api/telegram/*` | ❌ Not implemented | Long polling only; no webhook |
| `/api/analytics/*` | ❌ Not implemented | Summary figures are in `GET /api/overview` |

**Auth on implemented routes:**
- Everything except `/api/health` and `/api/auth/*` needs a signed-in admin when login is configured.
- `PUT /api/rules`, `POST /api/offers/:id/status` and `POST /api/recommendations` also need the CSRF checks.
- Responses: `401` not signed in or session expired, `403` CSRF block, `429` rate limited. See README → Admin login.

---

## 1. Conventions

- **Base path:** `/api`. JSON only (`Content-Type: application/json`). Request body limit is 100 KB.
- **Validation:**
  - Every body, query and path parameter is checked with a **zod** schema. Unknown keys are rejected (`.strict()`).
  - Keys beginning with `$` and keys containing `.` are rejected.
  - ObjectIds must match `^[a-f0-9]{24}$`.
- **Money:** integer **paise** in the API (`…Paise`). The UI converts to and from rupees.
- **Times:** ISO-8601 UTC strings.
- **Authentication:**
  - **Admin:** a session cookie `offerly_session` (httpOnly, Secure in production, `SameSite=Strict`), issued by `POST /api/auth/login`.
  - **Mutations:** all mutating admin requests must also send `X-Requested-With: offerly` (CSRF defence).
  - Unless marked **public**, every endpoint requires an admin session.
- **Idempotency:** `POST /api/recommendations`, `POST /api/redemptions` and `POST /api/customers/:id/events` require an `Idempotency-Key` header (8–128 chars, `[A-Za-z0-9:_-]`). Replays return the original result with `"replayed": true`.
- **Correlation:** the client may send `X-Request-Id`. The server always returns it, and it appears in error bodies.
- **Pagination:** query `?page=1&pageSize=25`, with `pageSize` capped at 100. The response is `{ items: [...], page, pageSize, total }`.
- **Rate limits** (429 with a `Retry-After` header):

  | Endpoint | Limit |
  |---|---|
  | login | 5/min/IP |
  | recommendations | 30/min/session |
  | events | 60/min/session |
  | webhook | 120/min |
  | everything else | 300/min/session |

### 1.1 Standard error body

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Human-readable, safe message",
             "details": [{ "path": "terms.percentOff", "message": "Must be ≤ 90" }],
             "requestId": "b6f0…" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | zod failure, malformed JSON, unknown keys |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Header missing on an idempotent endpoint |
| 401 | `UNAUTHENTICATED` | No or expired session |
| 403 | `FORBIDDEN` | Missing CSRF header; bad webhook secret; production-disabled endpoint |
| 404 | `NOT_FOUND` | Unknown id or code |
| 409 | `CONFLICT` | Stale `expectedVersion`; illegal status transition; idempotency key reused with a **different** body |
| 409 | `CUSTOMER_BUSY` | A decision lease is held for this customer |
| 422 | `BUSINESS_RULE_VIOLATION` | e.g. redemption below min order, grant expired, grant already redeemed |
| 429 | `RATE_LIMITED` | Rate limit exceeded |
| 503 | `SERVICE_UNAVAILABLE` | DB unreachable (fail closed) |
| 500 | `INTERNAL` | Unexpected. Generic message; details are only in the server logs. |

Stack traces and secrets never appear in responses.

---

## 2. Health — **public**

### `GET /api/health`

The milestone M1 deliverable.

```json
200 { "status": "ok", "version": "0.1.0", "uptimeSec": 123,
      "db": { "status": "connected", "latencyMs": 4 },
      "bot": { "mode": "polling", "status": "running" },
      "ai": { "mode": "live" } }
503 { "status": "degraded", "db": { "status": "disconnected" }, ... }
```

- `bot` and `ai` are added once those milestones exist.
- The response never includes connection strings, tokens or model keys.

---

## 3. Auth

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/api/auth/login` (**public**) | `{ username: string(1..64), password: string(1..128) }` | `200 { user: { username, role: "admin" } }` + session cookie | 400, 401 (`INVALID_CREDENTIALS`, generic message: no user enumeration), 429 |
| POST | `/api/auth/logout` | — | `204` (clears the cookie) | 401 |
| GET | `/api/auth/me` | — | `200 { user }` | 401 |

---

## 4. Customers (synthetic)

### `GET /api/customers`

**Query:** `segment?`, `persona?`, `linked?` (bool), `q?` (externalRef or name prefix, ≤ 40 chars), and pagination.

```json
200 { "items": [ { "id", "externalRef", "displayName", "segment", "persona",
                   "features": { "recencyDays", "frequency90d", "monetary90dPaise", "churnRisk",
                                 "purchaseProbability7d", "discountSensitivity" },
                   "rewardPoints": { "balance" }, "telegramLinked": true, "dataOrigin": "seed" } ],
      "page": 1, "pageSize": 25, "total": 1000 }
```

### `GET /api/customers/:id`

```json
200 { "customer": { …full profile incl. features, contactState, openCart… },
      "recentEvents": [ { "type", "occurredAt", "payload" } ],       // last 50
      "recentDecisions": [ { "id", "status", "path", "offerCode", "createdAt" } ],  // last 10
      "activeGrants": [ { "code", "offerCode", "status", "expiresAt" } ] }
```

**Errors:** 400 (bad id), 404.

### `POST /api/customers/:id/events` — simulate a behavioural event (M11)

**Headers:** `Idempotency-Key`.

**Body:** a discriminated union on `type`, using the same schemas as `customerEvents.payload`:

```json
{ "type": "cart_add", "occurredAt": "2026-10-24T10:00:00Z",
  "payload": { "cartId": "c-123", "sku": "FSH-0042", "category": "fashion", "pricePaise": 129900 } }
```

**Behaviour:** appends the event (`dataOrigin: simulated`), recomputes features, and runs trigger detection.

```json
201 { "event": { "id", "type" }, "featuresUpdated": true,
      "triggers": [ { "id", "type", "status", "idempotencyKey" } ] }
```

**Errors:**
- 400: an `occurredAt` more than 5 minutes in the future is rejected; an unknown category is rejected.
- 404.
- 409: same key, different body.

---

## 5. Offers

**Offer DTO** (mirrors `ARCHITECTURE.md` §3.4):

```json
{ "id", "code": "WINBACK15", "name", "description", "status": "active", "version": 3,
  "type": "percent_off",
  "terms": { "percentOff": 15, "maxDiscountPaise": 30000, "minOrderPaise": 99900, "categories": ["fashion"] },
  "eligibility": { "segments": ["at_risk","hibernating"], "minChurnRisk": 0.5, "maxPurchaseProbability": 0.6 },
  "validFrom", "validTo", "grantValidityHours": 72, "priority": 70, "stackable": false,
  "estimatedCostPaise": 30000,
  "budget": { "totalPaise": 2000000, "reservedPaise": 120000, "redeemedPaise": 45000, "remainingPaise": 1835000 },
  "usage": { "maxGrants": 200, "grantsIssued": 12, "maxGrantsPerCustomer": 1, "redemptions": 3 },
  "isExpired": false, "createdAt", "updatedAt" }
```

| Method | Path | Body / query | Success | Errors / rules |
|---|---|---|---|---|
| GET | `/api/offers` | `status?`, `type?`, `includeExpired?`, pagination | `200 { items: Offer[] … }` | 400 |
| GET | `/api/offers/:id` | — | `200 { offer, recentDecisions: [...] }` | 404 |
| POST | `/api/offers` | `OfferCreate` (all of the above except id, version, counters, timestamps, `estimatedCostPaise`). Created as `status: draft`. | `201 { offer }` + audit log | 400 (type-specific terms: `percent_off` needs `percentOff` 1..90 and `maxDiscountPaise`; `flat_off` needs `flatOffPaise`; `bonus_points` needs `bonusPoints`; `validTo > validFrom`; `budget.totalPaise > 0`; terms must not already break the active rule set, e.g. `percentOff` > `MAX_DISCOUNT_PERCENT`, which gives `details`), 409 (duplicate `code`) |
| PATCH | `/api/offers/:id` | `{ expectedVersion: int, …partial OfferCreate }` | `200 { offer }`. `version` increments if terms, eligibility, validity or budget changed. | 400, 404, 409 (stale version; editing `archived`; lowering `budget.totalPaise` below `reserved + redeemed`) |
| POST | `/api/offers/:id/status` | `{ action: "activate"\|"pause"\|"archive", expectedVersion }` | `200 { offer }` | 409 for illegal transitions. Allowed: `draft→active`, `active→paused`, `paused→active`, `*→archived`. Activation is refused if `validTo ≤ now` or the terms break current rules (422 `BUSINESS_RULE_VIOLATION` with details). |

There is no `DELETE`: offers that have decisions are archived instead [ARCHITECTURE §3.4]. `GET /api/offers/:id/versions` is **(later)**.

---

## 6. Rules

**RuleSet DTO:**

```json
{ "version": 7, "active": true, "createdAt", "createdBy", "changeNote",
  "rules": [ { "key": "max_discount_percent", "type": "MAX_DISCOUNT_PERCENT", "enabled": true,
               "params": { "maxPercent": 25 },
               "description": "No offer may give more than 25% off" } ],
  "segmentation": { … } }
```

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/api/rules` | — | `200 { ruleSet }` (active) | — |
| GET | `/api/rules/catalog` | — | `200 { types: [{ type, label, paramsSchema (JSON Schema from zod), defaults, helpText }] }`. Drives the UI form generation. | — |
| GET | `/api/rules/history` | pagination | `200 { items: [{ version, createdAt, createdBy, changeNote }] … }` | — |
| GET | `/api/rules/versions/:version` | — | `200 { ruleSet }` | 404 |
| PUT | `/api/rules` | `{ expectedVersion: int, changeNote: string(1..200), rules: Rule[], segmentation }` | `201 { ruleSet }` (a new active version) + audit log | 400 (unknown `type`; params fail that type's schema; duplicate `key`; `QUIET_HOURS` hours outside 0–23); 409 (stale `expectedVersion`); 422 (removing or disabling an **always-on** safety check is impossible because those aren't in the editable list, so such attempts get 400) |
| POST | `/api/rules/preview` **(later, M13)** | `{ rules, segmentation }` | `200 { eligibleCustomersByOffer, deltaVsActive, estimatedCostDeltaPaise }` | 400 |

**[REC]** Rollback is done by `PUT` with the old version's rules, so there is no separate endpoint.

---

## 7. Recommendations and decisions

### `POST /api/recommendations`

Runs the decision pipeline (`ARCHITECTURE.md` §5) for a customer.

**Headers:** `Idempotency-Key` (becomes the trigger key, prefixed `api:`).

**Body:**

```json
{ "customerId": "…", "triggerType": "manual",
  "channel": "telegram" | "none",           // "none" = decide only (no delivery)
  "dryRun": false }                          // true: run steps 2–7 only; no reservation, no grant, no send; decision stored with status "dry_run" [REC]
```

**Responses:**

```json
201 { "decision": DecisionSummary, "delivery": { "id", "status" } | null, "replayed": false }
200 { …same…, "replayed": true }            // same key and body seen before
```

**`DecisionSummary`:**

```json
{ "id", "triggerId", "customerId", "status": "approved",
  "path": "ai" | "ai_retry" | "fallback" | "none",
  "offer": { "id", "code", "version", "type", "terms" } | null,
  "copy": { "headline", "body" } | null,
  "renderedPreview": "🎁 …",              // exactly what would be or was sent
  "rationale": "…",                         // display only
  "validation": { "ok": true, "violations": [] },
  "grant": { "code", "status", "expiresAt" } | null,
  "excludedCount": 4, "createdAt" }
```

**Errors:**

| HTTP | When |
|---|---|
| 400 | Validation failure |
| 404 | Customer not found |
| 409 | `CUSTOMER_BUSY`; key reused with a different body |
| 422 | `channel: "telegram"` but the customer is not linked or is opted out (`NOT_DELIVERABLE`). This is checked during request validation, **before** a trigger is created, so nothing is written. The client may retry with `channel: "none"`. |
| 503 | DB unavailable |

`no_offer` and `rejected` are **successful** pipeline outcomes (201) with `status` set accordingly. They are not errors.

### `GET /api/decisions`

**Query:** `status?`, `path?`, `customerId?`, `offerId?`, `from?`, `to?`, pagination.

**Returns:** `DecisionSummary[]`.

### `GET /api/decisions/:id`

**Returns** the full audit record:
- `contextSnapshot`, `candidates`, `excluded` (with reasons and plain-language text);
- `ai.attempts` (outcome, latency, model, token usage; raw output truncated);
- `proposal`, `validationHistory`, `offerSnapshot`, `reservation`, `grant`, `deliveries`, `engagementEvents`.

**Errors:** 404.

---

## 8. Deliveries

| Method | Path | Notes |
|---|---|---|
| GET | `/api/deliveries` | Query: `status?`, `channel?`, `decisionId?`, `from?`, `to?`, pagination. Item: `{ id, decisionId, customerRef, channel, status, attempts:[{at, outcome, errorCode}], providerMessageId?, createdAt }`. Message text is not returned here; it is in the decision. |
| POST | `/api/deliveries/:id/retry` | Only for `failed_retryable`. It runs the **full pre-send recheck and validator again** before sending. Returns `200 { delivery }`. **Errors:** 404; 409 (status not retryable); 422 (recheck failed, so the decision is cancelled and the delivery becomes `cancelled_precheck`). |

There is no "send arbitrary message" endpoint, by design [CLAUDE.md].

---

## 9. Redemptions and engagement

### `POST /api/redemptions` — simulated checkout (there is no store [PDF])

**Headers:** `Idempotency-Key`.

**Body:** `{ "grantCode": "OFR-7KQ2-M9", "orderValuePaise": 159900, "categories": ["fashion"] }`

**Checks, in order:**
1. The grant exists.
2. It belongs to a customer.
3. Its status is `issued` or `claimed`.
4. It has not expired.
5. `orderValuePaise ≥ offerSnapshot.terms.minOrderPaise`.
6. The category matches, if restricted.

The discount is computed **from `offerSnapshot`** (never from the current offer). The grant transition is atomic.

```json
201 { "redemption": { "grantCode", "discountPaise": 23985, "orderValuePaise": 159900,
                      "dataOrigin": "simulated" }, "replayed": false }
```

**Errors:**
- 404: unknown code.
- 422 `BUSINESS_RULE_VIOLATION`, with `details.reason` one of `GRANT_EXPIRED`, `GRANT_ALREADY_REDEEMED`, `GRANT_VOID`, `BELOW_MIN_ORDER`, `CATEGORY_MISMATCH`.
- 409: key reused with a different body.

The bot's "🧾 Redeem (simulated)" button calls the same service internally, with a synthetic basket and the key `redeem:{grantCode}`.

### `GET /api/engagement`

**Query:** `type?`, `decisionId?`, `from?`, `to?`, pagination.

**Returns** engagement events with `dataOrigin`.

---

## 10. Telegram

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/telegram/webhook` | **Public**, but requires the header `X-Telegram-Bot-Api-Secret-Token` to equal `TELEGRAM_WEBHOOK_SECRET` (constant-time compare). 403 otherwise. | Production mode only. The update body is parsed by a zod schema for the subset we handle; unknown update types → `200` and ignored. Always returns `200` quickly once accepted, because Telegram retries non-2xx. Processing errors are logged, not surfaced. |
| GET | `/api/telegram/links` | Admin | Query: `status?`, pagination. Item: `{ id, customerRef, personaChoice, status, firstName?, linkedAt, lastInteractionAt }`. **`chatId` is masked** (last 3 digits). |
| POST | `/api/telegram/links/:id/unlink` | Admin | Sets `unlinked` and opts the customer out. `200 { link }`. Audit-logged. |
| GET | `/api/telegram/status` | Admin | `{ mode, botUsername, running, linkedCount }`. Never returns the token. |

Bot commands (`/start`, `/offer`, `/myoffers`, `/profile`, `/stop`, `/help`) and callbacks are internal to the bot adapter, not REST endpoints. They are specified in `ARCHITECTURE.md` §7.1.

---

## 11. Analytics

Every metric object carries `{ value, origin: "observed"|"simulated"|"experimental", n }`. Responses accept `from?`, `to?`, and `origin?` (filter).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/analytics/summary` | Funnel counts (triggers, decisions by status, sent, claimed, redeemed), AI vs fallback share, validator rejections, discount cost (reserved and redeemed), delivery success rate |
| GET | `/api/analytics/by-segment` | Per segment: decisions, approval rate, claim and redemption rates, average discount |
| GET | `/api/analytics/by-offer` | Per offer: grants, budget used / remaining, redemptions, cost per redemption |
| GET | `/api/analytics/validation` | Violations by rule key and by path (AI vs fallback) over time |
| GET | `/api/analytics/relevance` **(M10/M13)** | Relevance rubric pass rate by persona and path (`TESTING.md` §9). `origin: simulated`. |
| GET | `/api/analytics/experiment/:key` **(later, M13)** | Treated vs holdout conversion, n, and a difference with a "directional only" note |

---

## 12. Not exposed (intentionally)

| Not exposed | Instead |
|---|---|
| Seeding / reset | CLI only (`npm run seed`); never an HTTP endpoint |
| Free-text "send message" | Delivery only takes approved decisions |
| Approving or editing a decision manually | Decisions are produced only by the pipeline |
| Any endpoint that exposes secrets, raw prompts or full chat IDs | — |
| Email endpoints | **(later)** — the email channel is configured through env only, and its delivery appears in `/api/deliveries` with `channel: "email"` |
