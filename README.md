# Schbang Pulse — Backend

API + in-process monitoring engine for Schbang Pulse (uptime/health monitoring).
Node + Express + TypeScript + Mongoose, with a `node-cron` scheduler that runs the
checks **inside this process** — there is no separate worker.

Pairs with the [frontend dashboard](https://github.com/giri943/sch-pulse-frontend).

## Run locally

**Prerequisites:** Node ≥ 20 and a MongoDB instance.

```bash
cp .env.example .env     # then fill in the values below
npm install
npm run seed             # first time — creates the admin user + recommendation rules
npm run dev              # API + monitoring on http://localhost:4000
```

Seeded admin: `admin@schbang.com` / `ChangeMe123!` — change it immediately
(or set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` before seeding).

## Environment (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGODB_URI` | ✅ | — | Mongo connection string |
| `JWT_ACCESS_SECRET` | ✅ | — | ≥ 32 random chars (boot fails in prod if weak) |
| `JWT_REFRESH_SECRET` | ✅ | — | ≥ 32 random chars |
| `APP_BASE_URL` | prod | `http://localhost:3000` | **Frontend** URL — used for links in emails/chat |
| `CORS_ORIGINS` | prod | `http://localhost:3000` | Comma-separated allowed origins |
| `PORT` | | `4000` | |
| `SCHEDULER_CRON` | | `*/20 * * * * *` | Check cadence |
| `CHECK_CONCURRENCY` | | `10` | Parallel checks per tick |
| `MAIL_DRIVER` | | `smtp` | `smtp` · `ses` · `sendgrid` · `mailjet` · `brevo` · `console` |
| `MAIL_FROM` | | `alerts@schbang.com` | Verified sender |
| `GOOGLE_CLIENT_ID` | | — | Enables Google sign-in |
| `ALLOWED_EMAIL_DOMAIN` | | `schbang.com` | Restricts sign-in to this domain |

Provider keys for the chosen `MAIL_DRIVER`: `SENDGRID_API_KEY` · `MAILJET_API_KEY` +
`MAILJET_SECRET_KEY` · `BREVO_API_KEY` · `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` ·
(SES uses `AWS_REGION`). `MAIL_DRIVER=console` logs emails instead of sending.

## Deploy (Render)

- **Build:** `npm install --include=dev && npm run build` (dev deps needed for `tsc`)
- **Start:** `npm start`
- **Node:** 20+
- Set strong JWT secrets, `MONGODB_URI`, `NODE_ENV=production`, `APP_BASE_URL` =
  frontend URL, `CORS_ORIGINS` = frontend URL, and your mail provider keys.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | API + monitoring with file watch |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled |
| `npm run seed` | Create admin user + recommendation rules |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/
├─ index.ts          # bootstrap: DB, server, monitoring cron
├─ app.ts            # express app (middleware + routes)
├─ config/           # env (zod-validated), logger, database
├─ controllers/      # request handlers (*.controller.ts)
├─ models/           # mongoose schemas (*.model.ts)
├─ routes/           # express routers (*.routes.ts)
├─ middlewares/      # auth, validate, error, rateLimit
├─ services/         # monitoring (checks + scheduler), mailer, channels
├─ utils/            # ApiError, jwt, access (RBAC), constants
└─ scripts/seed.ts   # first admin + recommendation rules
```
