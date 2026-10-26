# Deploying Offerly AI (Render + MongoDB Atlas)

> **Secrets:** you type them only into the Atlas, Render and BotFather dashboards, or into your own terminal. Never paste them into chat, commit them, or put them in screenshots.

## 1. How the app must be deployed

Offerly AI is **one Node.js process** (`npm start`) that does all of this:

- serves the **REST API** under `/api`;
- serves the **dashboard** (the built React app in `client/dist`) from the **same origin**. The dashboard calls the relative path `/api`, its session cookie is `SameSite=Strict`, and the Content-Security-Policy allows `connect-src 'self'` only;
- runs the **Telegram bot** with **long polling**, which is a permanently open loop;
- runs the **maintenance job** every minute (grant expiry, crash recovery, budget reconciliation).

**So:**

| Requirement | Why |
|---|---|
| The dashboard and API must be deployed **together**, as one web service | Splitting them would break the cookie, the CSP and the relative API URL, and would need CORS, which is deliberately not enabled |
| The process must run **continuously** | Serverless functions (Vercel functions, Supabase Edge Functions and similar) can't run long polling or the minute job |
| Run **exactly one instance** | Two instances would both poll the same bot (Telegram 409) and split in-memory rate limits |
| Data lives in **MongoDB Atlas** | Render's free filesystem is wiped on every restart, so nothing is stored on the server's disk |

## 2. Recommended setup and what the free tier really does

**Render web service (Free) + MongoDB Atlas M0 (Free) + an external uptime monitor.**

What Render's documentation says about free web services, as checked on 26 Oct 2026:

| Behaviour | Effect on Offerly | Mitigation |
|---|---|---|
| **Spins down after 15 min with no inbound HTTP traffic**; spin-up takes about 1 min | The **bot stops** while spun down. Telegram messages don't wake it, because the bot fetches messages rather than receiving them. | An uptime monitor requests `/api/health` every 5 min (§4, step 8). Telegram keeps unanswered messages for 24 h, and they're answered on wake. |
| 750 free instance hours per workspace per month; when used up, free services are **suspended until next month** | Running 24/7 uses about 744 h in a 31-day month: just under the limit, *if this is your only free service* | Keep no other free web services running in the same workspace |
| "Render might restart a Free web service at any time" | Brief outage, about 1 min | Nothing is lost: data is in Atlas, sessions are signed cookies, and maintenance recovers interrupted work |
| Ephemeral filesystem | None. Offerly writes nothing to disk. | — |
| Deploys overlap old and new instances for about 60 s | Both poll briefly; one logs a 409 conflict | The bot supervisor retries 409s at most every 60 s, so the hand-over completes on its own |

Render's docs don't say whether health checks or rollbacks are available on the free plan. If they're missing from your dashboard, use the alternatives given below.

**The safer paid option** is the same steps with **Instance Type: Starter** (about US$7/month; confirm on Render's pricing page). It never spins down, so you don't need the uptime monitor.

## 3. Requirements already in the code (no action needed)

| Area | Implementation |
|---|---|
| Node.js version | `package.json` `engines: "node": "24.x"`. Dependencies need at least: runtime **≥ 20.19** (mongoose 9), dashboard build **≥ 20.19 / 22.12** (vite 8), tests **≥ 22.12** (vitest 5). Tested on 24.13. |
| Build / start | Root `npm run build` installs both apps and builds the dashboard; root `npm start` starts the server |
| Configuration | Validated at startup. Errors name the variable, never its value. Production refuses to start without the admin login settings. |
| Database outages | Startup retries the connection 8 times with backoff (about 2 min) before exiting, so the host restarts it. While running, the driver reconnects on its own, `/api/health` returns 503, and decisions fail closed (nothing is sent). |
| Claude / Telegram outages | Claude failures fall back to the validated rule-based choice. Telegram failures are retried by the bot supervisor, and the API keeps running. |
| Health check | `GET /api/health` answers within about 2 s, even if the database hangs. It returns `ok`, `degraded` (bot failing, still HTTP 200) or HTTP 503 (database down), plus the bot state, last maintenance run, deployed commit (`release`) and uptime. |
| Graceful shutdown | On SIGTERM: stop the bot and maintenance, finish in-flight requests (up to 15 s), close the database, exit. A hard exit happens at 25 s, inside Render's 30 s window. |
| Logs | Structured JSON on stdout/stderr. API keys, the bot token, the database URI, the session secret and the password hash are redacted. |
| Secrets in the browser | None. The dashboard bundle is checked by an automated test for credential patterns and for the values in your local `.env`. |
| CORS | Not enabled, on purpose (same-origin only). A test confirms that cross-origin requests get no access headers. |

## 4. Steps to do in the dashboards

### Step 1: Create the MongoDB Atlas database (cloud.mongodb.com)
1. **Create cluster** → **M0 Free** → AWS, region **Singapore (ap-southeast-1)**.
2. **Database Access** → **Add New Database User**:
   - username `offerly-app`, method **Password**;
   - **Autogenerate Secure Password**, and keep it privately;
   - role: **Read and write to any database**.
3. **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`). Render's free services have no fixed outgoing IP. TLS plus the strong password protect the cluster.
4. **Connect** → **Drivers** → copy the `mongodb+srv://…` string. Put in the password and add `/offerly` before the `?`:
   `mongodb+srv://offerly-app:<password>@<cluster-host>/offerly?retryWrites=true&w=majority`

### Step 2: Seed Atlas (on your laptop, PowerShell, in the project folder)
```powershell
$env:MONGODB_URI = Read-Host "Paste the Atlas connection string"
npm --prefix server run seed
Remove-Item Env:MONGODB_URI
```
**Expected:** `seed complete` with `customers: 120` and `offers: 7`. The seed script already uses public DNS (8.8.8.8 and 1.1.1.1), because some networks can't resolve Atlas's `mongodb+srv://` addresses.

### Step 3: Create the admin login
```powershell
npm --prefix server run setup-admin
```
Keep the three printed lines and remember the password.

### Step 4: Push the code to GitHub
Render deploys `purvika01-ux/e-commerce`, branch `main`. Your latest commits must be pushed first.

### Step 5: Create the Render web service (dashboard.render.com)
1. Sign in with **GitHub**. When asked, grant access to the private `e-commerce` repository.
2. **New +** → **Web Service** → choose the repository.

   | Field | Value |
   |---|---|
   | Name | e.g. `offerly-ai`, which gives `https://offerly-ai.onrender.com` |
   | Region | **Singapore** |
   | Branch | `main` |
   | Root Directory | *(empty)* |
   | Runtime | **Node** |
   | Build Command | `npm run build` |
   | Start Command | `npm start` |
   | Instance Type | **Free**, or Starter for always-on |

3. **Environment Variables:** add these. Do **not** add `PORT`; Render sets it.
   ```
   NODE_ENV=production
   HOST=0.0.0.0
   TRUST_PROXY=1
   MONGODB_URI=<Atlas connection string>
   ANTHROPIC_API_KEY=<your key>
   CLAUDE_MODEL=claude-opus-5-5
   AI_MODE=auto
   TELEGRAM_BOT_TOKEN=<your BotFather token>
   TELEGRAM_MODE=auto
   ADMIN_USERNAME=<from step 3>
   ADMIN_PASSWORD_HASH=<from step 3>
   SESSION_SECRET=<from step 3>
   ```
   `NODE_VERSION` isn't needed: Render reads `engines` from `package.json`. Check the build log shows Node 24.

4. **Settings → Health Checks** (if shown) → **Edit** → path `/api/health` → **Save Changes**.

### Step 6: Stop the bot on your laptop
Press Ctrl+C in the terminal running the local server. Then, in your local `server/.env`, set `TELEGRAM_MODE=off`, so a local run never competes with the hosted bot.

### Step 7: Deploy and watch the logs
Click **Create Web Service**; the first build takes about 5–10 min. In **Logs**, wait for:
- `mongo connected`
- `telegram bot polling` with `"botUsername":"SmartOffersAI_Bot"`
- `Offerly AI listening on http://0.0.0.0:<port>`

### Step 8 (free tier only): Keep the service awake
At **uptimerobot.com**, create a free account, then:
1. **Add New Monitor** → **HTTP(s)**.
2. URL `https://<name>.onrender.com/api/health`.
3. Interval **5 minutes**.

You'll also get an email if the site goes down.

## 5. Health-check procedure (after every deploy, and before judging)

| Check | Expected |
|---|---|
| `https://<name>.onrender.com/api/health` | `"status":"ok"`, `"db":{"status":"connected"}`, `"telegram":{"status":"polling"}`, and `"release"` showing the commit you expect |
| `https://<name>.onrender.com/` | Sign-in page; your step 3 login opens the dashboard |
| Telegram: `/start` → persona → `/offer` | Linked to a synthetic customer, and a validated offer arrives. Everyone re-links once, because Atlas is a fresh database. |
| Dashboard → **Decision log** | That decision shows **Approved**, validation passed and delivery **sent** |

**If health shows a problem:**

| What you see | Meaning and fix |
|---|---|
| `"status":"degraded"` with `telegram.status: "failed"` | Read `telegram.lastError`. A 409 means another copy of the bot is running: stop it (e.g. on your laptop). A 401 means the token is invalid: set a new one. |
| HTTP **503** | The database is unreachable. Check Atlas (cluster running, Network Access `0.0.0.0/0`, password in `MONGODB_URI`). |
| No response for about 1 min, then OK | A free instance was spinning up. Check the uptime monitor is active. |

## 6. Rollback procedure

**Option A: Render dashboard (fastest).**
1. Service → **Deploys** → find the last good deploy → **Rollback** → **Rollback to this deploy**.
2. This **turns off auto-deploy**. Re-enable it in **Settings** after the fix is pushed.
3. Confirm with `/api/health`: `release` should show the older commit.

Render only keeps a limited number of past builds, and its docs don't say whether rollback is offered on the free plan. If the button isn't there, use option B.

**Option B: Git (works everywhere).**
```powershell
git revert --no-edit <bad-commit-sha>
git push origin main
```
Auto-deploy builds the reverted code. Check `/api/health` → `release`.

**Database:** deploys never change data. To reset the demo data, re-run step 2. The seed refuses if Telegram chats are linked, unless you add `--force`, and re-seeding means everyone must `/start` again.

## 7. Routine operations

- **Logs:** Render → service → **Logs**.
- **Deploys:** each push to `main` deploys automatically. Expect about 60 s of old and new instances overlapping; the bot hands over on its own.
- **Rotating secrets:** change the variable in Render's **Environment** page, then save and redeploy.

  | Secret | Note |
  |---|---|
  | `SESSION_SECRET` | Changing it signs everyone out |
  | Bot token | Revoke it with BotFather `/revoke` first |
  | Anthropic key | Rotate it in the Anthropic console |
  | Atlas password | Change it in **Database Access**, then update `MONGODB_URI` |

- **Costs to watch:** Claude costs about ₹1 per decision (Anthropic console). Atlas M0 and Render Free are free, subject to the limits above.

## 8. Known limits
- One instance only.
- Atlas M0 has no backups and no SLA.
- Long polling only (webhook mode isn't implemented).
- Free-tier spin-down and restarts, as above.
- One admin account.
- Rate limits are keyed by the client address Render forwards. Behind Render's proxy, visitors may share a key. That only affects the admin login and API limits, never the bot.

## Appendix: other hosts
Any always-on Node host works with the same build/start commands and variables, for example Railway, or a VPS with a process manager. Keep **one** instance, and never use serverless functions.
