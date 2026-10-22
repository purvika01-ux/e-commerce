# Offerly AI — Personalised Offer Engine: Project Plan

> Source of truth: `Hackathon_2_Brief.pdf` (Punjab Jobs AI Bootcamp · J-PAL South Asia · Hackathon 2, individual project).
> Status: **planning only — no application code written yet. Waiting for approval before implementation.**

Throughout this document, items are labelled:

- **[PDF]** — stated explicitly in the brief.
- **[YOU]** — a constraint you set (tech stack, Claude API, etc.), not in the brief.
- **[REC]** — my recommendation. Optional unless you approve it.
- **[ASSUMPTION]** — the brief doesn't settle this, so I picked a reading.

---

## 0. Notes on reading the brief

- In the PDF's timeline table, the columns came out misaligned in the text layer. Matching them up in order gives:

  | When | What |
  |---|---|
  | During class (120 min) | Start building your system |
  | **Tuesday 27 October, 12:00 noon** | **Submit your work** |
  | Next session | The winners present their solutions |

  **[ASSUMPTION]** The submission deadline is **Tuesday 27 Oct 2026, 12:00 noon**. Today is Thursday 22 Oct, so about 5 days remain. The bot has to keep running **past** the deadline, through the "next session" when judging and presentations happen.
- The brief deliberately leaves the system design open: *"Figuring out what the system needs to do is part of the assignment."* So the specific segments, rules and metrics below are my proposals. The brief does not prescribe them.

---

## 1. The problem in simple language

Online shops send discount offers to their customers. Some offers pay off. For example, a 15% coupon can win back a customer who was about to stop shopping. Others waste money, like sending that same coupon to someone who would have bought anyway. That is "lost margin".

A shop knows things about each customer: what they bought, what they browsed, what is sitting in their cart, and how many reward points they hold. The aim is to use that information to decide **who gets which offer, and when**.

The task is to build a system that:

1. **Makes up realistic (fake) customer data**, because there is no real store.
2. Lets the business set **rules**: the hard limits every offer must respect.
3. Uses an **AI agent** to pick the best offer for each customer and personalise it, but only inside those limits.
4. **Checks every AI decision against the rules** before anything is sent.
5. **Sends the offers to your classmates through a Telegram bot.**
6. Shows **whether the offers are working**.

There is no shop website to build. The product is the decision engine, the rules, the bot, and the results.

---

## 2. Requirements extracted from the PDF

### 2.1 Explicit functional requirements [PDF]

| # | Requirement | Brief wording (paraphrased or short quote) |
|---|---|---|
| F1 | Decide **which offer each customer** of an e-commerce platform should receive | "Build a system that decides which offer each customer … should receive" |
| F2 | **Deliver offers to classmates through a Telegram bot** | "delivers those offers to your classmates through a Telegram bot" |
| F3 | **Generate realistic customer data** as part of the work | "You will need realistic customer data, so generating it is part of the work" |
| F4 | **Rules you design** set the limits for every offer | "Rules you design set the limits for every offer" |
| F5 | An **AI agent may choose and personalise** offers **in real time** within those limits | "an AI agent may choose and personalise offers in real time within those limits" |
| F6 | **Every AI choice must be checked against the rules before it is sent** | "every AI choice must be checked against your rules before it is sent" |
| F7 | **No store to build** | "There is no store to build" (so building a storefront is out of scope) |
| F8 | Know **whether the offers work** | "…and how you would know whether your offers work" (listed as something to work out) |

Things the brief asks you to *work out* (open design questions, not fixed specs): what data a real platform collects, how customers differ, which offer suits whom, what limits a business would set, and how you would measure offer success.

### 2.2 Process requirements ("How you work") [PDF]

| # | Requirement |
|---|---|
| P1 | Use **Claude Code** as the main tool for planning, writing, testing and debugging |
| P2 | **Commit small working steps to Git** |
| P3 | Use **only synthetic customer data** |
| P4 | Keep the **bot token and API keys out of the repository** |
| P5 | **Share the bot's link early**, because a Telegram bot can only message people who have started it |
| P6 | Work incrementally: start small, test on a classmate, learn what's missing, build from there (strong guidance) |

### 2.3 Submission requirements [PDF]

| # | Deliverable |
|---|---|
| S1 | **GitHub repository** with source code |
| S2 | **README** covering **setup and usage** |
| S3 | Your **CLAUDE.md** in the repo |
| S4 | **Telegram bot username** |
| S5 | **The bot keeps running until judging is complete** |
| S6 | Deadline: Tuesday 27 Oct, 12:00 noon (see §0) |

### 2.4 Judging criteria [PDF]

| Criterion | What judges look for | How Offerly AI addresses it |
|---|---|---|
| **Core functionality** | Offers stay within the rules' limits and reach classmates via the bot | Deterministic validator gates every send; live Telegram delivery; audit log proves it |
| **Data realism** | Synthetic data behaves like real customer data | Persona-driven generator with skewed spend, seasonality, cart abandonment and churn patterns |
| **Usability** | A marketing team could understand and adjust the rules **without help** | Plain-language rules editor with sliders, explanations and a live "what would happen" preview |
| **Design** | Offer messages are clear and appealing; results are easy to read | Formatted Telegram messages with buttons; clean dashboard charts |
| **Advanced functionality** | Handles harder or adjacent cases well | Fallbacks, AI-retry-on-violation, holdout or uplift measurement, budget caps, edge cases (see §4.2) |
| **Relevance** | Offers make business sense for a real platform | Offers chosen for incremental value (e.g. win-back for at-risk customers, none for "would buy anyway") |

### 2.5 Your constraints (not in the PDF) [YOU]

- Stack: **React + Vite** (frontend), **Node.js + Express** (backend), **MongoDB**, **official Anthropic SDK** (backend only).
- AI: **Claude API** for personalisation, with a **safe fallback** if the API fails.
- The AI must **never bypass the backend validator**.
- App name: **Offerly AI**.

These fit the brief: it doesn't fix a stack, and it only says "an AI agent".

---

## 3. Main users and their workflows

### 3.1 Marketing team member (admin dashboard user)
This is who the usability criterion is about.

1. Open the dashboard and see the headline numbers: offers sent, claim rate, discount spend, rule violations blocked.
2. Browse **customers** and their segment, history and risk scores, to understand who is who.
3. Create or edit **offers**: type, value, eligible segments and categories, validity, budget.
4. Adjust **rules** in plain language, e.g. "Never give more than 20% off" or "Max 1 offer per customer per 7 days". Preview how many customers would be affected.
5. Launch a **campaign**: pick a target group, then the AI picks and personalises the offers, the validator checks them, and the bot sends them. Or let real-time triggers run.
6. Review the **decision log**: for each offer, what the AI proposed, why, what the validator said (pass, or which rule it failed), and what was finally sent.
7. Read **results and insights** by segment and offer type.

### 3.2 Classmate (Telegram recipient)
1. Open the bot link and press **Start**. This is required before the bot can message them [PDF P5].
2. Get linked to a **synthetic customer profile** (see the assumption below).
3. Receive personalised offers, formatted with clear value, expiry and buttons.
4. Interact: **Claim**, **Not interested**, or **Show my offers**. Optionally simulate shopping behaviour ("browse", "add to cart") to trigger real-time offers.

**[ASSUMPTION] Linking classmates to customer data.** Classmates are real people but the customer data must be synthetic [PDF P3]. So each classmate who presses Start is **assigned or chooses a synthetic persona/customer profile**, and offers are decided from that synthetic profile. The only real data stored is what Telegram needs to deliver: the chat ID and, optionally, a first name for greeting. No real purchase or personal data is collected.

### 3.3 Judge / evaluator
1. Reads the README and runs the project, or uses the deployed version.
2. Starts the bot, receives an offer, and checks that it respects the rules.
3. Changes a rule in the dashboard, then checks that the next offers obey the new limit.
4. Inspects the decision log and the results dashboard.

### 3.4 Developer (you)
Seeds data, configures env vars, runs tests, deploys, and monitors the bot during judging.

---

## 4. Feature list

### 4.1 Essential features (needed to meet the brief)

| Feature | Maps to |
|---|---|
| **Synthetic data generator**: seeded and reproducible; customers, orders, browsing sessions, cart events, reward points; persona-based behaviour | F3, P3, Data realism |
| **Derived customer features**: RFM (recency/frequency/monetary), churn risk, discount sensitivity, average order value, favourite categories, cart-abandonment flag, segment label | F1, Relevance |
| **Offer catalogue (CRUD)**: % off, flat ₹ off, free shipping, bonus reward points, category-specific; min order value, eligible segments, validity window, budget or redemption cap | F1, F4 |
| **Business rules (CRUD, configurable)**: max discount %, max ₹ discount, frequency cap, cool-down after purchase, eligible segments per offer, campaign budget, margin floor, quiet hours, "do not discount likely-buyers" rule, message rules (length, no false claims) | F4, Usability |
| **Candidate pre-filter**: deterministic list of offers a customer is eligible for, given to the AI | F4, F5 |
| **AI decision agent (Claude)**: picks one offer (or "no offer") from the candidates, sets parameters within allowed ranges, writes the personalised message, and returns structured JSON with a reason | F5 |
| **Independent validator**: pure backend code that re-checks every AI output against the rules and the live data before sending; the single gate before delivery | F6, Core functionality |
| **Safe fallback**: if the AI times out, errors, returns malformed output, or fails validation, use a deterministic rule-based choice plus a template message (also validated) | [YOU], Advanced |
| **Telegram bot**: `/start` with profile linking, offer delivery, inline buttons (Claim / Not interested / My offers), `/help`, `/stop` to opt out | F2, P5, S4 |
| **Decision and audit log**: AI proposal, validator verdict with failed rule(s), fallback used or not, final message, delivery status | F6 evidence, Usability |
| **Results dashboard**: sent, delivered, claimed, claim rate by segment and offer, discount cost, blocked-by-validator count, AI vs fallback share | F8, Design |
| **Admin web UI** (React): Dashboard, Customers, Offers, Rules, Campaigns, Decision Log, Bot Users | Usability |
| **Secrets hygiene**: `.env` (git-ignored) plus `.env.example`; no keys in code or commits | P4 |
| **README + CLAUDE.md** | S1–S3 |
| **Deployed, always-on backend and bot** | S5 |
| **Validator unit tests**: proof that out-of-limit offers are blocked | Core functionality |

### 4.2 Optional enhancements [REC] (pick by time left)

| Enhancement | Value |
|---|---|
| **Real-time event triggers**: classmate taps "browse electronics" or "add to cart then leave" in the bot, which generates a synthetic event and triggers an instant decision (e.g. cart-abandonment nudge) | Demonstrates "in real time" (F5) vividly |
| **Holdout / control group**: e.g. 10% of eligible customers get no offer, so the uplift (incremental conversion) can be estimated | Strong answer to "how would you know offers work" and to Relevance |
| **Simulated redemption model**: synthetic customers "respond" based on a propensity formula, so the dashboard has meaningful numbers beyond the classmates | Data realism, Results |
| **Rule impact preview / simulator**: "If I change max discount to 15%, X customers lose eligibility and estimated cost drops by ₹Y" | Usability (strong) |
| **AI self-correction loop**: on validation failure, re-ask the AI once with the violation reason before falling back | Advanced |
| **Message A/B variants**: tone or emoji variants with performance compared | Design, Advanced |
| **Budget pacing**: stop or slow sends as campaign budget nears its limit | Relevance |
| **Edge cases**: brand-new customers with no history, dormant customers, recent returners or possible abusers, customers at points expiry, festive season (Diwali) boosts | Advanced, Data realism |
| **Natural-language rule explanation**: show each rule as a plain sentence beside the control | Usability |
| **Admin login** (single password from env) | Safer when deployed publicly |
| **CSV export** of results and decision log | Usability |
| **Hindi/Punjabi message option** | Relevance for the local audience |

---

## 5. End-to-end flow

```
┌───────────────────┐   1. seed (reproducible)
│ Synthetic Data    │──────────────────────────────┐
│ Generator         │                              ▼
└───────────────────┘                    ┌──────────────────┐
                                         │ MongoDB          │
 Marketing UI ──2. edit offers & rules──▶│ customers, events│
                                         │ offers, rules,   │
                                         │ decisions, sends │
                                         └────────┬─────────┘
 Trigger (campaign / bot event / /myoffer)        │
        │                                         │
        ▼                                         ▼
┌───────────────────┐ 3. features  ┌──────────────────────────┐
│ Decision Service  │◀────────────│ Feature builder (RFM,    │
│ (orchestrator)    │              │ churn risk, segment…)    │
└──────┬────────────┘              └──────────────────────────┘
       │ 4. deterministic candidate pre-filter (eligible offers + allowed ranges)
       ▼
┌───────────────────┐ 5. structured JSON: {offerId, value, message, reason} or "no offer"
│ AI Agent (Claude) │──────────────────────────┐
└───────────────────┘   (timeout/error ──▶ fallback)
                                             ▼
                                ┌────────────────────────┐
                                │ INDEPENDENT VALIDATOR  │ 6. re-checks everything
                                │ (pure code, no AI)     │    against live rules & data
                                └───┬──────────────┬─────┘
                               pass │              │ fail
                                    │              ▼
                                    │   7. retry AI once with violation
                                    │      → still fails → rule-based fallback
                                    │      → fallback ALSO validated
                                    ▼
                         ┌────────────────────┐ 8. log decision (audit)
                         │ Delivery Service   │──▶ Telegram Bot ──▶ Classmate
                         └────────────────────┘
                                    │ 9. button taps (Claim / Not interested)
                                    ▼
                         ┌────────────────────┐
                         │ Tracking &         │ 10. metrics, segment insights,
                         │ Analytics          │     holdout uplift (optional)
                         └────────────────────┘
```

### Step by step

1. **Generate synthetic data.** A seeded generator creates around 500–2,000 customers across personas such as *Loyal high-spender, Deal-seeker, New customer, At-risk/lapsing, Dormant, Cart abandoner, Window-shopper (browses, rarely buys)*. Realism techniques:
   - Spend follows a skewed (long-tail) distribution: a small share of customers drive most revenue.
   - Order values are roughly log-normal. Categories have plausible price ranges, e.g. electronics vs groceries vs fashion.
   - Timing patterns: weekday and evening peaks, a festive-season spike (Diwali, which falls in this period), salary-week effects.
   - Correlated behaviour: high browsing usually precedes purchases, cart abandonment is common (often 60–70%), returns vary by category, and points accumulate from orders.
   - Indian cities and ₹ currency for local relevance.
   - Everything is clearly synthetic: no real names, phones or emails, or obviously fake ones.
2. **Configure offers and rules.** Marketing edits these in the UI. Rules are stored as structured data (type + parameters), not free text, so the validator can enforce them exactly.
3. **Build features** for the target customer from their events: recency, frequency, monetary value, churn risk, discount sensitivity, last offer date, offers received this period, and so on.
4. **Pre-filter candidates (deterministic).** List the offers this customer is eligible for, with the allowed value range for each. If none qualify, the decision is "no offer", and the AI is not called.
5. **AI chooses and personalises.** Claude gets the customer's derived features (synthetic), the candidate list and the limits, and returns **structured JSON**: chosen offer ID (or none), value, a short personalised message, and a reason. The AI has **no access** to the database, the bot, or any sending capability. It only returns a proposal.
6. **Independent validation.** Backend code (no AI) re-checks the proposal against the current rules and data:
   - The offer exists, is active and in its validity window.
   - The customer is eligible (segment, category, cool-down, frequency cap, opt-in).
   - The value is within the max % and ₹ limits and the margin floor; the min order is respected.
   - Campaign and offer budget remain; quiet hours are respected.
   - The message matches the offer: the numbers stated in the text equal the approved value, there are no extra promises, it fits the length limit, and it contains no banned words.
   - Any failure means **not sent**.
7. **Recovery.** Retry the AI once with the violation reason [REC]. If it still fails, or the API is down, use the **deterministic fallback**: the best eligible offer by rule priority, plus a template message. The **fallback also goes through the validator**.
8. **Log and deliver.** Store the full decision record (proposal, verdict, failed rules, source = AI or fallback, final message). The delivery service sends **only validated decisions** to Telegram, so it is impossible to send without a passing validation record.
9. **Track engagement.** Telegram doesn't report reads, so **inline-button taps** stand in for engagement: Claim = conversion proxy, Not interested = negative signal. Delivery failures are logged too, e.g. a user blocked the bot.
10. **Analyse.** The dashboard shows funnel metrics (decided → validated → sent → claimed), results by segment and offer type, discount cost, validator blocks by rule, and AI vs fallback share. Optionally it also shows **uplift vs holdout** and simulated redemptions for the synthetic population.

**Key safety property:** The only path to Telegram is `Delivery Service ← Validator(pass)`. The AI service returns data; it never calls delivery.

---

## 6. Architecture and development phases

### 6.1 Proposed architecture [REC]

**Repository layout (monorepo):**
```
/client        React + Vite admin dashboard
/server        Node + Express API, bot, AI, validator
  /src
    /data        synthetic generator + seed script
    /models      Mongoose schemas
    /rules       rule definitions + validator (pure functions)
    /ai          Anthropic SDK client, prompt, JSON schema, fallback
    /decision    orchestrator (features → candidates → AI → validate → log)
    /bot         Telegram bot handlers
    /analytics   metric aggregations
    /routes      REST endpoints
  /tests         validator + decision unit tests
/docs          PROJECT_PLAN.md, etc.
README.md, CLAUDE.md, .env.example, .gitignore
```

**MongoDB collections:** `customers`, `events` (orders, sessions, cart), `offers`, `rules`, `campaigns`, `decisions` (the audit log), `deliveries`, `botUsers` (chat ID ↔ synthetic customer link).

**Key backend endpoints:** `/api/customers`, `/api/offers`, `/api/rules`, `/api/campaigns/:id/run`, `/api/decisions`, `/api/analytics/*`, `/api/seed` (dev only), `/api/health`.

**Libraries [REC]:**
- `@anthropic-ai/sdk` (required by you)
- `mongoose`
- `telegraf` or `grammy` for the bot. Either is fine; grammY has good TypeScript and webhook support.
- `zod` to validate AI JSON shape
- `@faker-js/faker` with a fixed seed
- `recharts` for charts
- `vitest` or `jest` for tests

**AI model [REC]:** use a current Claude model (e.g. Sonnet 5.5 for quality, or Haiku 5.5 for speed and cost), set via an env var so it's easy to switch. Set a short timeout of about 10–15 s, cap `max_tokens`, and use structured or tool output. I'll confirm the exact model ID and SDK usage against the official docs at implementation time.

**Bot mode [REC]:** long polling is simplest for local development. Webhooks suit hosting. Run the bot in the same Node process as the API so one deployment covers both.

**Deployment [REC]:**
- **MongoDB Atlas free tier** for the database.
- **An always-on host** for the backend and bot: Railway, Render (paid instance), Fly.io, or a small VPS. Free tiers that **sleep when idle** are a judging risk (§8).
- Frontend served by Express as static build files, or on Vercel/Netlify.

### 6.2 Development phases (≈5 days to the deadline)

Each phase ends with a working, committed state [PDF P2].

| Phase | When | Deliverable | Commit milestone examples |
|---|---|---|---|
| **0. Setup** | Thu 22 Oct | Repo scaffold, `.gitignore`, `.env.example`, CLAUDE.md, README skeleton, health endpoint, Atlas connection; **create the bot with @BotFather and share the link with classmates now** [PDF P5] | "chore: scaffold client and server" |
| **1. Data** | Thu–Fri | Seeded generator plus feature builder; customers browsable via API | "feat: synthetic customer generator" |
| **2. Offers + Rules + Validator** | Fri | CRUD plus a validator with unit tests proving that out-of-limit offers are blocked | "feat: rule validator with tests" |
| **3. Thin end-to-end slice** | Fri–Sat | `/start` → link profile → rule-based offer → validator → Telegram. **Test on one classmate** [PDF P6] | "feat: first validated offer via Telegram" |
| **4. AI agent** | Sat | Claude proposal (JSON) → validator → retry or fallback; decision log | "feat: Claude personalisation with fallback" |
| **5. Dashboard UI** | Sat–Sun | Rules editor (plain language), offers, campaigns, decision log, results charts | "feat: rules editor UI" |
| **6. Tracking + insights** | Sun | Button tracking, analytics, optional holdout and simulated redemptions | "feat: offer performance analytics" |
| **7. Deploy + harden** | Mon 26 Oct | Always-on deployment, error handling, rate limits, test with several classmates | "chore: production deployment" |
| **8. Polish + submit** | Tue 27 Oct, before 12:00 | README (setup, usage, screenshots), final CLAUDE.md, bot username, final check | "docs: final README" |
| **After submission** | Until judging ends | Keep the bot running; monitor logs | — |

If time runs short, cut from §4.2 first. Phases 0–4 plus a basic dashboard and deployment already satisfy the core brief.

---

## 7. Credentials and external accounts needed

| Item | Where to get it | Stored as | Notes |
|---|---|---|---|
| **Anthropic (Claude) API key** | console.anthropic.com → API Keys | `ANTHROPIC_API_KEY` | **Separate from your Claude Code login or subscription.** API usage is billed per token, so add credits and set a spend limit in the console. |
| **Telegram bot token** | Telegram → @BotFather → `/newbot` | `TELEGRAM_BOT_TOKEN` | Also gives you the **bot username** needed for submission (S4). If it leaks, revoke it with `/revoke` in BotFather. |
| **MongoDB connection string** | MongoDB Atlas free M0 cluster (or local MongoDB for development) | `MONGODB_URI` | Allow your host's IPs in Atlas network access. |
| **GitHub account + repository** | github.com | — | Submission (S1). Public or private, as your instructor allows (**[ASSUMPTION]**: check whether judges need access to a private repo). |
| **Hosting account** | Railway / Render / Fly.io / VPS | Host's env-var settings | Needed so the bot runs until judging (S5). |
| Admin password [REC] | You choose | `ADMIN_PASSWORD` | Protects the deployed dashboard. |
| Model name [REC] | — | `CLAUDE_MODEL` | Lets you switch models without code changes. |
| Webhook secret [REC] | You generate | `TELEGRAM_WEBHOOK_SECRET` | Only if using webhooks. |

**Secrets rules:**
- `.env` stays git-ignored from the very first commit, and only `.env.example` with placeholders is committed.
- Keys are never written to the frontend or logs.
- The Anthropic SDK runs **only on the backend**.
- **[REC]** Run a quick secret scan (e.g. `gitleaks` or a manual `git log -p | grep`) before the final push.

---

## 8. Risks during judging and how to prevent them

| Risk | Impact | Prevention |
|---|---|---|
| **Bot offline at judging** (laptop asleep, free host sleeping, crash) | Fails S5 and core functionality | Always-on host; auto-restart; `/api/health`; check it the morning of judging; keep a local backup run ready |
| **Classmates never pressed Start** | Bot cannot message them [PDF P5] | Share the bot link on day 0; track started users on the Bot Users page; `/start` greets immediately |
| **AI sends an out-of-rules offer** | Fails the core criterion | Validator as the only gate to delivery; unit tests for each rule; numbers in the message checked against approved values |
| **Claude API down, slow, out of credits or rate-limited** | No offers sent | Timeout plus deterministic fallback (also validated); spend limit with buffer credits; cache or reuse decisions where sensible |
| **Malformed AI output** | Crash or bad message | Structured output, schema validation with zod, fallback on parse failure |
| **Leaked API key or bot token** in Git | Abuse, revoked keys at demo time; violates P4 | `.gitignore` from the first commit; `.env.example`; pre-push check; revoke and rotate if leaked |
| **Synthetic data looks fake** (uniform random) | Loses data-realism points | Persona-driven, skewed distributions, seasonality, correlated behaviour; show distribution charts on the dashboard |
| **Rules UI too technical** | Loses usability points | Plain-language labels and help text, sensible defaults, previews; test with a non-technical classmate |
| **Offers don't make business sense** (e.g. big discount to loyal buyers) | Loses relevance points | "Don't discount likely-buyers" rule, segment-to-offer mapping, reasons shown in the decision log |
| **Telegram rate limits on bulk send** | Partial delivery | Throttle sends (≈1 msg per second per chat, ≤30/s overall); queue with retry |
| **User blocks the bot** | Send errors | Catch 403 errors, mark the user inactive, continue the campaign |
| **Duplicate sends / spam** | Bad UX, breaks frequency rules | Frequency cap enforced in the validator; idempotent campaign runs |
| **MongoDB Atlas IP or connection issues on the host** | Backend down | Configure network access early; test the deployed connection on day 4, not day 5 |
| **README setup doesn't work for judges** | Can't evaluate | Step-by-step README, `.env.example`, a seed command; test with a fresh clone |
| **Scope creep** and a late, broken submission | Missing the deadline | Thin end-to-end slice first (Phase 3); optional features only after the core works; commit often |
| **Real personal data collected** from classmates | Violates the spirit of P3 | Store only the chat ID (and optionally first name); profiles stay synthetic; `/stop` deletes the link |
| **CLAUDE.md missing or outdated** | Missing deliverable S3 | Create it in Phase 0 and update it each phase |

---

## 9. Open questions for you

1. **Classmate-to-profile linking:** should a classmate **pick a persona** at `/start` (fun and demo-friendly), or be **randomly assigned** a synthetic customer? My recommendation: let them pick a persona, then assign a matching synthetic customer.
2. **Hosting:** which always-on host can you use (Railway, Render paid, Fly.io, VPS)? This decides webhook vs polling.
3. **Repository visibility:** public or private? If private, who needs access?
4. **Which optional enhancements** from §4.2 do you want prioritised? My suggestion: real-time bot triggers, holdout uplift, and the rule impact preview.
5. **Product domain:** a general marketplace (electronics, fashion, grocery, home) is my default. Do you want a different focus?

---

*Next step: wait for your approval or changes to this plan before writing any application code or installing packages.*
