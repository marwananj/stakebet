// The whole pricing + live-match simulation model, ported from the original
// client-only prototype. This now runs ONCE, authoritatively, on the server —
// every visitor sees the exact same live matches, scores and odds (pulled
// from the shared SQLite database), instead of each browser inventing its
// own random world in localStorage.
'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const uid = (p) => p + crypto.randomBytes(5).toString('hex');
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const now = () => Date.now();

const SEC_PER_MATCH_MIN = 3; // 1 simulated minute = 3 real seconds, same pace as the original

const TEAMS = {
  football: {
    'Premier League': ['Arsenal', 'Liverpool', 'Man City', 'Chelsea', 'Tottenham', 'Newcastle', 'Aston Villa', 'Brighton', 'Man United', 'West Ham'],
    'La Liga': ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Athletic Club', 'Real Sociedad', 'Villarreal', 'Real Betis', 'Sevilla'],
    'Serie A': ['Inter', 'Juventus', 'Napoli', 'Milan', 'Atalanta', 'Roma', 'Lazio', 'Fiorentina'],
    'Bundesliga': ['Bayern Munich', 'Bayer Leverkusen', 'Borussia Dortmund', 'RB Leipzig', 'Eintracht Frankfurt', 'VfB Stuttgart'],
    'Ligue 1': ['PSG', 'Monaco', 'Marseille', 'Lyon', 'Lille', 'Nice'],
  },
  basketball: { 'NBA': ['Boston Celtics', 'Denver Nuggets', 'LA Lakers', 'Golden State', 'Milwaukee', 'Phoenix Suns', 'Miami Heat', 'Dallas Mavericks', 'New York Knicks', 'Minnesota'] },
  tennis: { 'ATP 1000': ['Alcaraz', 'Sinner', 'Djokovic', 'Medvedev', 'Zverev', 'Rublev', 'Rune', 'De Minaur'] },
  nfl: { 'NFL': ['Chiefs', 'Bills', '49ers', 'Eagles', 'Cowboys', 'Ravens', 'Dolphins', 'Lions'] },
};
const SPORTS = [{ id: 'football' }, { id: 'basketball' }, { id: 'tennis' }, { id: 'nfl' }];

function fact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function pois(k, l) { return Math.exp(-l) * Math.pow(l, k) / fact(k); }
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const CONFIG = { margin: 0.055, suspendMs: 4000 };
function priceFromProbs(ps) {
  const tot = ps.reduce((a, b) => a + b, 0);
  return ps.map((p) => {
    const q = Math.max(p / tot, 0.004);
    return Math.max(1.01, +((1 / q) * (1 - CONFIG.margin)).toFixed(2));
  });
}
function lockOdds(...vals) { return vals.some((v) => v <= 1.02); }

function footballProbs(m) {
  const rem = Math.max(0, (m.live ? 90 - m.minute : 90)) / 90;
  const lh = m.str[0] * rem + 0.001, la = m.str[1] * rem + 0.001;
  let pH = 0, pD = 0, pA = 0, pOv = 0, pBtts = 0, pAHhome = 0, pAHaway = 0;
  const ah = m.ahLine || 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = pois(i, lh) * pois(j, la);
      const H = m.score[0] + i, A = m.score[1] + j;
      if (H > A) pH += p; else if (H === A) pD += p; else pA += p;
      if (H + A > m.line) pOv += p;
      if (H > 0 && A > 0) pBtts += p;
      const adj = (H + ah) - A;
      if (adj > 0.001) pAHhome += p; else if (adj < -0.001) pAHaway += p; else { pAHhome += p / 2; pAHaway += p / 2; }
    }
  }
  // 1st-half-only model: purely pregame-shaped off m.str, independent of the
  // live in-match score/minute — the first half doesn't care what happens in
  // the second, and once htScore exists the HT market is closed anyway.
  let pH1 = 0, pD1 = 0, pA1 = 0;
  const lh1 = m.str[0] * 0.5 + 0.001, la1 = m.str[1] * 0.5 + 0.001;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = pois(i, lh1) * pois(j, la1);
      if (i > j) pH1 += p; else if (i === j) pD1 += p; else pA1 += p;
    }
  }
  const pHY = pH * pBtts, pHN = pH * (1 - pBtts), pDY = pD * pBtts, pDN = pD * (1 - pBtts), pAY = pA * pBtts, pAN = pA * (1 - pBtts);
  return { pH, pD, pA, pOv, pBtts, pAHhome, pAHaway, pH1, pD1, pA1, pHY, pHN, pDY, pDN, pAY, pAN };
}

function priceMatch(m) {
  m.prevOdds = JSON.parse(JSON.stringify(m.markets || {}));
  if (m.sport === 'football') {
    if (!m.live) m.ahLine = Math.round((m.str[1] - m.str[0]) * 2) / 2;
    // Keep the total-goals line ahead of the game itself: once the scoreline
    // already clears the quoted line, "Over" is a certainty, not a bet — a
    // real book moves the line up instead of quoting odds that can't lose.
    while (m.score[0] + m.score[1] >= m.line) m.line += 1;
    const { pH, pD, pA, pOv, pBtts, pAHhome, pAHaway, pH1, pD1, pA1, pHY, pHN, pDY, pDN, pAY, pAN } = footballProbs(m);
    const [h, d, a] = priceFromProbs([pH, pD, pA]);
    const [o, u] = priceFromProbs([pOv, 1 - pOv]);
    const [y, n] = priceFromProbs([pBtts, 1 - pBtts]);
    const [dc1x, dc12, dcx2] = priceFromProbs([pH + pD, pH + pA, pD + pA]);
    const [h1, d1, a1] = priceFromProbs([pH1, pD1, pA1]);
    const [wHY, wHN, wDY, wDN, wAY, wAN] = priceFromProbs([pHY, pHN, pDY, pDN, pAY, pAN]);
    const [ahH, ahA] = priceFromProbs([pAHhome, pAHaway]);
    const ah = m.ahLine || 0;
    m.markets = {
      '1X2': { label: 'Match result', closed: lockOdds(h, d, a), sel: [{ k: '1', n: m.home, o: h }, { k: 'X', n: 'Draw', o: d }, { k: '2', n: m.away, o: a }] },
      'OU': { label: 'Total goals ' + m.line, line: m.line, closed: lockOdds(o, u), sel: [{ k: 'O', n: 'Over ' + m.line, o }, { k: 'U', n: 'Under ' + m.line, o: u }] },
      'BTTS': { label: 'Both teams to score', closed: lockOdds(y, n), sel: [{ k: 'Y', n: 'Yes', o: y }, { k: 'N', n: 'No', o: n }] },
      'DC': { label: 'Double chance', closed: lockOdds(dc1x, dc12, dcx2), sel: [{ k: '1X', n: m.home + ' or draw', o: dc1x }, { k: '12', n: m.home + ' or ' + m.away, o: dc12 }, { k: 'X2', n: 'Draw or ' + m.away, o: dcx2 }] },
      'HT': { label: '1st half result' + (m.htScore ? ' (closed — 1st half finished ' + m.htScore.join('–') + ')' : ''), closed: !!m.htScore || lockOdds(h1, d1, a1), sel: [{ k: '1', n: m.home, o: h1 }, { k: 'X', n: 'Draw', o: d1 }, { k: '2', n: m.away, o: a1 }] },
      'WBTTS': { label: 'Win & both teams to score', closed: lockOdds(wHY, wHN, wDY, wDN, wAY, wAN), sel: [
        { k: 'HY', n: m.home + ' & BTTS Yes', o: wHY }, { k: 'HN', n: m.home + ' & BTTS No', o: wHN },
        { k: 'DY', n: 'Draw & BTTS Yes', o: wDY }, { k: 'DN', n: 'Draw & BTTS No', o: wDN },
        { k: 'AY', n: m.away + ' & BTTS Yes', o: wAY }, { k: 'AN', n: m.away + ' & BTTS No', o: wAN } ] },
      'AH': { label: 'Handicap (' + (ah > 0 ? '+' : '') + ah + ')', line: ah, closed: lockOdds(ahH, ahA), sel: [{ k: '1', n: m.home + ' ' + (ah > 0 ? '+' : '') + ah, o: ahH }, { k: '2', n: m.away + ' ' + (-ah > 0 ? '+' : '') + (-ah), o: ahA }] },
    };
  } else if (m.sport === 'tennis') {
    let p = m.str[0];
    if (m.live) { const lead = (m.sets[0] - m.sets[1]) * .12 + (m.games[0] - m.games[1]) * .025; p = Math.min(.97, Math.max(.03, p + lead)); }
    const [h, a] = priceFromProbs([p, 1 - p]);
    const closeness = 1 - Math.min(1, Math.abs(p - 0.5) * 2);
    const gamesSoFar = m.live ? (m.games[0] + m.games[1] + (m.sets[0] + m.sets[1]) * 6) : 0;
    const setsSoFar = m.sets[0] + m.sets[1];
    const projSets = Math.max(setsSoFar + 0.15, 2 + closeness * 0.85);
    const projTotal = gamesSoFar + (projSets - setsSoFar) * 9.3;
    const line = m.live ? Math.max(gamesSoFar + 1.5, Math.round(projTotal - 0.5) + 0.5) : Math.round(projTotal - 0.5) + 0.5;
    const sdTot = m.live ? Math.max(1.5, 3 + closeness * 2) : 4.5 + closeness * 2.5;
    const pOv = Math.max(0.03, Math.min(0.97, 1 - normCdf((line - projTotal) / sdTot)));
    const [o, u] = priceFromProbs([pOv, 1 - pOv]);
    m.markets = {
      'ML': { label: 'Match winner', closed: lockOdds(h, a), sel: [{ k: '1', n: m.home, o: h }, { k: '2', n: m.away, o: a }] },
      'OU': { label: 'Total games ' + line, line, closed: lockOdds(o, u), sel: [{ k: 'O', n: 'Over ' + line, o }, { k: 'U', n: 'Under ' + line, o: u }] },
    };
  } else {
    const isNfl = m.sport === 'nfl';
    const totLen = isNfl ? 60 : 48;
    const remFrac = m.live ? Math.max(.02, (totLen - m.minute) / totLen) : 1;
    const edge = (m.str[0] - m.str[1]) * remFrac + (m.score[0] - m.score[1]);
    const sd = isNfl ? 9.5 * Math.sqrt(remFrac) + 2 : 11 * Math.sqrt(remFrac) + 2;
    const p = 1 / (1 + Math.exp(-edge / (sd * 0.5)));
    const [h, a] = priceFromProbs([p, 1 - p]);
    const sp = +(-(edge)).toFixed(1);
    const coverProb = Math.max(0.04, Math.min(0.96, 1 - normCdf((-sp - edge) / sd)));
    const [sh, sa] = priceFromProbs([coverProb, 1 - coverProb]);
    const tot = +(m.score[0] + m.score[1] + (m.str[0] + m.str[1]) * remFrac).toFixed(1);
    const line = Math.round(tot * 2) / 2;
    const sdOU = isNfl ? 7 * Math.sqrt(remFrac) + 2.5 : 9 * Math.sqrt(remFrac) + 2.5;
    const pOv = Math.max(0.03, Math.min(0.97, 1 - normCdf((line - tot) / sdOU)));
    const [o, u] = priceFromProbs([pOv, 1 - pOv]);
    m.markets = {
      'ML': { label: 'Moneyline', closed: lockOdds(h, a), sel: [{ k: '1', n: m.home, o: h }, { k: '2', n: m.away, o: a }] },
      'SP': { label: 'Spread', line: sp, closed: lockOdds(sh, sa), sel: [{ k: '1', n: m.home + ' ' + (sp > 0 ? '+' : '') + sp, o: sh }, { k: '2', n: m.away + ' ' + (-sp > 0 ? '+' : '') + (-sp), o: sa }] },
      'OU': { label: 'Total points ' + line, line, closed: lockOdds(o, u), sel: [{ k: 'O', n: 'Over ' + line, o }, { k: 'U', n: 'Under ' + line, o: u }] },
    };
  }
}

function makeMatch(sport, league, home, away, live) {
  const m = {
    id: uid('m'), sport, league, home, away, live: !!live, minute: 0,
    score: [0, 0], ended: false, markets: {}, prevOdds: {}, momentum: 50,
    suspendedUntil: 0, suspClosed: true, lastScorer: null, events: [],
    start: live ? now() - rnd(5, 50) * 60000 : now() + rnd(0.5, 48) * 3600000,
  };
  if (sport === 'football') { m.str = [rnd(.9, 2.1), rnd(.8, 1.9)]; m.line = 2.5; m.ahLine = 0; }
  else if (sport === 'basketball') { m.str = [rnd(105, 122), rnd(104, 120)]; }
  else if (sport === 'nfl') { m.str = [rnd(19, 29), rnd(18, 28)]; }
  else { m.str = [rnd(.46, .62), 0]; m.sets = [0, 0]; m.games = [0, 0]; }
  priceMatch(m);
  return m;
}
function capFor(m) { return m.sport === 'football' ? 90 : m.sport === 'tennis' ? 150 : (m.sport === 'nfl' ? 60 : 48); }
function suspendMatch(m, ms) { m.suspendedUntil = now() + ms; m.suspClosed = false; }
function isSuspended(m) { return m && m.suspendedUntil && now() < m.suspendedUntil; }

function pushEvent(m, partial) {
  const e = Object.assign({ t: now(), mn: m.minute }, partial);
  m.events.unshift(e);
  m.events = m.events.slice(0, 40);
}
function stepMinute(m) {
  m.minute++;
  if (m.sport === 'football' && m.minute === 45 && !m.htScore) {
    m.htScore = [...m.score];
    // Half-time marker event — purely additive to the event feed (never read
    // by settlement), used client-side to trigger the half-time banner in the
    // pitch celebration overlay the same way a goal triggers "GOAL!".
    pushEvent(m, { kind: 'half', txt: 'Half-time — ' + m.htScore.join('–') });
  }
  const cap = capFor(m);
  // Momentum: a slow random walk biased toward whichever side is currently
  // stronger/ahead, so the momentum bar on the watch page actually moves
  // instead of sitting frozen at 50/50 for the whole match.
  if (m.momentum == null) m.momentum = 50;
  const strBias = (m.str[0] - m.str[1]) / (Math.abs(m.str[0]) + Math.abs(m.str[1]) + 0.01);
  const scoreBias = Math.sign((m.score[0] || 0) - (m.score[1] || 0));
  m.momentum = Math.max(6, Math.min(94, m.momentum + rnd(-6, 6) + strBias * 3 + scoreBias * 2));
  if (m.sport === 'football') {
    if (Math.random() < 0.035) {
      const side = Math.random() < m.str[0] / (m.str[0] + m.str[1]) ? 0 : 1;
      m.score[side]++; m.lastScorer = side; suspendMatch(m, CONFIG.suspendMs);
      pushEvent(m, { side, kind: 'goal', txt: 'Goal — ' + (side ? m.away : m.home) + ' ' + m.score.join('–') });
    }
  } else if (m.sport === 'tennis') {
    if (Math.random() < 0.28) {
      const side = Math.random() < m.str[0] ? 0 : 1;
      m.games[side]++;
      if (m.games[side] >= 6 && m.games[side] - m.games[1 - side] >= 2) { m.sets[side]++; m.games = [0, 0]; pushEvent(m, { side, kind: 'set', txt: 'Set won — ' + (side ? m.away : m.home) }); }
      else pushEvent(m, { side, kind: 'game', txt: 'Game — ' + (side ? m.away : m.home) });
      m.score = m.sets;
    }
  } else {
    if (Math.random() < 0.5) {
      const side = Math.random() < .5 ? 0 : 1;
      const pts = m.sport === 'nfl' ? pick([3, 3, 7, 7, 7, 6]) : pick([2, 2, 2, 3, 3]);
      m.score[side] += pts; m.lastScorer = side; suspendMatch(m, CONFIG.suspendMs);
      pushEvent(m, { side, kind: 'score', txt: (side ? m.away : m.home) + ' +' + pts + ' — ' + m.score.join('–') });
    }
  }
  if (m.minute >= cap) {
    // Full-time marker — same purpose as the half-time one above: the client
    // celebration overlay looks for kind 'half'/'full' on the most recent
    // event to show the HT/FT banner instead of a goal burst.
    pushEvent(m, { kind: 'full', txt: 'Full-time — ' + m.score.join('–') });
    m.ended = true; m.live = false; return true;
  }
  return false;
}
function advanceMatch(m) {
  if (!m.liveStart) m.liveStart = now() - m.minute * SEC_PER_MATCH_MIN * 1000;
  const cap = capFor(m);
  const target = Math.min(cap, Math.floor((now() - m.liveStart) / 1000 / SEC_PER_MATCH_MIN));
  let guard = 0;
  while (m.minute < target && guard < cap + 5) { guard++; if (stepMinute(m)) return true; }
  return false;
}

// ---------- persistence ----------
function rowToMatch(row) { return JSON.parse(row.data); }
function saveMatch(m) {
  db.prepare(`INSERT INTO matches (id, sport, league, home, away, start, live, ended, verified, data)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET sport=excluded.sport, league=excluded.league, home=excluded.home,
      away=excluded.away, start=excluded.start, live=excluded.live, ended=excluded.ended,
      verified=excluded.verified, data=excluded.data`)
    .run(m.id, m.sport, m.league, m.home, m.away, Math.round(m.start), m.live ? 1 : 0, m.ended ? 1 : 0, m.verified ? 1 : 0, JSON.stringify(m));
}
function getMatch(id) {
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  return row ? rowToMatch(row) : null;
}
function listMatches({ sport, live, ended } = {}) {
  let sql = 'SELECT * FROM matches WHERE 1=1';
  const args = [];
  if (sport) { sql += ' AND sport = ?'; args.push(sport); }
  if (live !== undefined) { sql += ' AND live = ?'; args.push(live ? 1 : 0); }
  if (ended !== undefined) { sql += ' AND ended = ?'; args.push(ended ? 1 : 0); }
  sql += ' ORDER BY start ASC';
  return db.prepare(sql).all(...args).map(rowToMatch);
}

// ---------- user-started FIFA-style simulations ----------
// Everything on this board is already a simulation under the hood — there's
// no real live-data feed — but this is the one kind of match a user starts
// themselves, on demand, right now, rather than waiting for the schedule.
// It runs through the exact same makeMatch/priceMatch/advanceMatch/settleMatch
// pipeline as every other match (the shared tick() loop below already
// advances/reprices/settles it with no special-casing needed) — the only
// difference is `m.sim`/`m.simOwner`, which the API layer uses to keep these
// out of the regular sport boards and list them in their own section instead.
const MAX_SIMS_PER_USER = 3;
function countUserSims(userId) {
  return listMatches({ ended: false }).filter((m) => m.sim && m.simOwner === userId).length;
}
function startSim(userId, sport) {
  if (!TEAMS[sport]) return { error: 'Unknown sport.' };
  if (countUserSims(userId) >= MAX_SIMS_PER_USER) return { error: `You can only run ${MAX_SIMS_PER_USER} simulations at once — wait for one to finish.` };
  const teams = Object.values(TEAMS[sport])[0];
  const pool = [...teams];
  const home = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const away = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const m = makeMatch(sport, 'FIFA Simulation', home, away, true);
  m.sim = true;
  m.simOwner = userId;
  m.minute = 0; m.liveStart = now(); m.start = now(); m.score = [0, 0];
  if (sport === 'tennis') { m.sets = [0, 0]; m.games = [0, 0]; }
  priceMatch(m);
  saveMatch(m);
  return { match: m };
}
function listSims() {
  return listMatches({ ended: false }).filter((m) => m.sim);
}

function pairAllTeams(teams) {
  const pool = [...teams];
  const pairs = [];
  while (pool.length > 1) {
    const h = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    pairs.push([h, a]);
  }
  return pairs;
}
// Generates a fresh, all-pregame batch of fixtures for one sport/league,
// staggered a few minutes to an hour apart — used both for the very first
// seed and later to keep topping the board up (see topUpFixtures) so a sport
// never runs dry once its initial slate has finished.
function genFixtures(sportId, league, teams) {
  pairAllTeams(teams).forEach((p, i) => {
    const m = makeMatch(sportId, league, p[0], p[1], false);
    m.start = now() + (i + 1) * rnd(2, 6) * 60000;
    saveMatch(m);
  });
}
// ---------- verified real-world fixtures (example data) ----------
// A small, clearly-labeled set of EXAMPLE fixtures for a couple of
// recognizable real competitions, mirroring the original prototype's
// REAL_FIXTURES pattern. There's no live real-world results feed behind
// this — these are just real team names/competitions with a kickoff time
// computed relative to `now()` (next occurrence of a given weekday/hour) so
// they never look stale, unlike a hardcoded past date would. They're seeded
// once alongside the normal procedural fixtures and marked m.verified = true,
// same flag the admin-added-fixture flow already uses for its "✓ Verified" badge.
function nextWeekday(targetDow, hour, minute) {
  const d = new Date();
  d.setHours(hour, minute || 0, 0, 0);
  let add = (targetDow - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now()) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}
function buildRealFixtures() {
  // One matchday's worth of headline, real-team fixtures per league already
  // on the board (plus Champions League), so every league — not just one —
  // has a verified, "✓ Verified" fixture in its own rotation, the same
  // spread-across-every-league approach the client-only artifact used.
  return [
    { league: 'Premier League', home: 'Arsenal', away: 'Liverpool', start: nextWeekday(6, 15, 0) },
    { league: 'Premier League', home: 'Man City', away: 'Chelsea', start: nextWeekday(6, 17, 30) },
    { league: 'Premier League', home: 'Tottenham', away: 'Man United', start: nextWeekday(0, 16, 0) },
    { league: 'La Liga', home: 'Real Madrid', away: 'Barcelona', start: nextWeekday(6, 21, 0) },
    { league: 'La Liga', home: 'Atlético Madrid', away: 'Sevilla', start: nextWeekday(0, 18, 30) },
    { league: 'Serie A', home: 'Inter', away: 'Juventus', start: nextWeekday(6, 19, 45) },
    { league: 'Serie A', home: 'Milan', away: 'Napoli', start: nextWeekday(0, 20, 45) },
    { league: 'Bundesliga', home: 'Bayern Munich', away: 'Borussia Dortmund', start: nextWeekday(5, 19, 30) },
    { league: 'Bundesliga', home: 'RB Leipzig', away: 'Bayer Leverkusen', start: nextWeekday(6, 16, 30) },
    { league: 'Ligue 1', home: 'Paris Saint-Germain', away: 'Marseille', start: nextWeekday(0, 20, 45) },
    { league: 'UEFA Champions League', home: 'Real Madrid', away: 'Bayern Munich', start: nextWeekday(2, 21, 0) },
    { league: 'UEFA Champions League', home: 'Paris Saint-Germain', away: 'Inter', start: nextWeekday(2, 21, 0) },
    { league: 'UEFA Champions League', home: 'Barcelona', away: 'Manchester City', start: nextWeekday(3, 21, 0) },
  ];
}
function seedRealFixtures() {
  for (const fx of buildRealFixtures()) {
    const m = makeMatch('football', fx.league, fx.home, fx.away, false);
    m.start = fx.start;
    m.verified = true;
    saveMatch(m);
  }
}
// Kicks a single fixture off mid-match (random elapsed clock/score) — shared
// by the boot-time seed below and used to bring a league straight to a live
// match instead of waiting for its scheduled kickoff.
function kickOffMidMatch(m) {
  const cap = capFor(m);
  const elapsed = Math.floor(rnd(6, Math.min(cap - 4, cap * 0.7)));
  m.live = true; m.minute = elapsed; m.liveStart = now() - elapsed * SEC_PER_MATCH_MIN * 1000;
  m.start = now() - elapsed * 60000; m.momentum = 50;
  if (m.sport === 'football') m.score = [Math.floor(rnd(0, 3)), Math.floor(rnd(0, 3))];
  else if (m.sport === 'tennis') { m.sets = [Math.floor(rnd(0, 2)), Math.floor(rnd(0, 2))]; m.games = [Math.floor(rnd(0, 6)), Math.floor(rnd(0, 6))]; m.score = m.sets; }
  else { const f = elapsed / cap; m.score = [Math.round(m.str[0] * f), Math.round(m.str[1] * f)]; }
  priceMatch(m);
  saveMatch(m);
}
function seedIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM matches').get();
  if (c > 0) return;
  seedRealFixtures();
  for (const s of SPORTS) {
    for (const [lg, teams] of Object.entries(TEAMS[s.id])) {
      genFixtures(s.id, lg, teams);
      // Kick MAX_LIVE_PER_LEAGUE matches off immediately (mid-match) so every
      // league starts with a full slate of live action the moment the server
      // boots, instead of a mostly-empty board that only fills in as
      // fixtures individually reach their scheduled kickoff time.
      const rows = listMatches({ sport: s.id, live: false, ended: false }).filter((m) => m.league === lg);
      rows.slice(0, MAX_LIVE_PER_LEAGUE).forEach(kickOffMidMatch);
    }
  }
}
// Keeps every sport/league stocked with upcoming fixtures. Without this, a
// short-clocked sport (basketball/NFL run their whole "match minute" clock
// in a couple of real minutes) would burn through its one-time seeded slate
// and the board would go permanently empty — a real book never runs out of
// fixtures, so neither should this one.
const MIN_POOL_PER_LEAGUE = 3;
function topUpFixtures() {
  for (const s of SPORTS) {
    for (const [lg, teams] of Object.entries(TEAMS[s.id])) {
      const remaining = listMatches({ sport: s.id, ended: false }).filter((m) => m.league === lg);
      if (remaining.length < MIN_POOL_PER_LEAGUE) genFixtures(s.id, lg, teams);
    }
  }
}

// Per-LEAGUE cap, not per-sport — with 5 football leagues on the board, a
// single sport-wide cap of 3 meant at most 3 live football matches total no
// matter how many leagues existed. Capping per league instead means every
// league gets its own shot at having something live, so the board actually
// fills up the way a real multi-league book's does ("many matches, real and
// live" rather than a handful of matches starved across five competitions).
const MAX_LIVE_PER_LEAGUE = 2;
function maybeKickoff() {
  for (const s of SPORTS) {
    for (const lg of Object.keys(TEAMS[s.id])) {
      const live = listMatches({ sport: s.id, live: true, ended: false }).filter((m) => m.league === lg);
      if (live.length >= MAX_LIVE_PER_LEAGUE) continue;
      const upcoming = listMatches({ sport: s.id, live: false, ended: false }).filter((m) => m.league === lg);
      if (!upcoming.length) continue;
      let due = upcoming.filter((m) => m.start <= now());
      // Never let a league's board go completely dark: if nothing is live at
      // all in this league, kick off the soonest upcoming fixture right away
      // instead of waiting out its scheduled start — a real book always has
      // *something* on, even if the strict schedule says otherwise.
      if (!due.length) {
        if (live.length === 0) due = [upcoming.sort((a, b) => a.start - b.start)[0]];
        else continue; // wait for a fixture's own kick-off time, same as a real schedule
      }
      const m = pick(due);
      m.live = true; m.minute = 0; m.liveStart = now(); m.momentum = 50; m.score = [0, 0];
      if (m.sport === 'tennis') { m.sets = [0, 0]; m.games = [0, 0]; }
      priceMatch(m);
      saveMatch(m);
    }
  }
}

// One tick = one server-authoritative step of the whole live board: advance
// every live match's clock/score, drift pregame prices, settle anything that
// just finished (via the injected callback so this module stays DB-schema
// agnostic about bets), and persist every touched match back to SQLite.
function tick(onSettle) {
  const live = listMatches({ live: true, ended: false });
  for (const m of live) {
    const ended = advanceMatch(m);
    // advanceMatch()/stepMinute() only ever touch the clock/score — they never
    // reprice the match themselves (priceMatch() is otherwise only called once
    // at kickoff and once more here). Without this, every live match's odds
    // were computed exactly once at kickoff and then frozen for the entire
    // game, never reacting to the clock running down OR to goals actually
    // being scored — the single biggest thing that should move a live price.
    // Reprice every still-live match on every tick so odds track time/score
    // the way a real in-play book does; a match that just ended keeps its
    // final pre-settlement price frozen, which is correct.
    if (!ended) priceMatch(m);
    saveMatch(m);
    if (ended && onSettle) onSettle(m);
  }
  const pregame = listMatches({ live: false, ended: false }).filter((m) => !m.verified);
  for (const m of pregame) {
    if (Math.random() > 0.4) continue;
    if (m.driftBias == null || Math.random() < 0.05) m.driftBias = rnd(-1, 1);
    const bias = m.driftBias;
    if (m.sport === 'football') { m.str[0] *= rnd(.97, 1.03) * (1 + bias * 0.01); m.str[1] *= rnd(.97, 1.03) * (1 - bias * 0.01); }
    else { m.str[0] *= rnd(.988, 1.012) * (1 + bias * 0.006); m.str[1] *= rnd(.988, 1.012) * (1 - bias * 0.006); }
    priceMatch(m);
    saveMatch(m);
  }
  topUpFixtures();
  maybeKickoff();
}

let engineTimer = null;
function startEngine(onSettle) {
  if (engineTimer) return;
  seedIfEmpty();
  maybeKickoff();
  engineTimer = setInterval(() => tick(onSettle), 3000);
}

module.exports = {
  TEAMS, SPORTS, priceMatch, makeMatch, isSuspended, capFor,
  saveMatch, getMatch, listMatches, startEngine, CONFIG,
  startSim, listSims, MAX_SIMS_PER_USER, suspendMatch,
};
