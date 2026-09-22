# StakeBet — Backend Edition

A real, shared, server-backed sportsbook. This replaces the earlier
localStorage-only prototype: every visitor now hits the same Node.js server,
the same live-match engine, and the same SQLite database, so balances, bets,
and the live board are identical for everyone and survive page reloads and
server restarts.

## What's inside

- **Zero external dependencies.** Everything runs on Node's own built-in
  modules: `node:http` (server + routing), `node:sqlite` (database),
  `node:crypto` (password hashing + auth tokens). Nothing to `npm install`.
- **Real persistence.** All users, matches, bets, transactions, and activity
  live in a SQLite file at `./data/stakebet.sqlite`. Stop and restart the
  server and everything is exactly as you left it.
- **One shared live-match engine.** A single server-side loop (every 3s)
  advances every live match's clock and score, re-prices markets, settles
  bets the instant a match ends, and keeps every sport's board topped up
  with fresh fixtures so it never runs dry.
- **Server-authoritative betting.** Odds shown in the browser are for
  display only — every bet is re-priced and re-validated against the live
  match state at the exact moment it's placed, so there's no way to bet on
  stale or already-decided odds.
- **Auth, wallet, bets, admin.** Signup with an email verification code
  (shown directly on-screen since there's no real mail server), login,
  session tokens, deposit/withdraw, single & parlay bets, transaction and
  activity history, and an admin dashboard (any email containing "admin",
  e.g. `admin@example.com`) showing platform-wide totals and every bet from
  every user.

## Requirements

- **Node.js ≥ 22.5.0** — required for the built-in `node:sqlite` module.
  Check with `node -v`; upgrade if needed (e.g. via [nvm](https://github.com/nvm-sh/nvm)).

## Running it

```bash
node server.js
# or: npm start
```

Then open **http://localhost:8787**. The server listens on port `8787` by
default.

### Environment variables (all optional)

| Variable         | Default              | Purpose                                       |
|------------------|----------------------|------------------------------------------------|
| `PORT`           | `8787`               | HTTP port to listen on                        |
| `DATA_DIR`       | `./data`             | Where the SQLite file & session secret live   |
| `SESSION_SECRET` | auto-generated       | HMAC key for signing auth tokens. If unset, one is generated once and saved to `data/.session-secret` — set this explicitly in production so tokens survive a fresh checkout. |

## Deploying it somewhere permanent

Any host that runs a plain Node.js process works — this app has no build
step and no database server to provision separately (SQLite is just a file).

- **Render / Railway / Fly.io**: create a new Node service, point it at this
  folder, set the start command to `node server.js`, and attach a small
  persistent volume mounted at `./data` (otherwise the database resets on
  every redeploy). Set `SESSION_SECRET` to a random string in the service's
  environment variables.
- **A plain VPS**: `git clone`/upload the folder, run `node server.js`
  under a process manager such as `pm2` or a `systemd` unit so it restarts
  on crash/reboot, and put it behind a reverse proxy (nginx/Caddy) for TLS.
- Make sure whatever host you pick has **Node ≥ 22.5** installed.

## What's intentionally trimmed vs. the earlier prototype

To keep this a clean, dependency-free build, the scope was narrowed a bit:

- Fewer leagues per sport (Premier League/La Liga/Serie A for football, NBA,
  ATP 1000, NFL) — more can be added by extending the `TEAMS` object in
  `engine.js`.
- Markets kept: 1X2 / Over-Under / BTTS / Double Chance / Asian Handicap
  (football), Moneyline / Over-Under (tennis), Moneyline / Spread /
  Over-Under (basketball & NFL). Dropped: half-time markets, both-teams-to-
  score-in-both-halves, live chat, and venue/standings pages.
- Email verification is simulated — the code is returned directly in the API
  response and shown on-screen, since there's no outbound mail server.
  Wiring up a real provider (SendGrid, Postfix, etc.) is a drop-in swap in
  `routes.js`'s signup handler.

## Project layout

```
server.js      HTTP server, static file serving, CORS, request routing
routes.js      All /api/* route handlers (auth, matches, bets, wallet, admin)
engine.js      Match simulation, odds pricing, and the live-board scheduler
db.js          SQLite schema + connection (node:sqlite)
auth.js        Password hashing and signed session tokens
public/        The frontend (single index.html — no build step)
data/          Created automatically at first run: the SQLite DB + session secret
e2e_test.js    Playwright script: signup → bet → reload persistence
e2e_test2.js   Playwright script: admin dashboard, all sport boards, parlay bet
```

## Test accounts

There are none seeded — sign up with any email. Use an email containing
`admin` (e.g. `admin@stakebet.com`) to get the admin dashboard. Every new
account starts with a **$250 welcome bonus**.
