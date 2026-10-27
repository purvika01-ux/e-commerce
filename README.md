# Offerly AI — Personalised Offer Engine

Hackathon 2 (Punjab Jobs AI Bootcamp · J-PAL South Asia).

Offerly AI decides which offer each customer of an e-commerce platform should receive, and delivers it to classmates through a Telegram bot.

- **Synthetic customers:** a reproducible generator creates realistic customer data.
- **Rules:** deterministic business rules set the limits for every offer.
- **AI choice:** Claude chooses and personalises an offer **only from the offers the rules allow**.
- **Validation:** an independent validator checks every decision before anything is sent.

> All customer data is synthetic. No real purchases or discounts exist.

## Submission

| Item | Value |
|---|---|
| Telegram bot | **[@SmartOffersAI_Bot](https://t.me/SmartOffersAI_Bot)** |
| Repository | `github.com/purvika01-ux/e-commerce` (this repo) |
| Dashboard | **[e-commerce-gx9q.onrender.com](https://e-commerce-gx9q.onrender.com/)**, hosted on Render. Sign-in is required; evaluators get the login privately. Locally it runs at `http://127.0.0.1:4000` with `npm start` (or the port set by `PORT`, see [Setup](#setup)), or `http://localhost:5173` in dev mode. |
| Test data | Built in: 120 synthetic customers, 7 offers and rule set v1 (`npm run seed`). Nothing to upload. |
| Project instructions | [`CLAUDE.md`](CLAUDE.md) |

**Try it in Telegram:**
1. Open the bot and press **Start**.
2. Pick a shopper persona; you're linked to a synthetic customer.
3. Send **/offer**. You get a personalised offer that has passed the business rules. Its terms come from the offer definition, and its wording from Claude, or from the rule-based fallback if Claude is unavailable.
4. Tap **Claim** or **Not interested**. `/myoffers` lists offers you hold; `/stop` opts out.

**In the dashboard:** every decision appears in the **Decision log**, with the candidates, the AI's attempts, each validation run and the delivery result. **Campaign results** shows what happened next: deliveries, claims, budget and why offers were withheld.

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

`npm run seed` replaces all data. It refuses to run while Telegram chats are linked, unless you add `--force` (which also removes those links).

```bash
cd client
npm install
npm run build               # the server serves client/dist
```

```bash
cd server
npm start                   # http://127.0.0.1:4000
```

For UI development with hot reload, run `npm run dev` in `server/` and, in a second terminal, `npm run dev` in `client/`. Then open http://localhost:5173, which proxies `/api` to the server.

**If port 4000 is already in use** (for example by another project), set a free port such as `PORT=4001` in `server/.env` and restart the server. `npm start` then serves on that port. The dev proxy reads `PORT` from `server/.env`, so it follows automatically.

### Configuration (`server/.env`)

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `ANTHROPIC_API_KEY` | Claude API key from console.anthropic.com. This is separate from Claude Code. Leave it empty for fallback-only mode. |
| `CLAUDE_MODEL` | Default `claude-opus-5-5` |
| `AI_MODE` | `auto` (live when a key is set), `off` |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_MODE` | `auto` (long polling when a token is set), `off` |
| `HOST` / `PORT` | Default `127.0.0.1:4000`. The dashboard's dev proxy follows `PORT`. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` | Admin login (see below). **Required** when `NODE_ENV=production` or `HOST` isn't localhost. |
| `SESSION_TTL_HOURS` | Sign-in lifetime, default 8 |
| `NODE_ENV` | `production` adds the Secure cookie flag and HSTS, and requires the admin login |
| `TRUST_PROXY` | Set `true` behind a hosting proxy, so rate limits see real client IPs |

Never commit `server/.env`; it is git-ignored. If a token leaks, revoke it: use `/revoke` in BotFather, or rotate the key in the Anthropic console.

### Admin login

```bash
npm --prefix server run setup-admin
```

The script asks for a password (at least 12 characters) without displaying it. It prints `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and a random `SESSION_SECRET`; paste those into `server/.env`, or your host's environment settings, and restart.

- **The password itself is never stored**, only its scrypt hash.
- **There's no default password.** Without these values, the server runs **with no login**, but only on localhost in development. It refuses to start in production or on a public `HOST`.
- **Changing `SESSION_SECRET` signs everyone out.**

**Who needs a login:**

| Route | Access |
|---|---|
| `GET /api/health` | Public: status only, no business data |
| `/api/auth/*` | Login, logout, session check |
| Every other `/api` route | Signed-in admin |
| Rule changes, offer status changes, recommendations (which reserve budget and can trigger Telegram delivery) | Signed-in admin **and** the CSRF checks |
| Telegram bot | **Separate from admin login.** Customers are identified by their Telegram chat, never by the dashboard login. |

**How sessions work:**
- **Server-side storage.** The browser holds only a random 256-bit token, in an `HttpOnly; SameSite=Strict` cookie. In production it's `Secure` with the `__Host-` prefix. MongoDB (`adminsessions` collection) stores only a keyed hash of the token. MongoDB deletes expired sessions automatically.
- **Expiry.** Sessions end after **60 minutes idle** (`SESSION_IDLE_MINUTES`) or **8 hours in total** (`SESSION_TTL_HOURS`), whichever comes first.
- **Sign-out** deletes the session on the server, so a copied cookie stops working at once.
- **Each sign-in issues a new token.**

**Passwords:** scrypt with N=2¹⁷, r=8, p=1 (the OWASP-recommended cost), run asynchronously and one at a time, so it can't block the bot or exhaust memory. Hashes made by older versions of `setup-admin` still work; re-run it to upgrade.

**Blocking cross-site requests (CSRF):** every change request needs the `X-Requested-With: offerly` header, which the dashboard sends automatically. Requests whose `Origin` or `Sec-Fetch-Site` shows they come from another site are refused.

**Responses:**

| Code | Meaning |
|---|---|
| `401` | Not signed in, or the session expired or was revoked |
| `403` | Blocked by the CSRF check |
| `429` | Too many attempts |

Errors never include stack traces or credentials, and a wrong username gets the same answer as a wrong password.

**Rate limits** (per process):

| What | Limit |
|---|---|
| Login | 5 attempts per minute per IP, **and** a lock on any username after 10 failures in 15 minutes |
| Recommendations | 30 per minute per admin |
| All API calls | 300 per minute per IP |
| Telegram `/offer` | 1 per 10 seconds per chat |

**Security headers:** Content-Security-Policy, nosniff, frame denial and referrer policy, plus HSTS in production.

**Not covered:**
- one admin account only, with no roles;
- login rate limits and lockouts are kept in memory, so they assume a single server instance and reset on restart;
- Telegram webhook mode isn't implemented (long polling only).

**Upgrading from the earlier login:** everyone signs in once more. No variables need changing. A new `adminsessions` collection is created automatically.

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
| **Overview** | KPIs for the last 7, 30 or 90 days or all time, daily decision outcomes, segments, recent decisions and offer budgets |
| **Campaign results** | Results of the decisions made in a period, filtered by date range (or custom dates), segment, offer and source. See below. |
| **Customers** | Search, filter and sort synthetic shoppers. Open one to see their behaviour and which offers the rules allow (and why others are excluded), then act on them (see below). |
| **Offers** | Create offers and edit their terms, eligibility, validity, budget and limits. Pause, activate or archive them, with a confirmation each time. See below. |
| **Business rules** | Edit limits in plain language with live previews. A review step shows old and new values and asks for a change note; every save creates a new version. |
| **Decision log** | Search, filter and sort every decision, then open its full audit: candidates, AI attempts, validation history, delivery and engagement |

**Campaign results** is computed on the server from stored records:
- a funnel from decisions to offers issued, delivered and claimed;
- Telegram delivery success, failures and automatic retries;
- claim rates by offer and by segment, with small samples flagged;
- budget reserved, released and still held;
- why offers were withheld or stopped.

Every figure covers the decisions made in the chosen period. Deliveries and taps that came later count toward the day of their decision. Generated figures (from the engine) are labelled separately from observed ones (Telegram results and classmates' taps). A claim is a button tap, not a purchase. Purchases, revenue and lift are listed as **not measured**, because the product has no checkout or holdout group, rather than being estimated.

**Creating and editing offers:**
- **New offer** opens a form with field-by-field validation. A new offer starts as a **draft**.
- A draft that breaks the current business rules is saved, but flagged, and it can't be activated until it's fixed.
- Editing a live offer asks for confirmation. Changing its terms, eligibility, validity, budget or limits creates a new version. Customers who already received the offer keep their original terms.
- A budget can't be lowered below what is already reserved or redeemed.

**Light and dark theme:** the sun / moon icon switches the whole dashboard, including the sign-in page, between light and dark. It sits in the sidebar on desktop and in the top bar on phones. The choice is remembered in the browser; the first visit follows the computer's light or dark setting.

On the **Customers** page, the three actions are:

- **Preview**: runs the full pipeline with nothing reserved or sent.
- **Decide (no send)**: makes a real decision without delivering it.
- **Decide & send**: decides and delivers through Telegram, for linked customers only.

## Deployment

The app runs as **one** continuously running Node service: API, dashboard and Telegram bot together. It's hosted on **Render** at https://e-commerce-gx9q.onrender.com/, with data in **MongoDB Atlas**. An uptime monitor requests `/api/health` every 5 minutes so the free instance doesn't sleep. A separate copy of the dashboard can also run on Vercel (`VITE_API_URL` on Vercel, `CORS_ORIGINS` on Render; see `docs/DEPLOYMENT.md` §9). Only one copy of the bot can run at a time, so don't run a local copy and a hosted copy with the same bot token together. The root `package.json` provides `build` (`npm run build`) and `start` (`npm start`); Node 24 is required.

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for:
- why it must be a single always-on process;
- the free-tier limits, including spin-down and how to keep the service awake;
- the dashboard steps for Atlas and Render;
- the health-check and rollback procedures.

## Health and maintenance

`GET /api/health` returns:

- `ok`, `degraded` or HTTP 503 (database down);
- the bot's polling status (`polling`, `failed` with the reason, and when it will retry);
- the last maintenance run.

If polling fails fatally, for example a Telegram 409 because another process is polling the same token, or a revoked token, the error is logged. The API keeps running, and polling is retried with backoff (30 s, doubling, up to 10 min). A 409 conflict, which is expected while an old and a new deploy overlap, is retried at least every 60 s. Startup retries the database connection 8 times with backoff before exiting. `/api/health` also reports the deployed commit (`release`) and uptime.

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
