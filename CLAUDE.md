# CLAUDE.md — Offerly AI: Personalised Offer Engine

Persistent instructions for Claude Code in this repository. Read this file at the start of every task.

## 0. Sources of truth (in priority order)

1. **Hackathon brief**: `Hackathon_2_Brief.pdf` (Punjab Jobs AI Bootcamp · J-PAL South Asia, Hackathon 2). It currently lives **outside this repo** at `C:\Users\anand\Desktop\purvika_java\Hackathon_2_Brief.pdf`. If it is copied into the repo later, use that copy.
2. **This file**: guardrails and the project goals the user has set.
3. **`docs/PROJECT_PLAN.md`**: the approved requirements analysis and phased plan.
4. The other docs in `docs/` once they exist (`ARCHITECTURE.md`, `API_SPEC.md`, `TESTING.md`).

If these conflict, the PDF wins, then this file. Explain any conflict to the user **before** making a major change. Never silently change the assignment, and never invent mandatory requirements.

### What the brief requires (summary; see the PDF for wording)
- Decide **which offer each customer** of an e-commerce platform should receive.
- **Deliver offers to classmates through a Telegram bot.** This is mandatory.
- **Generate realistic synthetic customer data.** Use **only** synthetic customer data.
- **Rules you design** set the limits for every offer. An **AI agent may choose and personalise offers in real time within those limits**.
- **Every AI choice must be checked against the rules before it is sent.**
- **There is no store to build.** Never build a storefront, checkout, or e-commerce website.
- Work it out yourself: what data a platform collects, how customers differ, which offer suits whom, what limits a business sets, and how to know whether offers work.
- Process:
  - Use Claude Code as the main tool.
  - Commit small working steps to Git.
  - Keep the bot token and API keys out of the repo.
  - Share the bot link early, because a bot can only message users who have started it.
- **Submission:**
  - A GitHub repo with source, a README (setup + usage) and this CLAUDE.md.
  - The **Telegram bot username**, with the **bot running until judging is complete**.
  - Deadline: **Tuesday 27 Oct 2026, 12:00 noon**. Judging is the following session.
- **Judging:** core functionality (offers stay within the rules and reach classmates via the bot), data realism, usability (a marketing team can adjust the rules without help), design (clear, appealing messages; readable results), advanced functionality (harder and adjacent cases), and relevance (business sense).

## 1. Project understanding

Offerly AI is a bounded, agentic offer-decision system. It:
1. generates realistic synthetic customer data;
2. evaluates customer behaviour;
3. finds the offers each customer is eligible for, using deterministic code;
4. lets Claude choose and personalise from those candidates;
5. **independently validates** every decision;
6. delivers approved offers to classmates via **Telegram**;
7. tracks delivery, engagement, redemption and outcomes.

Email is an **optional additional** channel. It is not in the brief and never replaces Telegram.

The system must show meaningful agentic behaviour, but it stays **deterministic wherever safety, eligibility, financial limits or business rules are involved**.

Classmates are real people, while customer profiles are synthetic. A classmate who starts the bot is linked to a synthetic customer profile, and decisions use only that synthetic data. For a classmate, store only what Telegram delivery needs: the chat ID, and optionally a first name for greetings.

## 2. Technology stack

Do not silently change technologies. If a concrete incompatibility appears, explain it and ask.

| Area | Choice |
|---|---|
| Frontend | React + Vite, TypeScript |
| Backend | Node.js + Express, TypeScript |
| Database | MongoDB with Mongoose |
| AI | Official Anthropic TypeScript SDK (`@anthropic-ai/sdk`), **backend only** |
| UI | Tailwind CSS, Motion for React, Lucide icons |
| Validation | Zod, used consistently for config, requests, AI output and shared schemas |
| Testing | Vitest + Supertest (backend/API); React Testing Library (frontend, where useful) |
| VCS | Git + GitHub |

- Do **not** introduce Docker, Python, microservices, message queues or extra infrastructure without a clear requirement and the user's approval.
- Telegram library: pick one (grammY or Telegraf) when the bot milestone starts, then use it consistently.
- The Claude model ID comes from an env var (e.g. `CLAUDE_MODEL`). Confirm current model IDs and SDK usage against the official docs (the `claude-api` skill) when implementing. Don't rely on memory.
- Keep the layout modular and understandable. The planned layout (see `docs/PROJECT_PLAN.md` §6) is:
  - `client/`: React app
  - `server/src/{data,models,rules,ai,decision,bot,analytics,routes}`
  - `server/tests/`
  - `docs/`

## 3. Product capabilities (goals; implement incrementally)

1. Synthetic customers covering profiles, purchase history, browsing events, cart activity, reward points, segments and realistic behaviour patterns. Data is seeded and reproducible.
2. Dynamic offer management: types, values, eligibility, validity windows, budgets, usage limits and applicable segments.
3. Business rules that a marketing user can understand and change in the UI.
4. Customer and event-based triggers that decide when to evaluate a recommendation.
5. An agentic decision workflow (§5).
6. Independent server-side validation before any delivery.
7. Telegram delivery (required), plus optional email.
8. Offer expiry, delivery history, redemption tracking, duplicate prevention and audit logs.
9. Analytics: delivery, engagement, redemption, cost, budget usage and business outcomes.
10. A polished, responsive dashboard for customers, offers, rules, decisions, delivery and results.
11. A full automated test suite and a reproducible seed/demo workflow.

These are product goals, **not** permission to build everything at once. Follow the plan milestone by milestone.

## 4. Architecture and safety boundaries — non-negotiable

- **The AI proposes; deterministic backend code decides.** The AI never creates, modifies, approves or delivers an offer directly. It has no database, bot or email access, and it only returns a structured proposal.
- Only **offers loaded from the database** that are **eligible under the current rules** may be put in front of the AI as candidates.
- Every AI output is **schema-validated with Zod** and then **checked against current server-side rules**.
- **Nothing is sent** (Telegram or email) before the independent validator approves it.
- The delivery layer accepts **only an approved, persisted, validated decision** (e.g. by decision ID with `status: approved`), never raw model output or arbitrary text.
- Validation must **never depend on the AI's explanation, reasoning or confidence**.
- The validator enforces all of these:
  - eligibility, active/paused status and expiry;
  - discount ceilings (% and ₹) and minimum purchase conditions;
  - offer and campaign budgets and usage limits;
  - frequency caps and cool-downs;
  - configured exclusions and opt-out.
- Personalised wording must match the validated offer. Any numbers, percentages, amounts or expiry dates in the message must equal the approved values. Personalisation **never changes an offer's discount or terms**.
- **Recheck time- and budget-sensitive conditions immediately before delivery**: expiry, budget, usage limit, frequency cap and opt-out.
- Prevent duplicates at every stage: duplicate requests, repeated triggers, duplicate deliveries and duplicate redemptions. Use idempotency keys and unique indexes.
- Use **atomic MongoDB updates** (conditional `findOneAndUpdate` with `$inc` guarded by limits) or transactions wherever concurrent requests could overspend a budget or exceed a usage limit.
- Audit every decision: inputs, eligible candidates, selected offer, schema result, validation outcome and rejection reasons, path (AI / AI-retry / fallback), model ID, delivery outcome, and later engagement or redemption events.
- **Fail closed.** If eligibility or validation cannot be established (database error, missing data, validator exception), do not send.
- During an AI outage (timeout, API error, malformed output, rate limit), a **deterministic rule-based fallback** may be used. It must pass the **same validator**, and it is clearly marked as a fallback in the audit log and the UI.
- Never trust user input, Telegram or webhook payloads, or model output without validation.
- Store no unnecessary personal information. Customer data is synthetic.
- **Analytics honesty:** never claim an offer *caused* a purchase from correlation alone. Label metrics as **observed**, **estimated/simulated**, or **experimental (holdout/control)**.

## 5. Agentic workflow and test harness

The decision pipeline is a bounded, observable workflow, not an unrestricted autonomous agent:

1. Receive a defined event or recommendation request (with an idempotency key).
2. Load the customer profile and the relevant synthetic history.
3. Load the current offers and business rules.
4. Filter out ineligible offers with deterministic code. If none remain, record "no offer" and don't call the AI.
5. Ask Claude to select and personalise **only from the eligible candidates**, with structured output.
6. Validate the response against a strict Zod schema.
7. Independently validate the selected offer and all constraints. On failure, optionally retry the AI once with the violation reason, then fall back to the deterministic choice.
8. Persist the decision and the validation result.
9. Deliver only an approved decision through the selected channel, rechecking time- and budget-sensitive conditions first.
10. Record the delivery outcome, then later engagement and redemption events.
11. Update analytics from persisted events only.

**The harness:** build the pipeline with injectable dependencies: AI client, clock, RNG/seed, repositories, Telegram sender and email sender. Tests can then use controlled inputs, fixed synthetic fixtures, mocked AI responses, simulated failures and deterministic runs, and assert on decisions **and** side effects. It must cover:
- valid and invalid AI output: wrong schema, unknown offer ID, changed discount, mismatched numbers in the message;
- offers that are ineligible, expired, disabled or paused, or over budget or usage limit;
- discount ceilings, minimum purchase and frequency caps or cool-downs;
- AI timeouts, API errors, malformed responses and rate limits, plus the fallback path;
- duplicate events, concurrent requests (no overspend) and delivery idempotency;
- database failures (fail closed) and Telegram/email failures (blocked user, network, 429);
- retries and audit completeness.

**Never** make live Anthropic API calls or send real Telegram or email messages in automated tests. Use mocks or an explicit, isolated test mode (e.g. `NODE_ENV=test` refuses to construct real clients).

## 6. Dynamic offers and data separation

- Offers are **never hardcoded only for a demo**. Authorised users can create, edit, activate, pause, expire and configure them through the app. Eligibility and recommendations always reflect the current database state and current rules.
- Use synthetic events and configurable triggers to show behaviour-driven re-evaluation, e.g. cart abandonment, a change in purchase frequency, inactivity, or approaching offer or points expiry.
- Keep these as separate concepts, collections and modules:
  1. offer definitions;
  2. eligibility and business rules;
  3. recommendation decisions;
  4. delivery records;
  5. engagement and redemption events;
  6. analytics, derived from persisted events.
- Rules are stored as **structured data** (type + parameters) so the validator enforces them exactly. Each rule has a plain-language description for marketing users.

## 7. Security and configuration

- All secrets live in environment variables: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, email credentials, admin credentials, webhook secret.
- Never put secrets in frontend code, committed files, logs, screenshots, docs or test fixtures. **Never use a `VITE_` variable for a server-side secret.**
- Maintain `.env.example` with **placeholders only**. Real `.env` files must be git-ignored. Check `.gitignore` before the first commit that adds config.
- Validate configuration at startup with Zod. Give helpful errors that name the missing or invalid variable **without printing its value**.
- Validate and sanitise all incoming requests. Return safe error messages, with no stack traces or secrets in responses.
- Require authentication and authorisation for admin actions before the app is exposed publicly.
- If Telegram webhooks are used, verify `X-Telegram-Bot-Api-Secret-Token`.
- Apply rate limiting to public endpoints.
- Don't call a feature "secure" just because it works in a local demo. State what is and isn't protected.
- If a secret is ever committed, tell the user immediately: it must be revoked and rotated (BotFather `/revoke`, Anthropic console). Rewriting history alone is not enough.

## 8. Testing and quality

Tests are a first-class requirement.
- Unit tests: eligibility, scoring, offer rules, validators and fallback logic.
- API integration tests (Supertest): customers, offers, rules, recommendation, delivery and redemption flows.
- Harness tests for the whole decision pipeline (§5).
- Frontend tests for critical interactions and validation states, where practical.
- Test failure paths and boundary conditions, not only happy paths.
- Use deterministic fixtures and seeded synthetic data. Inject the clock and RNG.
- **Never weaken business rules to make tests pass.** Don't delete or rewrite existing tests without explaining why.
- **Never report tests as passing unless they actually ran and passed.** Quote the real results.
- After each milestone, run the available tests, type checks (`tsc --noEmit`), linting and builds, and report the actual output.
- Report failures, blockers and untested areas honestly.

## 9. UI/UX

- Aim for a premium, cohesive SaaS look: clear navigation, understandable workflows, and responsive desktop and mobile layouts.
- Accessibility: good contrast, visible focus states, keyboard support and readable type.
- Use consistent design tokens and reusable components. Tailwind, Motion and Lucide are used consistently.
- Every view has useful empty, loading, success and error states.
- Animation should be meaningful, not decorative.
- Decision explanations should be easy to understand. Clearly mark **synthetic/demo data** and **AI-fallback decisions**.
- Rules are editable by a non-technical marketer: plain-language labels, help text, sensible defaults and previews.
- Telegram messages are clear and appealing: the value, conditions and expiry are obvious, with inline buttons (e.g. Claim / Not interested).
- **Honest analytics:** no hardcoded numbers shown as live results.
- Don't polish decorative details while core functionality or tests are broken.

## 10. Development workflow — follow strictly

The user guides the work **one milestone per prompt**.
- At the start of each task, read this file and the relevant docs. Inspect the existing repo before editing.
- Implement **only the scope of the current prompt**. Do not start future milestones automatically.
- Don't regenerate the project or overwrite working modules unnecessarily. Prefer small, focused changes.
- If a request conflicts with the PDF or the approved architecture, explain the conflict before any major change.
- For decisions with significant architectural, security, cost or deployment consequences, explain the options and ask first. Don't ask about routine details this file already settles.
- Don't claim a task is complete while required work or checks remain.
- Don't install packages, create external services, deploy, send messages or perform destructive operations unless the current task requires it.
- **Make no Git commit unless the user explicitly asks for one in the current task.** The brief requires small, working commits, so at the end of each working milestone, *recommend* a commit and a message. Make the commit only on request.

**After every milestone, report:**
1. What was implemented.
2. Files created or modified.
3. Architecture and data-model decisions.
4. Commands and checks actually run, with their real results.
5. Known issues and remaining work.
6. The recommended next milestone (don't start it).

## 11. Documentation

| File | Purpose |
|---|---|
| `docs/PROJECT_PLAN.md` | Requirements analysis and phased plan |
| `docs/ARCHITECTURE.md` | Components, boundaries and data flow |
| `docs/API_SPEC.md` | API contracts |
| `docs/TESTING.md` | How to run tests; scenarios covered |
| `README.md` | Setup, configuration, seeding, testing, running, Telegram setup, optional email setup, demo instructions |
| `CLAUDE.md` | Persistent project instructions and guardrails (this file) |

- Update docs when implementation makes them inaccurate.
- Don't create duplicate documents without a reason.
- Create each doc when its milestone needs it, not ahead of time.

## 12. Hackathon-critical reminders

- The bot must be **running until judging is complete**. Plan for always-on hosting; a free tier that sleeps when idle is a risk. Hosting choice needs the user's approval.
- Classmates must **press Start** before the bot can message them, so remind the user to share the bot link early.
- Keep a thin, working end-to-end slice (start → validated offer → Telegram) ahead of optional features.
- Open questions still to settle with the user are in `docs/PROJECT_PLAN.md` §9: persona selection vs assignment, hosting, repo visibility, which optional features come first, and the product domain.
