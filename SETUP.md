# Setup Guide

## Prerequisites

- **Node.js 18 or later** (check with `node -v`). `better-sqlite3` installs a
  prebuilt native binary for your platform/Node version — if install fails,
  see [Troubleshooting](#troubleshooting).
- npm (bundled with Node).
- No database server, no Redis, no external services required — everything
  runs from a single SQLite file.

## Install

```bash
cd server
npm install
```

This installs Express, `better-sqlite3`, `bcryptjs`, `jsonwebtoken`,
`dotenv`, and `ws`.

## Run

```bash
npm start
```

The server listens on `http://localhost:3000` by default and serves both the
API (`/api/*`) and the static frontend (everything outside `server/`) from
one process — there's nothing else to start.

## First run

On the very first start, if no admin account exists yet, one is created
automatically and its credentials are printed **once**:

```
================ ADMIN ACCOUNT CREATED ================
  Phone:    +91 9999999999
  Password: <randomly generated>
  Save this password now — it will not be shown again.
=========================================================
```

Copy that password immediately — it's hashed on save and never shown again.
If you lose it, delete `server/data.sqlite*` and restart to reseed (this
wipes all data — see [Resetting the database](#resetting-the-database) for a
less destructive option), or set `ADMIN_PHONE`/`ADMIN_PASSWORD` (below) and
restart with a fresh database.

Sign in at `/admin-login.html`. This same page is used by both admins and
sub-admins — the server routes each to the right dashboard after login.
Regular users register at `/login.html`.

## Environment variables

All optional — sensible defaults apply if unset. Set them in
`server/.env` (auto-created for `JWT_SECRET` if missing) or in your shell.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port. |
| `JWT_SECRET` | auto-generated on first run | 32-byte random hex, written to `server/.env` and reused after that. Never commit this file. |
| `ADMIN_PHONE` | `9999999999` | Only used the very first time the admin account is seeded. |
| `ADMIN_PASSWORD` | random | Only used the very first time the admin account is seeded. Set this if you don't want a random password printed to the console. |
| `DEFAULT_SUBADMIN_PHONE` | `9000000001` | Only used the very first time the default "subadmin" account is seeded (every newly registered user is assigned to this account by default — see [README.md](README.md)). |
| `DEFAULT_SUBADMIN_PASSWORD` | random | Only used the very first time the default subadmin is seeded. Set this if you don't want a random password printed to the console. |
| `SMTP_HOST` | unset | SMTP server hostname. Required for OTP emails (registration verification, forgot-password) to actually send — see [Email (OTP) delivery](#email-otp-delivery) below. |
| `SMTP_PORT` | `587` | SMTP port. `465` is treated as implicit TLS; anything else uses STARTTLS. |
| `SMTP_USERNAME` | unset | SMTP auth username. |
| `SMTP_PASSWORD` | unset | SMTP auth password. Never commit this — set it in `server/.env` or your host's secret manager. |
| `SMTP_FROM_EMAIL` | `SMTP_USERNAME` | "From" address on outgoing emails. |
| `SMTP_FROM_NAME` | `Fun & Earning` | "From" display name on outgoing emails. |
| `NODE_ENV` | unset | Set to `production` to stop OTP codes from being printed to the console (see below) once real SMTP delivery is confirmed working. |

### Email (OTP) delivery

Registration verification and "Forgot password" OTPs are sent by email via
[Nodemailer](https://nodemailer.com/) (`server/lib/mailer.js`) — the
standard SMTP client for Node, this project had no email system before this
feature. Point it at any SMTP provider (Gmail app password, SendGrid,
Mailgun, Amazon SES, your own mail server, etc.) via the `SMTP_*` variables
above; nothing else needs to change regardless of provider.

**Without `SMTP_HOST`/`SMTP_USERNAME`/`SMTP_PASSWORD` set**, emails are not
sent at all (logged as a warning once) — the OTP is still printed to the
server console (`[OTP] password_reset code for user@example.com: 123456`)
as long as `NODE_ENV` isn't `production`, so the flow is fully testable
without any SMTP configuration. **In production** (`NODE_ENV=production`),
OTP codes are never printed to the console, matching the "never log OTPs in
production" requirement — configure real SMTP before setting `NODE_ENV=production`,
or users simply won't be able to complete email verification or password
reset.

Password reset specifically requires a **verified** email — an account with
no email, or an unverified one, can't use "Forgot password" until it
verifies one from its Profile page (or, for admin/sub-admin, from their
Overview tab's "Your Email Address" card).

`server/.env` is gitignored and excluded from any distributable archive of
this project — treat `JWT_SECRET` as a real secret: rotating it invalidates
every existing login session.

## First-run walkthrough

The wallet chain requires a few steps before a user can actually place a
bet — there's no "give everyone free tokens" shortcut by design, mirroring
how a real deposit chain would work.

1. **Log in as admin** at `/admin-login.html` with the credentials printed
   on first run.
2. **Create a sub-admin** — Sub-Admins tab → fill in name/phone/password →
   Create Sub-Admin.
3. **Fund your own admin wallet** — Overview tab → "Add Tokens to Own
   Wallet". This mints new tokens; it's the only place tokens are created
   from nothing.
4. **Transfer tokens to the sub-admin** — Overview tab → "Transfer To
   Sub-Admin" → pick the sub-admin you just created → amount.
5. **Register a user** at `/login.html?tab=register`. New users are
   auto-assigned to the least-loaded *active* sub-admin — registration
   fails with a 503 until at least one active sub-admin exists, which is
   why step 2 comes first.
6. **Log in as the sub-admin** at `/admin-login.html`, go to **User
   Deposits**, and approve the pending request once the user submits one
   (or have the user submit a deposit request from their Wallet tab first,
   referencing whatever payment method the sub-admin has on file — for
   local testing you can approve a deposit note-only, no real payment
   integration exists).
7. **Log in as the user** at `/login.html`, open the **Games** tab, and
   play. Wallet balance updates live as bets are placed and settled.

For local/dev iteration, it's often faster to top up a test user's balance
directly via a one-off script rather than walking the full deposit chain
every time:

```bash
cd server
node -e "require('./db').prepare(\"UPDATE users SET wallet_balance = 5000 WHERE phone = '9876543210'\").run()"
```

Only do this against a local dev database — never against anything with
real money semantics.

## Configuring games

Each game's payouts, timing, and limits are stored in a versioned
`game_config` table, editable from **Admin → Games → (pick a game) →
Configuration**. Saving inserts a new version rather than mutating the
active one, so the full history of changes (and who made them, from
`game_audit_logs`) is preserved. Changes take effect on the *next* round —
a round already in progress or already resolved can never be altered.

Per-game defaults live in each `server/games/<slug>/engine.js` as the
`DEFAULTS` export, used until an admin overrides them.

## Database

- Engine: SQLite via `better-sqlite3`, WAL mode.
- File: `server/data.sqlite` (plus `-wal`/`-shm` sidecar files while the
  server is running). Auto-created on first start; schema and migrations
  live in [server/db.js](server/db.js) and run idempotently every startup.
- No separate migration tool — `db.js` uses `CREATE TABLE IF NOT EXISTS` and
  a couple of one-time, guarded `ALTER TABLE`/rename steps for older schema
  versions, so upgrading is just "replace the code and restart."

### Backing up

Stop the server, then copy all three files together (a WAL-mode SQLite
database isn't fully represented by the main file alone while pending
writes sit in the WAL):

```bash
cp server/data.sqlite server/data.sqlite-wal server/data.sqlite-shm /path/to/backup/
```

### Resetting the database

To start over without touching game/account code, stop the server and
delete the three files above (`data.sqlite`, `-wal`, `-shm`) — the next
start reseeds the schema, the five games' catalog rows, and a fresh admin
account.

## Production deployment notes

This ships as a plain Node process — pick whatever process manager and
reverse proxy you're already using. A few things specific to this app:

- **Process manager**: use `pm2`, `systemd`, or similar to keep `node
  server/index.js` running and restart it on crash. A restart mid-round is
  handled gracefully — each game engine refunds any bet left "pending" from
  a round that no longer exists in memory (see `start()` in each
  `engine.js`).
- **Reverse proxy / TLS**: put this behind Nginx/Caddy for HTTPS. WebSocket
  upgrade requests (`/ws/*`) need to be proxied too — for Nginx that means
  `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection
  "upgrade";` on the relevant `location` block. The frontend auto-detects
  `wss://` vs `ws://` from `window.location.protocol`, so no frontend
  config is needed once TLS is terminated correctly upstream.
- **JWT_SECRET**: set this explicitly in production rather than relying on
  the auto-generated `server/.env` — if that file is ever lost, every user
  is logged out and admin/sub-admin sessions all need to re-authenticate.
- **Single-process design**: game engines keep authoritative round state
  in-memory (not just in SQLite) and broadcast over in-process WebSocket
  pub/sub. This app is built to run as **one Node process** — it does not
  support horizontal scaling across multiple instances without further work
  (you'd need to move round state and WS pub/sub to something shared like
  Redis first).
- **Backups**: SQLite is a single file; schedule regular backups per
  [Backing up](#backing-up) above, especially before any deploy that
  touches `server/db.js`.

## Troubleshooting

**`better-sqlite3` fails to install / build.** It ships prebuilt binaries
for common platforms; if none match, npm falls back to compiling from
source, which needs Python + a C++ toolchain. On Windows, installing the
"Desktop development with C++" workload from Visual Studio Build Tools
usually fixes this. Re-run `npm install` after.

**Registration returns "Registration is temporarily unavailable" (503).**
No *active* sub-admin exists yet — see step 2 of the
[walkthrough](#first-run-walkthrough) above.

**Admin password lost.** It's bcrypt-hashed in the database and cannot be
recovered. Either set `ADMIN_PASSWORD` and reset the database (destructive,
see [Resetting the database](#resetting-the-database)), or have an existing
admin... there's only ever one seeded admin account by default — if you're
fully locked out, resetting the database is the only path.

**WebSocket shows "Reconnecting…" and games feel laggy.** Each game
frontend falls back to HTTP polling automatically when the socket is down,
so gameplay still works, just less smoothly. Check that your reverse proxy
(if any) is forwarding the `Upgrade`/`Connection` headers for `/ws/*` paths.

**Port already in use.** Set `PORT=3001` (or any free port) before
`npm start`.
