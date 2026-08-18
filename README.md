# Fun & Earning

A token-based gaming platform with a three-tier account system (Admin →
Sub-Admin → User), a shared wallet/ledger, and five independently-built,
provably-fair real-time games.

Node.js + Express backend, SQLite storage (via `better-sqlite3`), WebSockets
for live game state, and a plain HTML/CSS/JS frontend — no build step, no
framework, one process serves both the API and the static site.

**New here?** Jump straight to [SETUP.md](SETUP.md) for install and first-run
instructions. This file is the map of what exists and how it fits together.

## Roles

| Role | Signs in at | Can do |
|---|---|---|
| **Admin** | `/admin-login.html` | Create/lock/delete sub-admins, mint tokens, transfer tokens to sub-admins, approve/reject sub-admin deposit & payment-method requests, full platform-wide user directory (search, lock/unlock, audited balance adjustments), sub-admin performance monitoring, full games admin (rounds, bets, config, provably-fair, bots, audit logs, health) |
| **Sub-Admin** | `/admin-login.html` | Request deposits from the admin, submit payment methods for approval, manage their own assigned users (search, lock/unlock, password reset), approve/reject their users' deposit & withdrawal requests, reply to support messages, dashboard stats for their own scope |
| **User** | `/login.html` | Register, deposit/withdraw tokens (via their assigned sub-admin), play all five games, message support, view their own profile/wallet |

Every newly registered user is assigned to a single seeded default sub-admin
account (display name `subadmin`, phone/password configurable via
`DEFAULT_SUBADMIN_PHONE`/`DEFAULT_SUBADMIN_PASSWORD` — see
[SETUP.md](SETUP.md)) rather than being load-balanced across sub-admins. An
admin can move any user to a different sub-admin from the Users tab
(`POST /api/admin/users/:id/transfer`). If the default sub-admin is ever
locked or missing, registration falls back to the least-loaded active
sub-admin so new signups don't hard-fail.

## Email: verification and password reset (OTP)

Every user provides an email address at registration (`email` on `users`,
alongside `email_verified`/`email_verified_at`); existing accounts from
before this feature keep working with no email at all, and are prompted to
add one from their Profile page (Overview tab, for admin/sub-admin).
Registration automatically sends a 6-digit verification OTP to that email.

Both `/login.html` and `/admin-login.html` have a "Forgot password?" flow:
enter your registered, **verified** email address (never phone or username
alone), receive a 6-digit OTP, verify it, then set a new password. An
account with no email, or an unverified one, cannot use this flow until it
verifies an email first.

Email verification and password-reset OTPs share one mechanism
([server/lib/otp.js](server/lib/otp.js), the `otp_verifications` table) so
there's a single hashing/expiry/attempt/single-use implementation instead of
two: bcrypt-hashed at rest, expire after 5 minutes, allow 5 verification
attempts, a 60-second resend cooldown plus a 5-per-hour cap per account, and
an IP-level rate limit ([server/lib/rateLimit.js](server/lib/rateLimit.js))
on top. A successful OTP verification issues a short-lived signed token
that's required (and single-use) to actually change the password — see the
`/api/auth/forgot-password`, `/verify-reset-otp`, `/reset-password` routes
in [server/routes/auth.js](server/routes/auth.js), and the email
add/verify/change endpoints under `/api/account/email*` in
[server/routes/account.js](server/routes/account.js) (shared by all three
roles, since each authenticates against the same `users` table and each
needs to be able to add their own recovery email).

**Delivery** goes through SMTP via [Nodemailer](https://nodemailer.com/) —
see [SETUP.md](SETUP.md#email-otp-delivery) for the `SMTP_*` environment
variables. Without SMTP configured, the OTP is instead printed to the
server console (never in production — see `NODE_ENV` in SETUP.md) so the
flow stays fully testable without any mail server.

## File uploads

Deposit requests require a payment screenshot, and support messages can
optionally include one. Both go through the same utility,
[server/lib/uploads.js](server/lib/uploads.js): every upload is size-checked
(5MB), and validated against its actual bytes (not the client-declared MIME
type or file extension) against a JPG/PNG/WebP allowlist before being
written to disk under a randomly generated filename in `server/uploads/`
(outside the static frontend root, so nothing there is ever served
directly). Screenshots/attachments are only readable through authenticated,
authorization-checked routes scoped to the deposit's/message's owner (or
their sub-admin/admin) — e.g. `GET /api/user/deposits/:id/screenshot` — so a
user can't view another user's proof of payment by guessing an ID.

## Wallet flow

Tokens only ever move along one chain: **Admin mints → transfers to a
Sub-Admin's float → Sub-Admin approves a User's deposit request out of that
float**. Withdrawals mirror this in reverse. Game wins/losses move tokens
between a User and the house via the game wallet ledger — see
[server/lib/wallet.js](server/lib/wallet.js). Every game-driven wallet
movement is idempotent (keyed so a retried/duplicated request can never
double-apply) and recorded in `game_wallet_ledger` in addition to the balance
update itself.

## Games

Each game is a fully separate module under `server/games/<slug>/` — its own
round engine, bet validation, settlement logic, provably-fair result
generation, bot service, and admin routes. Nothing is a generic
`GameEngine(type)`; only cross-cutting infrastructure (wallet ledger, seed
math, WebSocket transport, config/audit plumbing) is shared, in
`server/lib/`.

| Game | Identifier | Markets | Frontend module |
|---|---|---|---|
| **Aviator** | `aviator` | Crash multiplier — multi-bet, manual + auto cash-out | [games/aviator.js](games/aviator.js) |
| **Number Prediction** | `number_prediction` | 0–9 single number, Odd/Even, Small/Big | [games/number-prediction.js](games/number-prediction.js) |
| **Andar Bahar** | `andar_bahar` | Andar / Bahar (52-card deck, rank match vs. a reference card) | [games/andar-bahar.js](games/andar-bahar.js) |
| **Dice Roll** | `dice_roll` | Exact face (1–6), Low/High, Odd/Even | [games/dice-roll.js](games/dice-roll.js) |
| **Coin Flip** | `coin_flip` | Heads / Tails | [games/coin-flip.js](games/coin-flip.js) |

### Provably fair

Every game commits a SHA-256 hash of its server seed before betting closes,
combines it with a client seed and a round nonce via HMAC-SHA256 to derive
the result, and reveals the server seed once the round resolves. Each game's
frontend has a "Provably Fair Verification" panel where a player can paste
the revealed seed and independently recompute the same result the server
produced. Shared primitives live in
[server/lib/provablyFair.js](server/lib/provablyFair.js); each game maps the
same underlying random float/int differently (crash multiplier, 0–9 draw,
die face, coin face, or a full deterministic deck shuffle for Andar Bahar).

### Real-time transport

Each game has its own WebSocket namespace (`/ws/aviator`, `/ws/dice-roll`,
etc. — see [server/lib/ws.js](server/lib/ws.js)) that broadcasts round
lifecycle events (`ROUND_CREATED`, `BETTING_OPEN`, `BET_PLACED`,
`BETTING_CLOSED`, `RESULT_REVEALED`, `BET_SETTLED`, `ROUND_COMPLETED`, plus
game-specific events like `MULTIPLIER_UPDATE` or `ANDAR_CARD`). The socket
connection is read-only broadcast; every bet-placing action still goes
through an authenticated REST endpoint, so a forged or missing WS token can
never place a bet or move a wallet balance. If the socket drops, each game's
frontend module falls back to polling and auto-reconnects.

### Bots

Every game has its own pool of system accounts (`AVIATOR_BOT_001`, etc.)
that place bets during the betting window purely to keep the live-activity
feed populated. They're created *before* a round's result is generated, have
no `user_id`, never touch `game_wallet_ledger` or a real wallet balance, and
are the only thing capable of creating a bot-owned row in `game_bets`. An
admin can disable individual bot accounts per game.

## Admin surface

Every game exposes an identical admin API + UI: **Dashboard, Rounds, Bets,
Settlements, Configuration, Provably Fair, Bots, Audit Logs, Health** — see
[server/lib/gameAdmin.js](server/lib/gameAdmin.js) for the shared router
factory and [admin-games.js](admin-games.js) for the frontend. Configuration
changes are versioned (every change inserts a new row rather than mutating
in place) and audited with the admin's identity — there is no endpoint that
can alter an already-generated or already-resolved round's outcome, only
settings that apply going forward.

The platform-wide **Users** tab ([admin-users.js](admin-users.js)) lets an
admin search every user regardless of which sub-admin manages them, drill
into a user's deposit/withdrawal history, game wallet ledger, and recent
bets, lock/unlock them directly, and apply an audited manual balance
adjustment (always requires a reason, can never take a balance negative).
The **Sub-Admins** tab additionally shows a performance table (users
managed, deposit/withdrawal volume and turnaround time) per sub-admin.

## Project layout

```
funandearning/
├── index.html, login.html, *-dashboard.html   Frontend pages (no build step)
├── games.js, games.css                        Game lobby (search/category/favorites) + shared game UI
├── games/<slug>.js                             One frontend module per game
├── admin-*.js                                  Admin dashboard logic (users, games, core)
├── subadmin-dashboard.js                       Sub-admin dashboard logic
└── server/
    ├── index.js                                Express app + HTTP server + WebSocket upgrade wiring
    ├── db.js                                    SQLite schema, migrations, seed data
    ├── middleware/auth.js                       JWT auth + role gating
    ├── routes/                                  auth, admin, subadmin, user, games (catalog)
    ├── lib/                                     wallet ledger, provably-fair, ws, game config/audit, generic game admin router
    └── games/<slug>/                            engine.js, routes.js, admin.js, bots.js — per game
```

## Quick start

```bash
cd server
npm install
npm start
```

Full details, environment variables, and a first-run walkthrough (creating a
sub-admin, funding a user, and playing a game) are in
[SETUP.md](SETUP.md).
