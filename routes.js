'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const engine = require('./engine');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');

const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const fmt = (n) => '$' + Number(n).toFixed(2);

const STAKE_LIMITS = {
  min: 0.10, maxOddsSingle: 350, maxSinglePayout: 1000, maxParlayPayout: 25000,
  tiers: [{ maxOdds: 100, maxStake: 10 }, { maxOdds: 150, maxStake: 5 }, { maxOdds: 350, maxStake: 1 }],
};
function maxStakeForOdds(o) {
  if (o <= 1) return STAKE_LIMITS.maxSinglePayout;
  const tier = STAKE_LIMITS.tiers.find((t) => o <= t.maxOdds) || STAKE_LIMITS.tiers[STAKE_LIMITS.tiers.length - 1];
  return Math.max(STAKE_LIMITS.min, Math.min(tier.maxStake, STAKE_LIMITS.maxSinglePayout / o));
}

function isAdminEmail(em) { return em === 'demo@stakebet.com' || em.includes('admin'); }

function addTx(userId, type, label, amount, extra) {
  const id = uid('t');
  db.prepare('INSERT INTO transactions (id, user_id, type, label, amount, status, created_at, extra) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, type, label, amount, 'completed', now(), extra ? JSON.stringify(extra) : null);
  return id;
}
function addActivity(userId, msg, meta) {
  db.prepare('INSERT INTO activity (id, user_id, msg, meta, created_at) VALUES (?,?,?,?,?)')
    .run(uid('a'), userId, msg, meta || '', now());
}
function bumpPlatform(key, amount) {
  db.prepare('UPDATE platform SET value = value + ? WHERE key = ?').run(amount, key);
}
function creditUser(userId, amount) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
}
function getUserRow(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function publicUser(row) {
  return {
    id: row.id, email: row.email, name: row.name, country: row.country, joined: row.joined_at,
    isAdmin: !!row.is_admin, balance: row.balance, oddsFormat: row.odds_format,
    limits: { deposit: row.deposit_limit, loss: row.loss_limit },
  };
}

// ---------- settlement (server-authoritative — runs from the engine tick) ----------
function legResult(leg, m) {
  const [h, a] = m.score;
  if (leg.mkt === '1X2' || leg.mkt === 'ML') {
    const w = h > a ? '1' : (h < a ? '2' : 'X');
    return leg.selK === w ? 'won' : (w === 'X' && leg.mkt === 'ML' ? 'void' : 'lost');
  }
  if (leg.mkt === 'BTTS') { const y = h > 0 && a > 0; return (leg.selK === 'Y') === y ? 'won' : 'lost'; }
  if (leg.mkt === 'OU') {
    const line = leg.line ?? 2.5;
    const tot = m.sport === 'tennis' ? (m.games[0] + m.games[1] + (m.sets[0] + m.sets[1]) * 6) : h + a;
    if (tot === line) return 'void';
    return (leg.selK === 'O') === (tot > line) ? 'won' : 'lost';
  }
  if (leg.mkt === 'SP') {
    const sp = leg.line ?? 0;
    const marg = (h + sp) - a;
    if (Math.abs(marg) < 0.01) return 'void';
    return (leg.selK === '1') === (marg > 0) ? 'won' : 'lost';
  }
  if (leg.mkt === 'DC') {
    const w = h > a ? '1' : (h < a ? '2' : 'X');
    const map = { '1X': ['1', 'X'], '12': ['1', '2'], 'X2': ['X', '2'] };
    return map[leg.selK].includes(w) ? 'won' : 'lost';
  }
  if (leg.mkt === 'AH') {
    const line = leg.line ?? 0;
    const adj = leg.selK === '1' ? (h + line) - a : (a - line) - h;
    if (Math.abs(adj) < 0.01) return 'void';
    return adj > 0 ? 'won' : 'lost';
  }
  return 'void';
}
function settleMatch(m) {
  const openBets = db.prepare("SELECT * FROM bets WHERE status = 'open'").all();
  for (const row of openBets) {
    const legs = JSON.parse(row.legs);
    let touched = false, anyOpen = false, allWon = true, voidCount = 0;
    for (const leg of legs) {
      if (leg.matchId === m.id && !leg.result) { leg.result = legResult(leg, m); touched = true; }
      if (!leg.result) { anyOpen = true; continue; }
      if (leg.result === 'lost') allWon = false;
      if (leg.result === 'void') voidCount++;
    }
    if (!touched) continue;
    if (anyOpen && allWon) { db.prepare('UPDATE bets SET legs = ? WHERE id = ?').run(JSON.stringify(legs), row.id); continue; }
    if (!allWon) {
      db.prepare("UPDATE bets SET legs = ?, status = 'lost', returned = 0 WHERE id = ?").run(JSON.stringify(legs), row.id);
      addActivity(row.user_id, 'Bet lost', '-' + fmt(row.stake));
      continue;
    }
    if (anyOpen) { db.prepare('UPDATE bets SET legs = ? WHERE id = ?').run(JSON.stringify(legs), row.id); continue; }
    let od = 1; legs.forEach((l) => { od *= l.result === 'void' ? 1 : l.odds; });
    const status = voidCount === legs.length ? 'void' : 'won';
    const returned = +(row.stake * od).toFixed(2);
    db.prepare('UPDATE bets SET legs = ?, status = ?, returned = ? WHERE id = ?').run(JSON.stringify(legs), status, returned, row.id);
    creditUser(row.user_id, returned);
    addTx(row.user_id, status === 'void' ? 'refund' : 'payout', status === 'void' ? 'Stake returned — ' + legs[0].matchName : 'Winnings — ' + legs[0].matchName, returned);
    if (status === 'won') bumpPlatform('payout', returned);
    addActivity(row.user_id, status === 'void' ? 'Bet voided, stake returned' : 'Bet won', (status === 'void' ? '+' : '+') + fmt(returned));
  }
}
function startEngine() { engine.startEngine(settleMatch); }

// ---------- auth middleware ----------
function requireAuth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return null;
  const user = getUserRow(payload.uid);
  return user || null;
}

// ---------- route table ----------
// Each handler: (req, res, params, body) -> sends the response itself.
const verificationStore = new Map(); // email -> {code, expiresAt, attempts, payload}

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const parts = pattern.split('/').filter(Boolean);
  routes.push({ method, parts, handler, auth: !!opts.auth, admin: !!opts.admin });
}

route('POST', '/api/auth/signup', (req, res, p, body) => {
  const { name, email, password, country, dob } = body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!name || !em || !password || password.length < 8) return json(res, 400, { error: 'Missing or invalid fields (password needs 8+ characters).' });
  const age = dob ? (now() - new Date(dob).getTime()) / (365.25 * 864e5) : 0;
  if (!dob || age < 18) return json(res, 400, { error: 'You must be 18 or older to open an account.' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (existing) return json(res, 409, { error: 'An account with this email already exists. Log in instead.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  verificationStore.set(em, {
    code, expiresAt: now() + 10 * 60000, attempts: 0,
    payload: { name, email: em, passwordHash: hashPassword(password), country: country || 'Other' },
  });
  // No real mail server in this demo backend — the code is returned directly,
  // the same "demo inbox" approach the original prototype used.
  json(res, 200, { email: em, devCode: code, message: 'Verification code issued (demo mode — no real email is sent).' });
});

route('POST', '/api/auth/verify', (req, res, p, body) => {
  const em = String(body?.email || '').trim().toLowerCase();
  const code = String(body?.code || '');
  const pending = verificationStore.get(em);
  if (!pending) return json(res, 400, { error: 'No pending verification for this email. Start again.' });
  if (now() > pending.expiresAt) return json(res, 400, { error: 'This code has expired. Request a new one.' });
  if (code !== pending.code) {
    pending.attempts++;
    if (pending.attempts >= 5) { verificationStore.delete(em); return json(res, 400, { error: 'Too many wrong attempts. Request a new code.' }); }
    return json(res, 400, { error: `That code is incorrect (${5 - pending.attempts} attempts left).` });
  }
  verificationStore.delete(em);
  const id = uid('u');
  const isAdmin = isAdminEmail(em) ? 1 : 0;
  db.prepare(`INSERT INTO users (id, email, name, password_hash, country, joined_at, verified, is_admin, balance)
    VALUES (?,?,?,?,?,?,1,?,0)`).run(id, em, pending.payload.name, pending.payload.passwordHash, pending.payload.country, now(), isAdmin);
  addTx(id, 'deposit', 'Welcome bonus credit', 250, {});
  creditUser(id, 250);
  addActivity(id, 'Account created and verified');
  const user = getUserRow(id);
  json(res, 200, { token: signToken({ uid: id }), user: publicUser(user) });
});

route('POST', '/api/auth/login', (req, res, p, body) => {
  const em = String(body?.email || '').trim().toLowerCase();
  const pw = String(body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  if (!user || !verifyPassword(pw, user.password_hash)) return json(res, 401, { error: 'Email or password is incorrect.' });
  if (user.lock_until && now() < user.lock_until) return json(res, 403, { error: 'This account is on a break until ' + new Date(user.lock_until).toISOString() });
  addActivity(user.id, 'Account signed in');
  json(res, 200, { token: signToken({ uid: user.id }), user: publicUser(user) });
});

route('GET', '/api/me', (req, res) => json(res, 200, { user: publicUser(req.user) }), { auth: true });

route('PATCH', '/api/me', (req, res, p, body) => {
  if (body.oddsFormat) db.prepare('UPDATE users SET odds_format = ? WHERE id = ?').run(body.oddsFormat, req.user.id);
  if (body.limits) db.prepare('UPDATE users SET deposit_limit = ?, loss_limit = ? WHERE id = ?').run(+body.limits.deposit || 0, +body.limits.loss || 0, req.user.id);
  json(res, 200, { user: publicUser(getUserRow(req.user.id)) });
}, { auth: true });

route('GET', '/api/matches', (req, res, p, body, query) => {
  const list = engine.listMatches({ sport: query.sport || undefined, ended: false });
  json(res, 200, { matches: list });
}, { auth: true });

route('GET', '/api/matches/:id', (req, res, p) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  json(res, 200, { match: m });
}, { auth: true });

function validateLeg(input) {
  const m = engine.getMatch(input.matchId);
  if (!m || m.ended) return { error: (input.selName || 'Selection') + ' is no longer available.' };
  if (engine.isSuspended(m)) return { error: m.home + ' v ' + m.away + ' is temporarily suspended — try again in a moment.' };
  const market = m.markets[input.mkt];
  if (!market) return { error: 'Unknown market.' };
  if (market.closed) return { error: 'That market is closed — the outcome is already decided.' };
  const sel = market.sel.find((s) => s.k === input.selK);
  if (!sel) return { error: 'Unknown selection.' };
  return {
    leg: {
      matchId: m.id, mkt: input.mkt, selK: input.selK, odds: sel.o, selName: sel.n,
      mktLabel: market.label, matchName: m.home + ' v ' + m.away, sport: m.sport,
      line: market.line ?? null,
    },
  };
}

route('POST', '/api/bets/place', (req, res, p, body) => {
  const user = getUserRow(req.user.id);
  const legsInput = Array.isArray(body.legs) ? body.legs : [];
  if (!legsInput.length) return json(res, 400, { error: 'No selections.' });
  const resolved = [];
  for (const li of legsInput) {
    const r = validateLeg(li);
    if (r.error) return json(res, 409, { error: r.error });
    resolved.push(r.leg);
  }
  if (body.mode === 'parlay') {
    const stake = +body.stake || 0;
    if (stake < STAKE_LIMITS.min) return json(res, 400, { error: 'Minimum stake is ' + fmt(STAKE_LIMITS.min) });
    if (stake > user.balance) return json(res, 400, { error: 'Not enough balance.' });
    const od = resolved.reduce((a, l) => a * l.odds, 1);
    const payout = +(stake * od).toFixed(2);
    if (payout > STAKE_LIMITS.maxParlayPayout) return json(res, 400, { error: `Payout would exceed ${fmt(STAKE_LIMITS.maxParlayPayout)}. Lower the stake.` });
    const id = uid('b');
    db.prepare('INSERT INTO bets (id, user_id, type, stake, odds, payout, status, placed_at, legs) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, 'parlay', stake, +od.toFixed(2), payout, 'open', now(), JSON.stringify(resolved));
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(stake, user.id);
    addTx(user.id, 'bet', 'Parlay (' + resolved.length + ' legs)', -stake);
    bumpPlatform('staked', stake); bumpPlatform('betsPlaced', 1);
    addActivity(user.id, 'Placed ' + resolved.length + '-leg parlay at ' + od.toFixed(2), fmt(stake));
    return json(res, 200, { placed: 1, balance: getUserRow(user.id).balance });
  }
  // singles
  let totalStake = 0;
  const stakes = [];
  for (let i = 0; i < resolved.length; i++) {
    const leg = resolved[i];
    const st = +legsInput[i].stake || 0;
    if (leg.odds > STAKE_LIMITS.maxOddsSingle) return json(res, 400, { error: leg.selName + ' is priced above ' + STAKE_LIMITS.maxOddsSingle + ' — move it into a parlay instead.' });
    const cap = maxStakeForOdds(leg.odds);
    if (st > cap + 1e-9) return json(res, 400, { error: leg.selName + ' allows at most ' + fmt(cap) + ' at these odds.' });
    if (st < STAKE_LIMITS.min) return json(res, 400, { error: 'Minimum stake is ' + fmt(STAKE_LIMITS.min) + ' per bet.' });
    stakes.push(st); totalStake += st;
  }
  if (totalStake > user.balance) return json(res, 400, { error: 'Not enough balance.' });
  for (let i = 0; i < resolved.length; i++) {
    const leg = resolved[i], st = stakes[i];
    const id = uid('b');
    db.prepare('INSERT INTO bets (id, user_id, type, stake, odds, payout, status, placed_at, legs) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, 'single', st, leg.odds, +(st * leg.odds).toFixed(2), 'open', now(), JSON.stringify([leg]));
    addTx(user.id, 'bet', leg.selName + ' — ' + leg.matchName, -st);
    bumpPlatform('staked', st); bumpPlatform('betsPlaced', 1);
  }
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(totalStake, user.id);
  addActivity(user.id, 'Placed ' + resolved.length + ' single bet' + (resolved.length > 1 ? 's' : ''), fmt(totalStake));
  json(res, 200, { placed: resolved.length, balance: getUserRow(user.id).balance });
}, { auth: true });

route('GET', '/api/bets', (req, res) => {
  const rows = db.prepare('SELECT * FROM bets WHERE user_id = ? ORDER BY placed_at DESC LIMIT 200').all(req.user.id);
  json(res, 200, { bets: rows.map((r) => ({ id: r.id, type: r.type, stake: r.stake, odds: r.odds, payout: r.payout, status: r.status, returned: r.returned, placed: r.placed_at, legs: JSON.parse(r.legs) })) });
}, { auth: true });

route('GET', '/api/transactions', (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 300').all(req.user.id);
  json(res, 200, { txs: rows.map((r) => ({ id: r.id, type: r.type, label: r.label, amount: r.amount, status: r.status, t: r.created_at })) });
}, { auth: true });

route('GET', '/api/activity', (req, res) => {
  const rows = db.prepare('SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
  json(res, 200, { activity: rows.map((r) => ({ id: r.id, msg: r.msg, meta: r.meta, t: r.created_at })) });
}, { auth: true });

route('POST', '/api/wallet/deposit', (req, res, p, body) => {
  const amount = +body?.amount || 0;
  if (amount <= 0) return json(res, 400, { error: 'Enter a positive amount.' });
  creditUser(req.user.id, amount);
  addTx(req.user.id, 'deposit', 'Deposit via ' + (body.network || 'TRC20'), amount);
  bumpPlatform('deposited', amount);
  addActivity(req.user.id, 'Deposited', fmt(amount));
  json(res, 200, { balance: getUserRow(req.user.id).balance });
}, { auth: true });

route('POST', '/api/wallet/withdraw', (req, res, p, body) => {
  const amount = +body?.amount || 0;
  const user = getUserRow(req.user.id);
  if (amount <= 0) return json(res, 400, { error: 'Enter a positive amount.' });
  if (amount > user.balance) return json(res, 400, { error: 'Not enough balance.' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, user.id);
  addTx(req.user.id, 'withdraw', 'Withdrawal to ' + (body.network || 'TRC20'), -amount);
  bumpPlatform('withdrawn', amount);
  addActivity(req.user.id, 'Withdrew', fmt(amount));
  json(res, 200, { balance: getUserRow(req.user.id).balance });
}, { auth: true });

route('GET', '/api/admin/overview', (req, res) => {
  const platform = {};
  for (const row of db.prepare('SELECT * FROM platform').all()) platform[row.key] = row.value;
  const users = db.prepare('SELECT id, email, name, balance, joined_at, is_admin FROM users').all();
  json(res, 200, { platform, users });
}, { auth: true, admin: true });

route('GET', '/api/admin/bets', (req, res) => {
  const rows = db.prepare(`SELECT b.*, u.email AS user_email, u.name AS user_name FROM bets b JOIN users u ON u.id = b.user_id ORDER BY b.placed_at DESC LIMIT 500`).all();
  json(res, 200, { bets: rows.map((r) => ({ id: r.id, userEmail: r.user_email, userName: r.user_name, type: r.type, stake: r.stake, odds: r.odds, payout: r.payout, status: r.status, returned: r.returned, placed: r.placed_at, legs: JSON.parse(r.legs) })) });
}, { auth: true, admin: true });

route('POST', '/api/admin/config', (req, res, p, body) => {
  if (body.margin != null) engine.CONFIG.margin = Math.max(0.01, Math.min(0.12, +body.margin));
  if (body.suspendMs != null) engine.CONFIG.suspendMs = Math.max(1000, Math.min(10000, +body.suspendMs));
  json(res, 200, { config: engine.CONFIG });
}, { auth: true, admin: true });

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function matchRoute(method, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (r.parts[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

module.exports = { matchRoute, requireAuth, json, startEngine, STAKE_LIMITS };
