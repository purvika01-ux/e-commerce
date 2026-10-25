# Offerly AI — Personalised Offer Engine

Hackathon 2 (Punjab Jobs AI Bootcamp · J-PAL South Asia).

Offerly AI decides which offer each customer of an e-commerce platform should receive, and delivers it to classmates through a Telegram bot.

- **Synthetic customers:** a reproducible generator creates realistic customer data.
- **Rules:** deterministic business rules set the limits for every offer.
- **AI choice:** Claude chooses and personalises an offer **only from the offers the rules allow**.
- **Validation:** an independent validator checks every decision before anything is sent.

> All customer data is synthetic. No real purchases or discounts exist.

## How a decision is made

```
trigger (dashboard / Telegram /offer)
  → idempotency check + per-customer lock
  → load synthetic profile, current offers, current rules
  → deterministic eligibility filter        (AI never sees ineligible offers)
  → Claude proposes {offerId, wording}      (structured output, untrusted)
  → strict schema check + independent validator   (one retry with the violations)
  → deterministic fallback if Claude fails  (validated the same way)
  → atomic budget/usage reservation in MongoDB
  → approved decision saved with full audit trail and offer snapshot
  → delivery service re-checks rules/expiry/opt-out, then sends via Telegram
```

The AI writes **wording only**. Prices, percentages, expiry and the code in the message are rendered from the approved offer definition, so the AI cannot change what is promised. Design details are in `docs/ARCHITECTURE.md`, and the MVP scope is in `docs/MVP_SCOPE.md`.

## Requirements

- Node.js 24 (the only version tested)
- MongoDB: a local `mongod` on `127.0.0.1:27017`, or an Atlas connection string
- Optional: an Anthropic API key and a Telegram bot token. Without them the app still runs. Decisions use the validated rule-based fallback, and Telegram is disabled.

## Setup

```bash
cd server
npm install
cp .env.example .env        # then edit .env
npm run seed                # 120 synthetic customers, 7 offers, rule set v1
```

```bash
cd client
npm install
npm run build               # the server serves client/dist
```

```bash
cd server
npm start                   # http://127.0.0.1:4000
```

For UI development with hot reload, run `npm run dev` in `client/` (http://localhost:5173, which proxies `/api` to port 4000).

### Configuration (`server/.env`)

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `ANTHROPIC_API_KEY` | Claude API key from console.anthropic.com. This is separate from Claude Code. Leave it empty for fallback-only mode. |
| `CLAUDE_MODEL` | Default `claude-opus-5-5` |
| `AI_MODE` | `auto` (live when a key is set), `off` |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_MODE` | `auto` (long polling when a token is set), `off` |
| `HOST` / `PORT` | Default `127.0.0.1:4000`. The MVP has **no admin login**, so keep it on localhost. |

Never commit `server/.env`; it is git-ignored. If a token leaks, revoke it: use `/revoke` in BotFather, or rotate the key in the Anthropic console.

## Telegram setup

1. In Telegram, message **@BotFather** → `/newbot`. Copy the token into `TELEGRAM_BOT_TOKEN`.
2. Restart the server. The log shows `telegram bot polling`, and the dashboard sidebar shows the bot's @username.
3. Share `https://t.me/<your_bot_username>` with classmates. A bot can only message people who have pressed **Start**.

### Bot commands

| Command | What it does |
|---|---|
| `/start` | Pick a shopper persona; you are linked to an unused synthetic customer |
| `/offer` | Get a personalised, validated offer |
| `/myoffers` | Offers you currently hold |
| `/profile` | Your synthetic shopper profile |
| `/stop` | Opt out of offers |
| `/help` | List the commands |

Offer messages have **Claim** and **Not interested** buttons. Only the chat id and first name are stored.

## Using the dashboard

| Page | What you can do |
|---|---|
| **Overview** | KPIs, recent decisions, segments and offer budgets |
| **Customers** | Pick a synthetic shopper, see their behaviour and which offers the rules allow (and why others are excluded), then act on them (see below) |
| **Offers** | Terms, eligibility, validity and budget; pause or activate. Activation is refused if the offer breaks the current rules. |
| **Rules** | Edit limits in plain language; every save creates a new version |
| **Decision log** | Full audit per decision: candidates, AI attempts, validation history, delivery |

On the **Customers** page, the three actions are:

- **Preview**: runs the full pipeline with nothing reserved or sent.
- **Decide (no send)**: makes a real decision without delivering it.
- **Decide & send**: decides and delivers through Telegram, for linked customers only.

## Health and maintenance

`GET /api/health` returns:

- `ok`, `degraded` or HTTP 503 (database down);
- the bot's polling status (`polling`, `failed` with the reason, and when it will retry);
- the last maintenance run.

If polling fails fatally, for example a Telegram 409 because another process is polling the same token, or a revoked token, the error is logged. The API keeps running, and polling is retried with backoff (30 s, doubling, up to 10 min).

A maintenance job runs every minute:

| Job | What it does |
|---|---|
| Expiry | Marks lapsed grants `expired` and returns their reserved budget, exactly once |
| Recovery | Closes work interrupted by a crash: decisions stuck in `pending`, triggers stuck in `processing`, and deliveries stuck in `sending` for 10+ minutes. A stuck delivery is voided rather than resent, so a possible missing message is preferred over a duplicate. |
| Reconciler | Recomputes each offer's budget and usage counters from its decisions, and repairs drift with a compare-and-set update. It skips any offer with a decision in flight. |

## Tests

```bash
cd server
npm test            # vitest: unit, pipeline and API tests (needs local mongod)
npm run typecheck
```

- **Isolation:** each test file uses its own throwaway database on the local mongod, then drops it. Set `MONGODB_TEST_URI` to use another server.
- **Mocks:** Claude and Telegram are always mocked in tests. The real clients refuse to start under `NODE_ENV=test`.
- **Coverage:** see `docs/TESTING.md` for the full planned matrix.

## Project layout

```
server/src
  data/        synthetic generator, default offers & rules (catalog.ts), seed CLI
  features/    behavioural features + segmentation
  domain/      types, rule catalogue, AI proposal schema
  rules/       eligibility filter, independent validator, copy policy, fallback
  ai/          Claude adapter (structured output), prompt, permitted context
  decision/    orchestrator, atomic budget ledger
  delivery/    message renderer, Telegram sender, delivery service
  bot/         Telegram bot + chat ↔ synthetic customer linking
  routes/      REST API
client/src     React dashboard (Tailwind, Motion, Lucide)
docs/          plan, architecture, API spec, testing, MVP scope
```
