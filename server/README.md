# Fun & Earning — Backend

Node.js + Express + SQLite API that powers the admin/sub-admin/user
dashboards and the five-game gaming platform, plus static hosting for the
whole site — one process, no build step.

See the root [README.md](../README.md) for the full architecture overview
(games, provably-fair design, WebSocket transport, admin surface) and
[SETUP.md](../SETUP.md) for install/deploy/troubleshooting. This file is
just the backend quick-reference.

## Run it

```
cd server
npm install
npm start
```

The server listens on `http://localhost:3000` (override with `PORT`) and
also serves the site's HTML/CSS/JS from the project root, so the whole
thing runs from one process. It also upgrades `/ws/*` requests to
WebSocket connections for live game state — see
[lib/ws.js](lib/ws.js).

## First run

On first start, if no admin account exists yet, one is created automatically
and its login is printed **once** to the console:

```
================ ADMIN ACCOUNT CREATED ================
  Phone:    +91 9999999999
  Password: <randomly generated>
=========================================================
```

Save that password — it is not stored anywhere in plain text and won't be
shown again. To set a specific admin phone/password instead of a random one,
set `ADMIN_PHONE` and `ADMIN_PASSWORD` env vars before the first run.

Admins and sub-admins sign in at `/admin-login.html` — admins land on
`/admin-dashboard.html`, sub-admins (created by the admin) land on
`/subadmin-dashboard.html`. Regular users register/sign in at `/login.html`
and land on `/user-dashboard.html`.

## Data

Everything is stored in `server/data.sqlite` (auto-created, gitignored,
WAL mode). A `JWT_SECRET` is auto-generated into `server/.env` (also
gitignored) on first run and reused after that.

## Layout

```
server/
├── index.js            Express app + HTTP server + WebSocket upgrade wiring, starts every game engine
├── db.js                Schema, idempotent migrations, seed data (admin account, games catalog)
├── middleware/auth.js    JWT verification + role gating (authenticate, requireRole)
├── routes/
│   ├── auth.js           Register / login (admin, sub-admin, user all share this)
│   ├── admin.js           Sub-admin CRUD, wallet mint/transfer, deposit/payment approvals, platform-wide user directory + adjustments, per-game admin mounts
│   ├── subadmin.js        Own deposit/payment requests, own users (search/lock/detail), user deposit/withdrawal approvals, support replies, dashboard stats
│   ├── user.js            Profile, payment methods, deposits/withdrawals, support
│   └── games.js            Game catalog listing + mounts each game's own router
├── lib/
│   ├── wallet.js           Idempotent debit/credit for game bets, keyed so retries can never double-apply
│   ├── provablyFair.js     Shared HMAC seed-chain primitives every game's result derives from
│   ├── ws.js                Per-game WebSocket namespaces, broadcast-only (never accepts bet placement)
│   ├── gameConfig.js        Versioned, audited per-game configuration
│   ├── gameAdmin.js         Generic admin router factory (Dashboard/Rounds/Bets/Settlements/Config/Provably Fair/Bots/Audit Logs/Health) every game mounts
│   └── errors.js            GameError — user-facing 4xx errors distinct from unhandled 500s
└── games/<slug>/
    ├── engine.js           Round lifecycle, result generation, settlement, bet validation (all game-specific)
    ├── routes.js           REST endpoints: state, bet, verify
    ├── admin.js             Wires engine + bots into the shared gameAdmin router
    └── bots.js              This game's system-account pool; never touches wallet_balance or sees a result before it's generated
```

## What's implemented

- **Admin**: create / delete / lock / unlock sub-admins, change their
  passwords, mint tokens into own wallet, transfer tokens to any active
  sub-admin, approve/reject sub-admin deposit requests and payment-detail
  requests, platform-wide user directory (search/filter, lock/unlock,
  audited manual balance adjustments), sub-admin performance monitoring,
  full per-game admin (rounds, bets, settlements, versioned config,
  provably-fair round data, bot management, audit logs, health)
- **Sub-admin**: request deposits from the admin, submit payment details for
  admin approval (once approved, these become the "pay in" methods shown to
  their users), search/view/lock/unlock their own users and change their
  passwords, approve/reject their users' deposit and withdrawal requests,
  reply to user support messages, dashboard stats scoped to their own users
- **User**: self-register (auto-assigned to the least-loaded active
  sub-admin), view profile, view wallet balance, see sub-admin's approved
  payment methods, submit deposit/withdrawal requests, message their
  sub-admin for support, play all five games with live WebSocket updates
  and provably-fair verification

## User wallet flow

- Deposits: user requests a deposit → sub-admin approves → wallet credited.
- Withdrawals: the requested amount is deducted immediately when the user
  submits the request (held); if the sub-admin rejects it, the amount is
  refunded; if approved, the deduction stands.
- Game bets/wins: handled independently per game via
  [lib/wallet.js](lib/wallet.js) — every movement is idempotent and logged
  to `game_wallet_ledger` in addition to the balance update.
