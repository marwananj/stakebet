'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const engine = require('./engine');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');

const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const fmt = (n) => '$' + Number(n).toFixed(2);

// A stake cap keyed to real decimal odds (typically 1.x–10.x here), not the
// American-style 100/150/350 thresholds an earlier version used — those
// never matched this app's odds scale, so almost every normal bet fell into
// the first tier and was capped at a flat $10 regardless of the actual
// payout ceiling. The cap is now purely payout-based: whatever stake would
// hit maxSinglePayout at these odds, floored at the minimum stake.
// `let` (not `const`) so admin config updates (POST /api/admin/config) can
// replace it in place — its properties are still mutated in place elsewhere
// (maxStakeForOdds etc. always read off this same object), matching how
// engine.CONFIG is already mutated rather than reassigned.
const STAKE_LIMITS = {
  min: 0.10, maxOddsSingle: 350, maxSinglePayout: 1000, maxParlayPayout: 25000,
};
function maxStakeForOdds(o) {
  return Math.max(STAKE_LIMITS.min, STAKE_LIMITS.maxSinglePayout / o);
}

function isAdminEmail(em) { return em === 'demo@stakebet.com' || em.includes('admin'); }

// ---------- VIP / loyalty tiers (mirrors the original prototype's vipTier /
// vipFeeMultiplier, keyed off lifetime_wagered instead of localStorage) ----------
const VIP_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const VIP_THRESHOLDS = { silver: 1000, gold: 5000, platinum: 20000 };
const VIP_FEE_MULT = { Bronze: 1, Silver: 0.9, Gold: 0.75, Platinum: 0.5 }; // multiplier applied to the withdrawal network fee
function vipTierIndex(lifetime) {
  if (lifetime >= VIP_THRESHOLDS.platinum) return 3;
  if (lifetime >= VIP_THRESHOLDS.gold) return 2;
  if (lifetime >= VIP_THRESHOLDS.silver) return 1;
  return 0;
}
function vipTier(lifetime) { return VIP_TIERS[vipTierIndex(lifetime)]; }
function vipFeeMultiplier(lifetime) { return VIP_FEE_MULT[vipTier(lifetime)]; }

// ---------- private confirmation key ----------
// A fixed passphrase required to confirm a deposit/withdraw, kept private —
// it is never returned by any API response and never printed in the UI, so
// only whoever configured it knows it. Change it here (and nowhere else).
const SECURITY_KEY = '8&*8&*';

// ---------- wagering requirement on the welcome bonus ----------
const WAGERING_MULTIPLIER = 3; // playthrough required = bonus amount * this
const WELCOME_BONUS_AMOUNT = 50;
// Private claim code for the welcome bonus — like SECURITY_KEY above, this
// is never exposed by the API or shown in the UI. The bonus is not
// auto-credited on verify; a user must claim it with this code via
// POST /api/me/claim-bonus.
const BONUS_CLAIM_CODE = 'YNWA';
// Simulated on-chain confirmation delay for a deposit/withdraw — see
// /api/wallet/deposit and /api/wallet/withdraw.
const DEPOSIT_CONFIRM_MS = 60000;

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
  const lifetime = row.lifetime_wagered || 0;
  const wageringRequired = row.wagering_required || 0;
  const wageringProgress = row.wagering_progress || 0;
  return {
    id: row.id, email: row.email, name: row.name, country: row.country, joined: row.joined_at,
    isAdmin: !!row.is_admin, balance: row.balance, oddsFormat: row.odds_format,
    limits: { deposit: row.deposit_limit, loss: row.loss_limit },
    lifetimeWagered: lifetime, vipTier: vipTier(lifetime), vipFeeMultiplier: vipFeeMultiplier(lifetime),
    wageringRequired, wageringProgress, wageringRemaining: Math.max(0, wageringRequired - wageringProgress),
    kycVerified: !!row.kyc_verified, lockUntil: row.lock_until || null,
    bonusClaimed: !!row.bonus_claimed,
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
  if (leg.mkt === 'HT') {
    if (!m.htScore) return 'void';
    const [hh, ha] = m.htScore;
    const w = hh > ha ? '1' : (hh < ha ? '2' : 'X');
    return leg.selK === w ? 'won' : 'lost';
  }
  if (leg.mkt === 'WBTTS') {
    const win = h > a ? 'H' : (h < a ? 'A' : 'D');
    const btts = h > 0 && a > 0;
    return (leg.selK[0] === win && (leg.selK[1] === 'Y') === btts) ? 'won' : 'lost';
  }
  return 'void';
}
function simResultText(m) {
  const [h, a] = m.sport === 'tennis' ? m.sets : m.score;
  if (h > a) return m.home + ' won';
  if (a > h) return m.away + ' won';
  return 'Draw';
}
function recordSimHistory(m) {
  if (!m.sim || !m.simOwner) return;
  const scoreLine = m.sport === 'tennis' ? m.sets : m.score;
  db.prepare('INSERT INTO sim_history (id, user_id, sport, home, away, final_score, result, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid('sh'), m.simOwner, m.sport, m.home, m.away, scoreLine.join('–'), simResultText(m), now());
}
function settleMatch(m) {
  recordSimHistory(m);
  if (m.sim) promoteSimQueue(); // a slot may have just freed up for someone queued
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
// ---------- live chat (real users, with light ambient bot flavor) ----------
const CHAT_BOTS = ['Marco_88', 'BetKing', 'Luna_G', 'RedArmy', 'Dana_V', 'Sipho22', 'TifoTom', 'Nadia.K', 'PunterPaul', 'Yuki_88', 'Carlos_R', 'StreakSteph', 'Big_Marv', 'Priya.B'];
const CHAT_LINES = ['anyone else on this match?', 'odds moving fast tonight', "cmon!!", 'that was close', "book's quick to reprice here", 'parlay or nothing 😤', 'nice line on the double chance', 'watching a few games at once lol', "who's backing the away side?", 'handicap looking good rn', 'this line barely moved', 'solid value on BTTS', 'in-play markets are wild today', 'just cashed a small one 🙌'];
let lastChatAt = 0;
function insertChat(userId, name, msg) {
  db.prepare('INSERT INTO chat (id, user_id, name, msg, created_at) VALUES (?,?,?,?,?)').run(uid('c'), userId, name, msg, now());
}
function startChatAmbience() {
  setInterval(() => {
    if (now() - lastChatAt < 60000) return; // quiet down while real users are talking
    if (Math.random() > 0.5) return; // keep it modest
    const name = CHAT_BOTS[Math.floor(Math.random() * CHAT_BOTS.length)];
    const line = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
    insertChat(null, name, line);
  }, 15000);
}

function startEngine() { engine.startEngine(settleMatch); startChatAmbience(); }

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
  // Defensive re-check right before inserting: the `users.email` column is
  // UNIQUE at the DB level (db.js), but that only turns a duplicate into an
  // uncaught constraint-violation exception — which server.js's generic
  // handler turns into a confusing raw "Server error" (500) instead of the
  // same friendly "already exists" message signup gives. This closes that
  // gap for the case that actually reaches it: two /verify requests in
  // flight for the same email at once (e.g. a double-tapped submit button
  // on a slow connection) — one succeeds, the other gets a clean 409 instead
  // of a 500.
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(em)) {
    verificationStore.delete(em);
    return json(res, 409, { error: 'An account with this email already exists. Log in instead.' });
  }
  verificationStore.delete(em);
  const id = uid('u');
  const isAdmin = isAdminEmail(em) ? 1 : 0;
  try {
    db.prepare(`INSERT INTO users (id, email, name, password_hash, country, joined_at, verified, is_admin, balance)
      VALUES (?,?,?,?,?,?,1,?,0)`).run(id, em, pending.payload.name, pending.payload.passwordHash, pending.payload.country, now(), isAdmin);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) return json(res, 409, { error: 'An account with this email already exists. Log in instead.' });
    throw err;
  }
  // No welcome bonus is auto-credited — it sits unclaimed until
  // the user redeems BONUS_CLAIM_CODE via POST /api/me/claim-bonus (which is
  // also where wagering_required actually gets set, at claim time).
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

// KYC — simulated instant approval, no real document upload (demo).
route('POST', '/api/me/kyc', (req, res) => {
  db.prepare('UPDATE users SET kyc_verified = 1 WHERE id = ?').run(req.user.id);
  addActivity(req.user.id, 'Identity check completed');
  json(res, 200, { user: publicUser(getUserRow(req.user.id)) });
}, { auth: true });

// Welcome bonus — claimed, not auto-credited (see signup/verify above). Fixed
// demo code, one-time only per account.
route('POST', '/api/me/claim-bonus', (req, res, p, body) => {
  const user = getUserRow(req.user.id);
  if (user.bonus_claimed) return json(res, 400, { error: 'You have already claimed your welcome bonus.' });
  const code = String(body?.code || '').trim().toUpperCase();
  if (code !== BONUS_CLAIM_CODE) return json(res, 400, { error: 'That code is not valid.' });
  creditUser(user.id, WELCOME_BONUS_AMOUNT);
  addTx(user.id, 'bonus', 'Welcome bonus claimed', WELCOME_BONUS_AMOUNT);
  db.prepare('UPDATE users SET wagering_required = wagering_required + ?, bonus_claimed = 1 WHERE id = ?')
    .run(WELCOME_BONUS_AMOUNT * WAGERING_MULTIPLIER, user.id);
  addActivity(user.id, 'Claimed welcome bonus', fmt(WELCOME_BONUS_AMOUNT));
  json(res, 200, { user: publicUser(getUserRow(user.id)) });
}, { auth: true });

// Self-exclusion ("take a break") — irreversible until it expires. Reuses the
// existing lock_until column/login-time check; this is the first thing that
// actually SETS it for a user acting on their own behalf.
route('POST', '/api/me/exclude', (req, res, p, body) => {
  const hours = +body?.hours || 0;
  if (hours <= 0) return json(res, 400, { error: 'Choose a valid duration.' });
  const until = now() + hours * 3600000;
  db.prepare('UPDATE users SET lock_until = ? WHERE id = ?').run(until, req.user.id);
  addActivity(req.user.id, 'Self-excluded for ' + hours + ' hours');
  json(res, 200, { lockUntil: until });
}, { auth: true });

route('GET', '/api/matches', (req, res, p, body, query) => {
  // User-started FIFA simulations are excluded from the regular sport board —
  // they live in their own section (see /api/sims) so they don't clutter the
  // real schedule, even though they run through the exact same engine.
  // A just-finished match also stays on the board briefly (see
  // listRecentlyEnded()) instead of vanishing the instant it ends, so there's
  // a moment to actually see "Full time" before another live match — which
  // maybeKickoff() in engine.js is already backfilling every tick — takes
  // its place, rather than the board jump-cutting between matches.
  const sport = query.sport || undefined;
  const list = [...engine.listMatches({ sport, ended: false }), ...engine.listRecentlyEnded(sport)].filter((m) => !m.sim);
  json(res, 200, { matches: list });
}, { auth: true });

// ---------- FIFA simulation queue ----------
// In-memory only — a restart clears it. That's an accepted trade-off here:
// a `sim_queue` table would survive restarts, but nothing else about a sim
// (or the live/match engine state in general) survives one either, so a
// queued *request* not surviving one is no worse than the running sims
// themselves not surviving it. FIFO per nothing-in-particular (global order),
// promoted per-user as that user's own running-sim count drops below the cap.
const simQueue = []; // { id, userId, sport, createdAt }
function promoteSimQueue() {
  for (let i = 0; i < simQueue.length; i++) {
    const q = simQueue[i];
    const running = engine.listSims().filter((m) => m.simOwner === q.userId).length;
    if (running < engine.MAX_SIMS_PER_USER) {
      simQueue.splice(i, 1);
      engine.startSim(q.userId, q.sport);
      i--; // a slot may have freed for more than one queued entry this round
    }
  }
}

// League standings — computed purely from ENDED matches already in the
// `matches` table, no new schema. Football/soccer-style scoring (3/1/0); every
// other sport just counts wins/losses (1/0), since there's no "draw" concept
// worth modeling for basketball/tennis/NFL here.
route('GET', '/api/standings', (req, res, p, body, query) => {
  const sport = String(query.sport || '');
  const league = String(query.league || '');
  if (!sport || !league) return json(res, 400, { error: 'sport and league are required.' });
  const rows = db.prepare('SELECT data FROM matches WHERE sport = ? AND league = ? AND ended = 1').all(sport, league);
  const soccerStyle = sport === 'football';
  const table = {};
  const ensure = (t) => (table[t] = table[t] || { team: t, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
  for (const row of rows) {
    const m = JSON.parse(row.data);
    const scoreLine = m.sport === 'tennis' ? m.sets : m.score;
    if (!Array.isArray(scoreLine) || scoreLine.length !== 2) continue;
    const [h, a] = scoreLine;
    const home = ensure(m.home), away = ensure(m.away);
    home.played++; away.played++;
    home.gf += h; home.ga += a; away.gf += a; away.ga += h;
    if (h > a) { home.w++; away.l++; home.pts += soccerStyle ? 3 : 1; }
    else if (h < a) { away.w++; home.l++; away.pts += soccerStyle ? 3 : 1; }
    else { home.d++; away.d++; if (soccerStyle) { home.pts += 1; away.pts += 1; } }
  }
  const list = Object.values(table).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
  json(res, 200, { sport, league, table: list });
}, { auth: true });

route('GET', '/api/sims', (req, res) => {
  json(res, 200, {
    sims: engine.listSims(), maxPerUser: engine.MAX_SIMS_PER_USER,
    mine: engine.listSims().filter((m) => m.simOwner === req.user.id).length,
    queuedMine: simQueue.filter((q) => q.userId === req.user.id).length,
  });
}, { auth: true });

route('POST', '/api/sims/start', (req, res, p, body) => {
  const sport = String(body?.sport || 'football');
  const r = engine.startSim(req.user.id, sport);
  if (r.error) {
    // Specifically the "at the cap" error — queue instead of rejecting.
    if (r.error.includes('at once')) {
      simQueue.push({ id: uid('q'), userId: req.user.id, sport, createdAt: now() });
      const position = simQueue.filter((q) => q.userId === req.user.id).length;
      return json(res, 200, { queued: true, position, message: 'Queued — will start automatically when a slot frees up.' });
    }
    return json(res, 400, { error: r.error });
  }
  json(res, 200, { match: r.match });
}, { auth: true });

route('POST', '/api/sims/:id/abandon', (req, res, p) => {
  const m = engine.getMatch(p.id);
  if (!m || !m.sim) return json(res, 404, { error: 'Simulation not found.' });
  if (m.simOwner !== req.user.id && !req.user.is_admin) return json(res, 403, { error: 'You can only abandon your own simulation.' });
  if (m.ended) return json(res, 400, { error: 'This simulation has already ended.' });
  m.ended = true; m.live = false; m.endedAt = now();
  engine.saveMatch(m);
  settleMatch(m);
  json(res, 200, { match: m });
}, { auth: true });

route('GET', '/api/sims/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM sim_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  json(res, 200, { history: rows.map((r) => ({ id: r.id, sport: r.sport, home: r.home, away: r.away, finalScore: r.final_score, result: r.result, t: r.created_at })) });
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

// 24h net loss = money staked minus money returned (payout/refund) in the
// trailing 24h — used as a stand-in for "loss" since there's no clean betting
// session boundary to measure a real per-session loss against.
function net24hLoss(userId) {
  const since = now() - 86400000;
  const { staked } = db.prepare("SELECT COALESCE(SUM(-amount),0) AS staked FROM transactions WHERE user_id = ? AND type = 'bet' AND created_at >= ?").get(userId, since);
  const { returned } = db.prepare("SELECT COALESCE(SUM(amount),0) AS returned FROM transactions WHERE user_id = ? AND type IN ('payout','refund') AND created_at >= ?").get(userId, since);
  return staked - returned;
}
function bumpWagering(userId, amount) {
  db.prepare('UPDATE users SET lifetime_wagered = lifetime_wagered + ?, wagering_progress = wagering_progress + ? WHERE id = ?').run(amount, amount, userId);
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
    if (user.loss_limit > 0 && net24hLoss(user.id) + stake > user.loss_limit) {
      return json(res, 400, { error: 'This would exceed your 24h loss limit of ' + fmt(user.loss_limit) + '.' });
    }
    const od = resolved.reduce((a, l) => a * l.odds, 1);
    const payout = +(stake * od).toFixed(2);
    if (payout > STAKE_LIMITS.maxParlayPayout) return json(res, 400, { error: `Payout would exceed ${fmt(STAKE_LIMITS.maxParlayPayout)}. Lower the stake.` });
    const id = uid('b');
    db.prepare('INSERT INTO bets (id, user_id, type, stake, odds, payout, status, placed_at, legs) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, 'parlay', stake, +od.toFixed(2), payout, 'open', now(), JSON.stringify(resolved));
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(stake, user.id);
    addTx(user.id, 'bet', 'Parlay (' + resolved.length + ' legs)', -stake);
    bumpPlatform('staked', stake); bumpPlatform('betsPlaced', 1);
    bumpWagering(user.id, stake);
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
  if (user.loss_limit > 0 && net24hLoss(user.id) + totalStake > user.loss_limit) {
    return json(res, 400, { error: 'This would exceed your 24h loss limit of ' + fmt(user.loss_limit) + '.' });
  }
  for (let i = 0; i < resolved.length; i++) {
    const leg = resolved[i], st = stakes[i];
    const id = uid('b');
    db.prepare('INSERT INTO bets (id, user_id, type, stake, odds, payout, status, placed_at, legs) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, 'single', st, leg.odds, +(st * leg.odds).toFixed(2), 'open', now(), JSON.stringify([leg]));
    addTx(user.id, 'bet', leg.selName + ' — ' + leg.matchName, -st);
    bumpPlatform('staked', st); bumpPlatform('betsPlaced', 1);
  }
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(totalStake, user.id);
  bumpWagering(user.id, totalStake);
  addActivity(user.id, 'Placed ' + resolved.length + ' single bet' + (resolved.length > 1 ? 's' : ''), fmt(totalStake));
  json(res, 200, { placed: resolved.length, balance: getUserRow(user.id).balance });
}, { auth: true });

// Maps a leg's live win/lose preview using the exact same legResult() logic
// real settlement uses, against the match's current in-progress score — this
// is a UI preview only (`liveHint`), never written to `leg.result`, which
// stays reserved for real, final settlement.
function attachLiveHints(bet) {
  if (bet.status !== 'open') return bet;
  for (const leg of bet.legs) {
    if (leg.result) continue;
    const m = engine.getMatch(leg.matchId);
    if (!m || !m.live) continue;
    const preview = legResult(leg, m);
    leg.liveHint = preview === 'won' ? 'winning' : (preview === 'lost' ? 'losing' : 'push');
  }
  return bet;
}
route('GET', '/api/bets', (req, res) => {
  const rows = db.prepare('SELECT * FROM bets WHERE user_id = ? ORDER BY placed_at DESC LIMIT 200').all(req.user.id);
  json(res, 200, { bets: rows.map((r) => attachLiveHints({ id: r.id, type: r.type, stake: r.stake, odds: r.odds, payout: r.payout, status: r.status, returned: r.returned, placed: r.placed_at, legs: JSON.parse(r.legs) })) });
}, { auth: true });

route('GET', '/api/transactions', (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 300').all(req.user.id);
  json(res, 200, { txs: rows.map((r) => ({ id: r.id, type: r.type, label: r.label, amount: r.amount, status: r.status, t: r.created_at })) });
}, { auth: true });

route('GET', '/api/activity', (req, res) => {
  const rows = db.prepare('SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
  json(res, 200, { activity: rows.map((r) => ({ id: r.id, msg: r.msg, meta: r.meta, t: r.created_at })) });
}, { auth: true });

// Deposit is pending -> confirmed, not instant, mirroring the original
// prototype's simulated on-chain confirmation delay. The transaction is
// inserted with status='pending' and the balance is NOT touched yet; a
// server-side timeout flips it to 'completed' and credits the balance a few
// seconds later. GET /api/transactions already returns `status`, so the
// front end can show a "pending"/"confirming…" state in the meantime.
route('POST', '/api/wallet/deposit', (req, res, p, body) => {
  const amount = +body?.amount || 0;
  if (amount <= 0) return json(res, 400, { error: 'Enter a positive amount.' });
  if (String(body?.securityKey || '') !== SECURITY_KEY) return json(res, 400, { error: 'Incorrect security key.' });
  const user = getUserRow(req.user.id);
  if (user.deposit_limit > 0) {
    const since = now() - 86400000;
    const { total } = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE user_id = ? AND type = 'deposit' AND created_at >= ?").get(user.id, since);
    if (total + amount > user.deposit_limit) {
      return json(res, 400, { error: `This would exceed your 24h deposit limit of ${fmt(user.deposit_limit)} (already deposited ${fmt(total)} in the last 24h).` });
    }
  }
  const id = uid('t');
  db.prepare('INSERT INTO transactions (id, user_id, type, label, amount, status, created_at, extra) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, 'deposit', 'Deposit via ' + (body.network || 'TRC20'), amount, 'pending', now(), null);
  addActivity(req.user.id, 'Deposit detected — awaiting confirmation', fmt(amount));
  setTimeout(() => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx || tx.status !== 'pending') return; // already resolved (or gone) — nothing to do
    db.prepare("UPDATE transactions SET status = 'completed' WHERE id = ?").run(id);
    creditUser(req.user.id, amount);
    bumpPlatform('deposited', amount);
    addActivity(req.user.id, 'Deposit confirmed', fmt(amount));
  }, DEPOSIT_CONFIRM_MS);
  json(res, 200, { pending: true, txId: id, etaMs: DEPOSIT_CONFIRM_MS, message: 'Deposit detected — confirming on the network.' });
}, { auth: true });

// Withdrawal is pending -> confirmed too, on the same delay as a deposit.
// The balance is debited immediately (so the funds can't be spent twice while
// the withdrawal is "in flight" and so it can't be reversed on refresh), but
// the transaction sits as status='pending' — and the activity feed says
// "processing" — until the same simulated on-chain delay elapses, then it
// flips to 'completed'. GET /api/transactions already exposes `status`, so
// the front end can show "Processing…" in the meantime, matching the
// deposit's "Confirming…" state.
route('POST', '/api/wallet/withdraw', (req, res, p, body) => {
  const amount = +body?.amount || 0;
  const user = getUserRow(req.user.id);
  if (amount <= 0) return json(res, 400, { error: 'Enter a positive amount.' });
  if (String(body?.securityKey || '') !== SECURITY_KEY) return json(res, 400, { error: 'Incorrect security key.' });
  if (amount > user.balance) return json(res, 400, { error: 'Not enough balance.' });
  const wageringRemaining = Math.max(0, (user.wagering_required || 0) - (user.wagering_progress || 0));
  if (wageringRemaining > 0) {
    return json(res, 400, { error: `You need to wager ${fmt(wageringRemaining)} more before you can withdraw — this comes from your welcome bonus wagering requirement.` });
  }
  if (!user.kyc_verified) return json(res, 400, { error: 'Complete identity verification (KYC) before withdrawing.' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, user.id);
  const id = uid('t');
  db.prepare('INSERT INTO transactions (id, user_id, type, label, amount, status, created_at, extra) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, 'withdraw', 'Withdrawal to ' + (body.network || 'TRC20'), -amount, 'pending', now(), null);
  addActivity(req.user.id, 'Withdrawal requested — processing', fmt(amount));
  setTimeout(() => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx || tx.status !== 'pending') return;
    db.prepare("UPDATE transactions SET status = 'completed' WHERE id = ?").run(id);
    bumpPlatform('withdrawn', amount);
    addActivity(req.user.id, 'Withdrawal completed', fmt(amount));
  }, DEPOSIT_CONFIRM_MS);
  json(res, 200, { pending: true, txId: id, etaMs: DEPOSIT_CONFIRM_MS, balance: getUserRow(req.user.id).balance, message: 'Withdrawal requested — processing.' });
}, { auth: true });

route('GET', '/api/admin/overview', (req, res) => {
  const platform = {};
  for (const row of db.prepare('SELECT * FROM platform').all()) platform[row.key] = row.value;
  const users = db.prepare('SELECT id, email, name, balance, joined_at, is_admin, lock_until, lifetime_wagered, kyc_verified FROM users').all();
  json(res, 200, { platform, users });
}, { auth: true, admin: true });

// Every match the engine knows about — live, upcoming, and finished — with
// its current score/minute, straight from the same rows the live board
// reads from. This is what lets the admin dashboard show the real,
// server-authoritative result of every match instead of only a bet list.
route('GET', '/api/admin/matches', (req, res, p, body, query) => {
  const sql = query.sport
    ? "SELECT * FROM matches WHERE sport = ? ORDER BY start DESC LIMIT 500"
    : "SELECT * FROM matches ORDER BY start DESC LIMIT 500";
  const rows = query.sport ? db.prepare(sql).all(query.sport) : db.prepare(sql).all();
  const matches = rows.map((r) => {
    const m = JSON.parse(r.data);
    return {
      id: m.id, sport: m.sport, league: m.league, home: m.home, away: m.away,
      score: m.score, minute: m.minute, live: m.live, ended: m.ended,
      verified: !!m.verified, start: m.start,
      sim: !!m.sim, adminAdded: !!m.adminAdded,
      kind: m.sim ? 'fifa' : 'real',
      status: m.ended ? 'finished' : (m.live ? 'live' : 'upcoming'),
      // Needed by the admin page's clock formatting (45+N'/90+N' once
      // stoppage time is added) and its added-time inputs — without these,
      // the admin table couldn't tell half-time had passed (so it kept
      // showing "45+N'" forever instead of switching to a plain minute) and
      // could never show or gate the currently-set added time.
      htScore: m.htScore || null, addedHT: m.addedHT || 0, addedFT: m.addedFT || 0,
    };
  });
  json(res, 200, { matches });
}, { auth: true, admin: true });

route('GET', '/api/admin/bets', (req, res) => {
  const rows = db.prepare(`SELECT b.*, u.email AS user_email, u.name AS user_name FROM bets b JOIN users u ON u.id = b.user_id ORDER BY b.placed_at DESC LIMIT 500`).all();
  json(res, 200, { bets: rows.map((r) => ({ id: r.id, userEmail: r.user_email, userName: r.user_name, type: r.type, stake: r.stake, odds: r.odds, payout: r.payout, status: r.status, returned: r.returned, placed: r.placed_at, legs: JSON.parse(r.legs) })) });
}, { auth: true, admin: true });

// The admin page's engine/stake-limit form used to always show its
// hardcoded HTML defaults (min 0.10, max odds 350, etc.) on every load,
// never the actual current values — there was no way to read them back,
// only to blindly overwrite them via POST. So re-opening the admin page
// after changing a limit made it look like the change hadn't taken, even
// though it had. This lets the page load with what's actually configured.
route('GET', '/api/admin/config', (req, res) => {
  json(res, 200, { config: engine.CONFIG, stakeLimits: STAKE_LIMITS });
}, { auth: true, admin: true });

// Powers the league/team autocomplete on the admin "add fixture" form —
// admins can still type anything free-form (any of the 120+ real leagues,
// or a brand new one), this just suggests the ones already known to the
// engine so most of the time they don't have to type a roster from scratch.
route('GET', '/api/admin/teams', (req, res) => {
  json(res, 200, { teams: engine.TEAMS, sports: engine.SPORTS.map((s) => s.id) });
}, { auth: true, admin: true });

route('POST', '/api/admin/config', (req, res, p, body) => {
  if (body.margin != null) engine.CONFIG.margin = Math.max(0.01, Math.min(0.12, +body.margin));
  if (body.suspendMs != null) engine.CONFIG.suspendMs = Math.max(1000, Math.min(10000, +body.suspendMs));
  if (body.stakeLimits) {
    const sl = body.stakeLimits;
    if (sl.min != null) STAKE_LIMITS.min = Math.max(0.01, +sl.min);
    if (sl.maxOddsSingle != null) STAKE_LIMITS.maxOddsSingle = Math.max(1.01, +sl.maxOddsSingle);
    if (sl.maxSinglePayout != null) STAKE_LIMITS.maxSinglePayout = Math.max(1, +sl.maxSinglePayout);
    if (sl.maxParlayPayout != null) STAKE_LIMITS.maxParlayPayout = Math.max(1, +sl.maxParlayPayout);
  }
  json(res, 200, { config: engine.CONFIG, stakeLimits: STAKE_LIMITS });
}, { auth: true, admin: true });

// ---------- admin CRUD: matches ----------
// Once an admin sets a score by hand, it's the real result — the live
// simulation (engine.js's stepMinute()) must not then quietly add more
// random goals on top of it a few ticks later, which used to make a manually
// set score look "wrong" again within seconds. `adminLocked` freezes the
// random scoring for this match (the clock/momentum keep moving normally)
// until it's ended or force-scored again.
route('POST', '/api/admin/matches/:id/force-score', (req, res, p, body) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  const home = +body?.home, away = +body?.away;
  if (!Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away < 0) return json(res, 400, { error: 'home/away must be non-negative numbers.' });
  m.score = [home, away];
  if (m.sport === 'tennis') m.sets = [home, away];
  m.adminLocked = true;
  engine.priceMatch(m);
  engine.saveMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

route('POST', '/api/admin/matches/:id/end', (req, res, p) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  if (m.ended) return json(res, 400, { error: 'Match already ended.' });
  m.ended = true; m.live = false; m.endedAt = now();
  engine.saveMatch(m);
  settleMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

route('POST', '/api/admin/matches/:id/suspend', (req, res, p, body) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  const ms = +body?.ms || 5000;
  engine.suspendMatch(m, Math.max(1000, Math.min(60000, ms)));
  engine.saveMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

// Stoppage/injury time for a live, real 90-minute football match — the admin
// sets how many extra minutes get added on top of the 45th (half) or 90th
// (full-time) minute, exactly like a fourth official's board. `half: 'HT'`
// sets the first-half added time (delays the half-time whistle and, once it
// fires, the second half still cleanly resumes counting from 46' — see
// engine.js's stepMinute() for the rebase that makes that work); `half: 'FT'`
// extends the match's full-time cap (engine.js's capFor()) the same way.
// Only meaningful for football; can be set before or during the relevant
// half, any time before that half's whistle would otherwise blow.
route('POST', '/api/admin/matches/:id/added-time', (req, res, p, body) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  if (m.sport !== 'football') return json(res, 400, { error: 'Added time only applies to football matches.' });
  const half = String(body?.half || '').toUpperCase();
  const minutes = Math.max(0, Math.min(15, Math.round(+body?.minutes || 0)));
  if (half === 'HT') {
    if (m.htScore) return json(res, 400, { error: 'Half-time has already passed for this match.' });
    m.addedHT = minutes;
  } else if (half === 'FT') {
    if (m.ended) return json(res, 400, { error: 'Match has already ended.' });
    m.addedFT = minutes;
  } else {
    return json(res, 400, { error: "half must be 'HT' or 'FT'." });
  }
  engine.saveMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

// Kickoff can be given either as "starts in N minutes" (quick/relative) or as
// an explicit Beirut-local date + time (kickoffDate 'YYYY-MM-DD' + kickoffTime
// 'HH:MM', both interpreted as Asia/Beirut, fixed UTC+3 — see engine.js's
// beirutWallToUtc()). Whichever is given, the fixture goes live automatically
// the moment its `start` timestamp is reached — engine.js's maybeKickoff()
// already polls for that on every 3s tick, no special-casing needed here.
// Optional oddsHome/oddsDraw/oddsAway (football only) let the admin set the
// 1X2 price directly; they're de-vigged into fair probabilities and solved
// back into the match's underlying [home,away] attack strengths (see
// strengthsForOdds() in engine.js) so every other market (O/U, BTTS,
// handicap, half-time) stays internally consistent with them and still
// updates live once the match kicks off, rather than freezing a raw number.
route('POST', '/api/admin/fixtures', (req, res, p, body) => {
  const {
    sport, league, home, away, startInMinutes, kickoffDate, kickoffTime,
    oddsHome, oddsDraw, oddsAway, kind, verified,
  } = body || {};
  if (!sport || !league || !home || !away) return json(res, 400, { error: 'sport, league, home and away are required.' });
  const fxKind = kind === 'fifa' ? 'fifa' : 'real';
  const m = engine.makeMatch(sport, league, String(home), String(away), false);
  if (kickoffDate && kickoffTime) {
    const [y, mo, d] = String(kickoffDate).split('-').map(Number);
    const [h, mi] = String(kickoffTime).split(':').map(Number);
    if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return json(res, 400, { error: 'Invalid kickoff date/time.' });
    m.start = engine.beirutWallToUtc(y, mo, d, h, mi);
  } else {
    m.start = now() + (Math.max(0, +startInMinutes || 0)) * 60000;
  }
  if (sport === 'football' && oddsHome && oddsDraw && oddsAway) {
    const oh = +oddsHome, od = +oddsDraw, oa = +oddsAway;
    if (oh > 1 && od > 1 && oa > 1) {
      const str = engine.strengthsForOdds(oh, od, oa);
      if (str) {
        m.str = str;
        engine.priceMatch(m);
        // Pin the pregame 1X2 line to exactly what was typed — the solver
        // above gets every other market internally consistent with it, but
        // at very lopsided prices its grid resolution can land a little off
        // the exact number. Live play reprices everything normally once the
        // match kicks off.
        if (m.markets['1X2']) {
          const sel = m.markets['1X2'].sel;
          sel.find((s) => s.k === '1').o = oh;
          sel.find((s) => s.k === 'X').o = od;
          sel.find((s) => s.k === '2').o = oa;
        }
      }
    }
  }
  // `adminAdded` marks every fixture the admin schedules here (either kind),
  // so maybeKickoff()'s "never let a league go dark" fallback never force-
  // starts it early — the admin's chosen kickoff time is always respected.
  m.adminAdded = true;
  if (fxKind === 'fifa') {
    // FIFA / quick-sim fixture: shown on the sims board (not the normal real
    // matches board), runs at a compressed pace (~8 real minutes for a full
    // 90-minute football match), and is never treated as verified.
    m.sim = true;
    m.verified = false;
    m.secPerMin = engine.FIFA_SEC_PER_MIN;
  } else {
    // Real fixture: shown on the normal board. Only marked "✓ Verified" (and
    // therefore locked to admin-controlled scoring, per item 2) when the
    // admin explicitly checks that box — otherwise it plays out like any
    // other real-board match. Verified real fixtures run at true real-world
    // speed (a 90-minute match really takes ~90 real minutes).
    m.sim = false;
    m.verified = !!verified;
    m.secPerMin = m.verified ? engine.REAL_SEC_PER_MIN : undefined;
  }
  engine.saveMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

// Immediately kick off a scheduled (not-yet-live) fixture, regardless of its
// programmed kickoff time — the admin dashboard's "Start now" action.
route('POST', '/api/admin/matches/:id/start-now', (req, res, p) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  if (m.live || m.ended) return json(res, 400, { error: 'Match is already live or ended.' });
  engine.kickOffFresh(m);
  engine.saveMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

// Bump one side's score by exactly 1 — the admin dashboard's quick "+1 home"
// / "+1 away" buttons, for fast manual scoring of a verified/admin-locked
// live match without typing the full new score.
route('POST', '/api/admin/matches/:id/increment', (req, res, p, body) => {
  const m = engine.getMatch(p.id);
  if (!m) return json(res, 404, { error: 'Match not found.' });
  const side = (body || {}).side === 'away' ? 1 : (body || {}).side === 'home' ? 0 : null;
  if (side === null) return json(res, 400, { error: "side must be 'home' or 'away'." });
  if (!Array.isArray(m.score)) m.score = [0, 0];
  m.score[side] = (m.score[side] || 0) + 1;
  m.lastScorer = side;
  m.adminLocked = true;
  engine.priceMatch(m);
  engine.saveMatch(m);
  json(res, 200, { match: m });
}, { auth: true, admin: true });

// ---------- admin CRUD: users ----------
route('POST', '/api/admin/users/:id/toggle-admin', (req, res, p) => {
  const target = getUserRow(p.id);
  if (!target) return json(res, 404, { error: 'User not found.' });
  if (target.is_admin && target.id === req.user.id) {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get();
    if (c <= 1) return json(res, 400, { error: 'You are the only admin — cannot revoke your own admin status.' });
  }
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(target.is_admin ? 0 : 1, target.id);
  json(res, 200, { user: publicUser(getUserRow(target.id)) });
}, { auth: true, admin: true });

route('POST', '/api/admin/users/:id/lock', (req, res, p, body) => {
  const target = getUserRow(p.id);
  if (!target) return json(res, 404, { error: 'User not found.' });
  const hours = +body?.hours || 0;
  if (hours <= 0) return json(res, 400, { error: 'Choose a valid duration.' });
  const until = now() + hours * 3600000;
  db.prepare('UPDATE users SET lock_until = ? WHERE id = ?').run(until, target.id);
  json(res, 200, { user: publicUser(getUserRow(target.id)) });
}, { auth: true, admin: true });

route('GET', '/api/chat', (req, res, p, body, query) => {
  const since = +query.since || 0;
  const rows = since
    ? db.prepare('SELECT * FROM chat WHERE created_at > ? ORDER BY created_at ASC LIMIT 100').all(since)
    : db.prepare('SELECT * FROM chat ORDER BY created_at DESC LIMIT 100').all().reverse();
  json(res, 200, { messages: rows.map((r) => ({ id: r.id, name: r.name, msg: r.msg, t: r.created_at, mine: r.user_id === req.user.id })) });
}, { auth: true });

route('POST', '/api/chat', (req, res, p, body) => {
  const msg = String(body?.msg || '').trim();
  if (!msg) return json(res, 400, { error: 'Message cannot be empty.' });
  if (msg.length > 180) return json(res, 400, { error: 'Message is too long (180 characters max).' });
  insertChat(req.user.id, req.user.name, msg);
  lastChatAt = now();
  json(res, 200, { ok: true });
}, { auth: true });

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
