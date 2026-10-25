# Deploying Offerly AI (Railway + MongoDB Atlas)

**Target:** one always-on Railway service running the API, the dashboard and the Telegram bot (long polling), backed by a free MongoDB Atlas M0 cluster. The bot must stay online until judging is complete.

> **Secrets:** you type secrets only into the Atlas, Railway and Telegram dashboards, or into your own terminal. Never paste them into chat, commit them, or put them in screenshots.

## What you need

| Item | Where | Cost |
|---|---|---|
| MongoDB Atlas account and free **M0** cluster | cloud.mongodb.com | Free |
| Railway account on the **Hobby** plan | railway.com (sign in with GitHub) | About US$5/month, usage-based. Confirm on Railway's pricing page. |
| Anthropic API key | Already in your local `server/.env` | About ₹1 (≈ US$0.01) per Claude decision on `claude-opus-5-5` |
| Telegram bot token | Already in your local `server/.env` | Free |

Pick nearby regions for both: **Atlas AWS Singapore (`ap-southeast-1`)** and **Railway Southeast Asia**. They're close to each other and to classmates in Punjab.

---

## 1. Create the Atlas database

1. On cloud.mongodb.com, **create a cluster** → **M0 (Free)** → provider AWS, region **Singapore (ap-southeast-1)**. Name it e.g. `offerly`.
2. **Database Access** → **Add New Database User**:
   - username `offerly-app`, authentication **Password**;
   - **Autogenerate Secure Password** (letters and digits only, so it needs no URL-encoding), and save it somewhere private;
   - role: **Read and write to any database**.
3. **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`).
   - This is needed because Railway doesn't give your service a fixed outgoing IP.
   - It's acceptable because Atlas requires TLS and the strong password from step 2.
4. **Connect** → **Drivers** → copy the `mongodb+srv://…` string. Then:
   - replace `<db_password>` with the password from step 2;
   - add the database name `offerly` before the `?`, like this:
     ```
     mongodb+srv://offerly-app:<password>@<cluster-host>/offerly?retryWrites=true&w=majority
     ```

## 2. Seed the Atlas database (from your laptop)

This loads 120 synthetic customers, 7 offers and rule set v1. It runs once, from PowerShell in the project folder. The connection string is read with `Read-Host`, so it's kept out of your PowerShell command history.

```powershell
$env:MONGODB_URI = Read-Host "Paste the Atlas connection string"
npm --prefix server run seed
Remove-Item Env:MONGODB_URI
```

**Expected:** `"msg":"seed complete","customers":120,…,"offers":7`.

Your local MongoDB is untouched. The Atlas database starts with no Telegram links, so everyone, you included, presses **/start** again after the move.

## 3. Create the admin login

```powershell
npm --prefix server run setup-admin
```

Type a password of 12+ characters; it isn't shown. Keep the three printed lines (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`) for step 5. Remember the password: it's what you'll sign in with.

## 4. Push the code to GitHub

Railway deploys from `purvika01-ux/e-commerce`, `main` branch. Push your latest commits first.

## 5. Create the Railway service

1. railway.com → **New Project** → **Deploy from GitHub repo** → choose `purvika01-ux/e-commerce`. Grant Railway access to the private repo when asked.
2. Open the service → **Variables** → **Raw Editor**, and paste the values. Don't add `PORT`; Railway provides it.

   ```
   NODE_ENV=production
   HOST=0.0.0.0
   TRUST_PROXY=1
   MONGODB_URI=<Atlas connection string from step 1>
   ANTHROPIC_API_KEY=<your key>
   CLAUDE_MODEL=claude-opus-5-5
   AI_MODE=auto
   TELEGRAM_BOT_TOKEN=<your BotFather token>
   TELEGRAM_MODE=auto
   ADMIN_USERNAME=<from step 3>
   ADMIN_PASSWORD_HASH=<from step 3>
   SESSION_SECRET=<from step 3>
   ```

3. **Settings** in the service:

   | Setting | Value |
   |---|---|
   | Build / Start command | Leave empty. Railway runs the root `package.json` scripts: `npm run build` installs both apps and builds the dashboard; `npm start` starts the server. If the build log shows otherwise, set Build = `npm run build` and Start = `npm start`. |
   | Healthcheck Path | `/api/health` |
   | Restart Policy | **On Failure** |
   | Region | **Southeast Asia** |
   | Replicas | **1**. Never more than one: two copies would both poll the same bot. |

4. **Networking** → **Generate Domain**. You get `https://<name>.up.railway.app`.

## 6. Cut over from the laptop (order matters)

1. **Stop your local server first:** press Ctrl+C in the terminal running `npm --prefix server start`. If two copies poll the same bot token, Telegram rejects one with a 409.
2. Trigger the deploy, or let it run, and watch **Deploy Logs** for:
   - `mongo connected`
   - `telegram bot polling` with `"botUsername":"SmartOffersAI_Bot"`
   - `Offerly AI listening on http://0.0.0.0:<port>`
3. Verify:

   | Check | Expected |
   |---|---|
   | `https://<domain>/api/health` | `"status":"ok"`, `"db":{"status":"connected"}`, `"telegram":{"status":"polling"}` |
   | `https://<domain>/` | Sign-in page; your step 3 credentials open the dashboard |
   | Telegram: `/start` → persona → `/offer` | Linked to a synthetic customer; a validated offer arrives |
   | Dashboard → Decision log | That decision shows **Approved**, with validation passed and delivery **sent** |

4. **From now on, keep the bot off locally.** Set `TELEGRAM_MODE=off` in your local `server/.env`. Local development then never competes with the hosted bot.

## Operating it

- **Logs:** Railway → service → **Deploy Logs**. They're structured JSON, and secrets are redacted.
- **Health:** `/api/health` shows the bot status (`polling` or `failed` with a reason), AI mode and the last maintenance run.
  - It returns HTTP 503 only if the database is down.
  - A failed bot reports `degraded` but stays 200, so Railway doesn't restart-loop. The bot retries on its own.
- **Deploys:** every push to `main` redeploys. During the switch-over, the old and new instance can overlap for a few seconds. The new one may log a 409 conflict, then recovers on its own retry (30 s, doubling).
- **Rollback:** Railway → **Deployments** → choose a previous deployment → **Redeploy**.
- **Rotate a secret:** change it in Railway Variables, which redeploys.

  | Secret | How to rotate |
  |---|---|
  | `SESSION_SECRET` | Changing it signs everyone out |
  | Bot token | Revoke with BotFather `/revoke` first, then set the new one |
  | Anthropic key | Rotate in the Anthropic console |

- **Budget:** watch Railway usage and Anthropic console spend. The per-chat `/offer` cooldown and the API rate limits cap Claude calls.

## Limits of this setup

- One instance only. Rate limits and the bot are in-process by design.
- Atlas M0 is a shared free tier: fine for a demo, with no backups or SLA.
- Telegram uses long polling; webhook mode isn't implemented.
- One admin account, with no roles.
