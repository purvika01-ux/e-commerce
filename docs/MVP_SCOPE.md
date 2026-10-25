# Offerly AI — MVP Scope (90-minute build)

> A time-boxed slice of `docs/ARCHITECTURE.md` (M1–M8 core plus a minimal M9/M10 dashboard).
> The guardrails in `CLAUDE.md` §4 apply in full. Anything deferred is listed in §4 and is **not** claimed as done.

## 1. Environment found at inspection

| Item | Status |
|---|---|
| Node / npm | v24.13.0 / 11.6.2 |
| MongoDB | Local `mongod` 8.2 running on `127.0.0.1:27017` (Windows service). It is a standalone server, so there are no transactions; the design already avoids them. |
| Credentials | No `ANTHROPIC_API_KEY` or `TELEGRAM_BOT_TOKEN` configured for the app |
| Repo | Only `CLAUDE.md` and `docs/` exist; no code yet |

**Consequences:**
- AI runs in **fallback mode** until a key is added. All AI behaviour is tested with mocked clients.
- The Telegram bot starts only when a token is present. Delivery is tested with a mocked sender.
- The startup log explains how to configure both.

## 2. Minimum scope

### Synthetic data
- A seeded, reproducible generator (`npm run seed`) creating about 120 customers across 8 personas.
- 180 days of sessions, product views, cart adds, orders, returns and points.
- Features (RFM, churn risk, purchase probability, discount sensitivity, return rate, open cart) and a segment are derived from those events.

### Offers and rules
These are stored in MongoDB, separately from AI wording:
- **7 offers**:
  - 5 usable, with different eligibility: win-back, cart recovery, welcome, free shipping, loyalty points;
  - 1 expired;
  - 1 draft over the discount cap.
- **One versioned rule set** of 11 structured rules.

Offer status can be changed from the dashboard and API, and rule parameters edited through the API and UI. Default definitions live in `server/src/data/catalog.ts`.

### Pipeline
1. Idempotent trigger.
2. Per-customer lease.
3. Context.
4. Deterministic eligibility.
5. Claude (structured output, eligible candidates only).
6. Strict schema check.
7. Independent validator.
8. One AI retry with the violations.
9. Deterministic fallback, validated the same way.
10. Atomic budget and usage reservation.
11. Persisted decision with audit trail and offer snapshot.

### Delivery
- The delivery service accepts only `approved` decision ids and rechecks offer status, expiry, version, rules and opt-out before sending.
- Delivery is idempotent per decision (unique key). Telegram errors are classified, and every attempt is recorded.
- A failed recheck cancels the decision and releases its reservation.

### Telegram bot
Uses grammY with long polling:
- `/start` with a persona picker that links the chat to an unused synthetic customer (stores only the chat id and first name);
- `/offer`, `/myoffers`, `/profile`, `/stop`, `/help`;
- Claim and Not-interested buttons, with an ownership check.

### API
Localhost only, no auth in the MVP. Endpoints:
- health and overview;
- customers (list and detail with an eligibility preview);
- offers (list and status change);
- rules (get and update);
- recommendations (requires an `Idempotency-Key`);
- decisions (list and detail);
- deliveries.

### Dashboard
React + Vite + Tailwind + Motion + Lucide:
- Overview;
- Customers: select a customer, see the recommendation preview, then decide or send;
- Offers with eligibility details;
- Rules;
- Decision log, including validation status, path badge and deliveries.

Every view has loading, empty and error states, and every page shows a synthetic-data banner.

## 3. Acceptance criteria (definition of done)

1. `GET /api/health` reports that the DB is connected.
2. Seeding produces the same data for the same seed.
3. For a selected customer, the dashboard can **preview** a decision (no reservation, no send) and **decide** one. The result shows the path (AI / AI retry / fallback), the offer, the copy, the terms, the validation status and any violations.
4. The required tests pass, using mocked Claude and Telegram:
   - eligible offer approved;
   - ineligible or expired offer rejected;
   - fabricated offer id rejected;
   - discount or budget limit violated;
   - malformed AI response;
   - Claude API failure with safe fallback;
   - validator failure prevents Telegram delivery;
   - duplicate request sends no duplicate offers.
5. `tsc` passes and both the client and server builds succeed.
6. With a bot token, `/start` → persona → `/offer` delivers a validated offer in Telegram, and the delivery appears in the dashboard. This **needs a manual check by the user**, because no token is available now.

## 4. Deferred (not in this MVP)

- Admin authentication. The server binds to `127.0.0.1` only. This must be added before public deployment.
- Rate limiting and webhook mode.
- Redemption (simulated checkout).
- ~~Grant expiry sweep and the reconciler.~~ Added after the MVP (reliability step 1, see README "Health and maintenance").
- Quiet hours and daily send cap.
- Event ingestion API and scheduler triggers (cart abandonment, inactivity).
- Email.
- The agent tool loop (Mode B).
- Analytics suite, holdout.
- Frontend unit tests.

**Test database:** tests use the **local mongod with a throwaway database per test file**, instead of `mongodb-memory-server` (TESTING.md [REC]). This avoids downloading a second MongoDB binary.

## 5. 90-minute sequence

| # | Minutes | Step |
|---|---|---|
| 1 | 0–10 | Scope doc; server scaffold: config (zod), logger with redaction, Mongo, health |
| 2 | 10–25 | Domain schemas and models; synthetic generator, catalog and seed |
| 3 | 25–40 | Eligibility, validator, copy policy, fallback, renderer |
| 4 | 40–50 | Claude adapter (structured output) + mock; orchestrator with lease, reservation and audit |
| 5 | 50–60 | Delivery service, Telegram sender, bot; API routes |
| 6 | 60–70 | Tests for the 8 required scenarios and the API; typecheck |
| 7 | 70–85 | Dashboard (overview, customers, offers, rules, decisions); build |
| 8 | 85–90 | Seed + run the server + smoke test through the API; report |
