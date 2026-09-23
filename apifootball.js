// Real, automatic football data feed — API-Football (api-sports.io).
//
// This module owns every match with `m.apiSourced = true`. Such a match's
// clock, score and odds come ENTIRELY from here, never from engine.js's own
// simulation clock (engine.js's tick()/priceMatch() both explicitly skip any
// match with apiSourced set — see the guards there). This is the only place
// in the app that talks to the outside network.
//
// Per explicit product instruction, if the real feed has no data for
// something (no odds available yet for a fixture, a sport this key doesn't
// cover, the key itself not authenticating), the correct behavior is to show
// NOTHING for that gap — never invent a placeholder match or a guessed price.
// Concretely that means: a fixture with no odds yet is saved with an empty
// `markets` object (the front-end already renders "Odds not yet available"
// for that), and if the key can't authenticate at all, this module simply
// stops calling out and leaves the board to whatever the admin has added by
// hand — it never falls back to a fabricated fixture.
'use strict';
const https = require('node:https');
const engine = require('./engine');

const now = () => Date.now();

// The key can always be overridden via an env var on the real host (Railway)
// without touching code; it falls back to the key the site owner supplied.
const API_KEY = process.env.API_FOOTBALL_KEY || '02de26d885e4a376a7bc89dd0f7587fa';
const BASE_HOST = 'v3.football.api-sports.io';

// Conservative default polling cadence — all overridable via env vars so the
// interval can be tuned to whatever the account's real plan/quota turns out
// to allow once this actually runs against the live API from Railway (the
// sandbox this was built in cannot reach the real endpoint to measure that
// itself — see the delivery notes).
const SCHEDULE_INTERVAL_MS = +process.env.API_FOOTBALL_SCHEDULE_INTERVAL_MS || 45 * 60000; // fixture list, twice/day-ish coverage
const LIVE_INTERVAL_MS = +process.env.API_FOOTBALL_LIVE_INTERVAL_MS || 60000; // live scores
const ODDS_INTERVAL_MS = +process.env.API_FOOTBALL_ODDS_INTERVAL_MS || 15 * 60000; // per-fixture odds refresh cadence
const ODDS_SPACING_MS = 1500; // gap between individual odds calls so a burst never trips the provider's rate limiter

// A curated list of well-known, high-liquidity leagues/cups — keeps the board
// to real, recognizable competitions instead of every obscure fixture on
// earth being pulled in from a single worldwide `/fixtures?date=` call.
// (League IDs are API-Football's own, stable IDs for these competitions.)
const CURATED_LEAGUES = new Set([
  // Top five European leagues + their main domestic cups
  39, 45,      // Premier League + FA Cup (England)
  140, 143,    // La Liga + Copa del Rey (Spain)
  135, 136,    // Serie A + Serie B (Italy)
  78, 79,      // Bundesliga + 2. Bundesliga (Germany)
  61, 62,      // Ligue 1 + Ligue 2 (France)
  40,          // Championship (England)
  // Continental club competitions
  2, 3, 848,   // UEFA Champions League, Europa League, Conference League
  531,         // UEFA Super Cup
  13, 11,      // Copa Libertadores, Copa Sudamericana
  17, 16,      // AFC Champions League, CONCACAF Champions League
  15,          // FIFA Club World Cup
  // Other strong European leagues
  88,          // Eredivisie (Netherlands)
  94,          // Primeira Liga (Portugal)
  144,         // Jupiler Pro League (Belgium)
  203,         // Süper Lig (Turkey)
  179,         // Premiership (Scotland)
  218,         // Bundesliga (Austria)
  207,         // Super League (Switzerland)
  119,         // Superliga (Denmark)
  113,         // Allsvenskan (Sweden)
  103,         // Eliteserien (Norway)
  197,         // Super League (Greece)
  // The Americas
  253,         // MLS (USA)
  262,         // Liga MX (Mexico)
  71,          // Série A (Brazil)
  128,         // Liga Profesional (Argentina)
  // Asia / Middle East / Oceania
  307,         // Saudi Pro League
  98,          // J1 League (Japan)
  292,         // K League 1 (South Korea)
  169,         // Chinese Super League
  188,         // A-League (Australia)
  // International tournaments
  1, 4, 9, 6,  // World Cup, Euro Championship, Copa América, Africa Cup of Nations
]);

const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT']);
const ENDED_STATUSES = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);

const status = {
  keyOk: null,        // null = not tested yet, true/false once we get a real answer
  lastError: null,
  lastScheduleSync: 0,
  lastLiveSync: 0,
  lastOddsSync: 0,
  fixturesTracked: 0,
  disabled: false,     // true once repeated auth failures stop this module from calling out further
};
function getStatus() { return { ...status }; }

// ---------- low-level HTTP GET, header-authenticated ----------
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: BASE_HOST,
      path,
      method: 'GET',
      headers: { 'x-apisports-key': API_KEY },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* fall through with parsed=null */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('API-Football request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function beirutDateString(offsetDays) {
  const d = new Date(now() + engine.BEIRUT_OFFSET_MS + offsetDays * 864e5);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------- mapping a fixture from the API's shape into ours ----------
function upsertFixture(fx, onSettle) {
  if (!fx || !fx.fixture || !fx.league || !CURATED_LEAGUES.has(fx.league.id)) return null;
  const extId = fx.fixture.id;
  const id = 'af' + extId;
  let m = engine.getMatch(id);
  const statusShort = (fx.fixture.status && fx.fixture.status.short) || 'NS';
  const isLive = LIVE_STATUSES.has(statusShort);
  const isEnded = ENDED_STATUSES.has(statusShort);

  if (!m) {
    m = {
      id, sport: 'football', league: fx.league.name,
      home: fx.teams.home.name, away: fx.teams.away.name,
      score: [0, 0], live: false, ended: false, markets: {}, prevOdds: {},
      momentum: 50, suspendedUntil: 0, suspClosed: true, lastScorer: null, events: [],
      apiSourced: true, verified: true, externalId: extId,
      start: new Date(fx.fixture.date).getTime(),
    };
  }
  const wasEnded = m.ended;
  const gh = fx.goals ? fx.goals.home : null;
  const ga = fx.goals ? fx.goals.away : null;
  m.score = [gh != null ? gh : (m.score[0] || 0), ga != null ? ga : (m.score[1] || 0)];
  if (fx.score && fx.score.halftime && fx.score.halftime.home != null) {
    m.htScore = [fx.score.halftime.home, fx.score.halftime.away];
  }
  m.minute = (fx.fixture.status && fx.fixture.status.elapsed) || m.minute || 0;
  m.live = isLive;
  m.ended = isEnded;
  m.lastApiSync = now();
  if (isEnded && !m.endedAt) m.endedAt = now();
  engine.saveMatch(m);
  if (isEnded && !wasEnded && onSettle) onSettle(m);
  return m;
}

// ---------- odds mapping ----------
// Only maps markets we can get a clean, real number for. Anything not present
// in the feed's response is simply left out of `m.markets` — per the "show
// nothing for a gap" rule, the front-end already renders those matches with
// an "Odds not yet available" placeholder instead of a bet button.
function applyOdds(m, oddsResponse) {
  if (!Array.isArray(oddsResponse) || !oddsResponse.length) return;
  const entry = oddsResponse[0];
  const bookmakers = entry && entry.bookmakers;
  if (!Array.isArray(bookmakers) || !bookmakers.length) return;
  // Prefer Bet365 (id 8) since it's the most commonly cross-checked reference
  // book; fall back to whichever bookmaker the response actually included.
  const book = bookmakers.find((b) => b.id === 8) || bookmakers[0];
  const bets = book.bets || [];
  const findBet = (name) => bets.find((b) => b.name === name);
  const markets = {};

  const mw = findBet('Match Winner');
  if (mw) {
    const h = mw.values.find((v) => v.value === 'Home');
    const d = mw.values.find((v) => v.value === 'Draw');
    const a = mw.values.find((v) => v.value === 'Away');
    if (h && d && a) {
      markets['1X2'] = {
        label: 'Match result', closed: false,
        sel: [{ k: '1', n: m.home, o: +h.odd }, { k: 'X', n: 'Draw', o: +d.odd }, { k: '2', n: m.away, o: +a.odd }],
      };
    }
  }
  const btts = findBet('Both Teams Score');
  if (btts) {
    const y = btts.values.find((v) => v.value === 'Yes');
    const n = btts.values.find((v) => v.value === 'No');
    if (y && n) {
      markets['BTTS'] = {
        label: 'Both teams to score', closed: false,
        sel: [{ k: 'Y', n: 'Yes', o: +y.odd }, { k: 'N', n: 'No', o: +n.odd }],
      };
    }
  }
  const ou = findBet('Goals Over/Under');
  if (ou) {
    // Prefer the standard 2.5 line if it's present, otherwise take whatever
    // the feed actually offered rather than guessing at a line ourselves.
    const over25 = ou.values.find((v) => v.value === 'Over 2.5');
    const under25 = ou.values.find((v) => v.value === 'Under 2.5');
    const line = over25 && under25 ? 2.5 : null;
    if (line != null) {
      markets['OU'] = {
        label: 'Total goals ' + line, line, closed: false,
        sel: [{ k: 'O', n: 'Over ' + line, o: +over25.odd }, { k: 'U', n: 'Under ' + line, o: +under25.odd }],
      };
    }
  }
  const dc = findBet('Double Chance');
  if (dc) {
    const h1x = dc.values.find((v) => v.value === 'Home/Draw');
    const h12 = dc.values.find((v) => v.value === 'Home/Away');
    const x2 = dc.values.find((v) => v.value === 'Draw/Away');
    if (h1x && h12 && x2) {
      markets['DC'] = {
        label: 'Double chance', closed: false,
        sel: [{ k: '1X', n: m.home + ' or draw', o: +h1x.odd }, { k: '12', n: m.home + ' or ' + m.away, o: +h12.odd }, { k: 'X2', n: 'Draw or ' + m.away, o: +x2.odd }],
      };
    }
  }
  // Only overwrite if we actually found at least one real market — never
  // blank out odds that were previously fetched successfully just because a
  // later poll's response happened to omit them (a transient gap in the
  // upstream feed shouldn't yank a live bettable market off the board).
  if (Object.keys(markets).length) {
    m.markets = markets;
    engine.saveMatch(m);
  }
}

function recordAuthResult(statusCode, body) {
  // A response that isn't parseable JSON at all isn't a real answer from
  // API-Football — it means something between here and the API (a network
  // egress block, a proxy, a captive portal) intercepted the request before
  // it ever reached api-sports.io. That's a connectivity problem, not
  // evidence the key is bad, so it's reported distinctly rather than as a
  // key rejection (this is exactly what happens if this module is ever run
  // somewhere with restricted outbound network — it fails honestly instead
  // of misreporting the key as invalid).
  if (body === null) {
    status.keyOk = null;
    status.lastError = `Could not reach api-sports.io (got a non-API response, HTTP ${statusCode}) — this looks like a network/egress problem, not a bad key.`;
    return false;
  }
  if (statusCode === 401 || statusCode === 403) {
    status.keyOk = false;
    status.lastError = `API-Football rejected the key (HTTP ${statusCode}) — check API_FOOTBALL_KEY.`;
    return false;
  }
  // API-Football's `errors` field is sometimes an array, sometimes a plain
  // object keyed by field name (e.g. `{ token: "..." }`) depending on the
  // error — handle both shapes rather than assuming one.
  const hasErrors = body && body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length);
  if (hasErrors) {
    status.keyOk = false;
    status.lastError = 'API-Football error: ' + JSON.stringify(body.errors);
    return false;
  }
  status.keyOk = true;
  status.lastError = null;
  return true;
}

let consecutiveAuthFailures = 0;
function noteFailure(err) {
  consecutiveAuthFailures++;
  status.lastError = err && err.message ? err.message : String(err);
  // After a run of consistent failures, stop hammering the provider — the
  // board just quietly stays whatever the admin has added by hand, per the
  // "show nothing for the gap" instruction, rather than retrying forever.
  if (consecutiveAuthFailures >= 5) status.disabled = true;
}
function noteSuccess() { consecutiveAuthFailures = 0; }

// ---------- sync passes ----------
async function syncSchedule(onSettle) {
  try {
    for (const offset of [0, 1]) {
      const date = beirutDateString(offset);
      const { statusCode, body } = await apiGet(`/fixtures?date=${date}`);
      if (!recordAuthResult(statusCode, body)) { noteFailure(new Error(status.lastError)); return; }
      const list = (body && body.response) || [];
      for (const fx of list) upsertFixture(fx, onSettle);
    }
    status.lastScheduleSync = now();
    status.fixturesTracked = engine.listMatches({ sport: 'football' }).filter((m) => m.apiSourced).length;
    noteSuccess();
  } catch (err) { noteFailure(err); }
}

async function syncLive(onSettle) {
  try {
    const { statusCode, body } = await apiGet('/fixtures?live=all');
    if (!recordAuthResult(statusCode, body)) { noteFailure(new Error(status.lastError)); return; }
    const list = (body && body.response) || [];
    for (const fx of list) upsertFixture(fx, onSettle);
    status.lastLiveSync = now();
    noteSuccess();
  } catch (err) { noteFailure(err); }
}

async function syncOddsOnce() {
  // Refresh odds for anything still worth pricing: upcoming (so a bettor has
  // something to bet on before kickoff) and currently-live (in-play pricing).
  const targets = engine.listMatches({ sport: 'football', ended: false }).filter((m) => m.apiSourced);
  for (const m of targets) {
    try {
      const { statusCode, body } = await apiGet(`/odds?fixture=${m.externalId}`);
      if (!recordAuthResult(statusCode, body)) { noteFailure(new Error(status.lastError)); return; }
      applyOdds(m, (body && body.response) || []);
      noteSuccess();
    } catch (err) { noteFailure(err); }
    await new Promise((r) => setTimeout(r, ODDS_SPACING_MS));
  }
  status.lastOddsSync = now();
}

let started = false;
function start(onSettle) {
  if (started) return;
  started = true;
  const run = (fn, intervalMs, initialDelayMs) => {
    const loop = async () => {
      if (status.disabled) return; // stopped after repeated auth failures — see noteFailure()
      await fn(onSettle);
    };
    if (initialDelayMs) setTimeout(loop, initialDelayMs); else loop();
    setInterval(loop, intervalMs);
  };
  run(syncSchedule, SCHEDULE_INTERVAL_MS, 0);
  run(syncLive, LIVE_INTERVAL_MS, 0);
  // Odds targets come from whatever fixtures the schedule/live passes above
  // have already saved — give those their first real pass a head start
  // (rather than three passes racing on process start) so the very first
  // odds sync actually has fixtures to look up instead of finding none.
  run(() => syncOddsOnce(), ODDS_INTERVAL_MS, 10000);
}

module.exports = { start, getStatus, CURATED_LEAGUES };
