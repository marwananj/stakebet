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
// Real, verified/admin fixtures run at genuine real-world speed (a football
// match really does take ~90 real minutes), while FIFA/quick-sim fixtures
// stay compressed into a short, snappy playthrough (~8 real minutes for a
// 90-minute football match). Both are just an override of `m.secPerMin`
// consumed by advanceMatch(); anything without it falls back to the fast
// default pace above (used by the ordinary auto-generated liquidity matches).
const REAL_SEC_PER_MIN = 60; // true 1:1 real time
const FIFA_SEC_PER_MIN = 480 / 90; // ~8 real minutes for a 90-minute match

// ---------- Lebanon (Asia/Beirut, fixed UTC+3 — no DST) time helpers ----------
// Everything "real-world time" in this app — the verified fixture kickoffs
// below and any date/time an admin types in when adding a fixture — is meant
// to be Beirut wall-clock time, not whatever timezone the server process
// itself happens to be running in (a cloud host is typically UTC). Rather
// than depend on the container having Beirut in its ICU/tz database, this
// does the offset arithmetic by hand: a fixed +3h shift is applied, then all
// reads/writes go through the UTC getters/setters on a Date shifted by that
// same amount, so the result is identical no matter the host's own timezone.
const BEIRUT_OFFSET_MS = 3 * 3600000;
// Convert a Beirut wall-clock date/time (as entered by a person) to the real
// UTC epoch ms it corresponds to.
function beirutWallToUtc(year, month /* 1-12 */, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute || 0, 0, 0) - BEIRUT_OFFSET_MS;
}
// The next upcoming occurrence of a given weekday/hour/minute, expressed and
// resolved entirely in Beirut wall-clock time.
function nextWeekday(targetDow, hour, minute) {
  const shiftedNow = now() + BEIRUT_OFFSET_MS; // reading this via UTC getters == Beirut wall clock
  const d = new Date(shiftedNow);
  d.setUTCHours(hour, minute || 0, 0, 0);
  let add = (targetDow - d.getUTCDay() + 7) % 7;
  if (add === 0 && d.getTime() <= shiftedNow) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.getTime() - BEIRUT_OFFSET_MS;
}

// ---------- solving team strengths to match admin-entered 1X2 odds ----------
// An admin typing in odds doesn't set the raw price directly (that would
// freeze it and make every other market — O/U, BTTS, handicap, half-time —
// inconsistent with it, and stop it reacting to goals once live). Instead,
// the entered odds are de-vigged into fair probabilities and this does a
// coarse search over the same [home attack, away attack] "strength" pair
// (m.str) the rest of the engine already uses, picking whichever pair's
// modeled 1X2 probabilities are closest to what was asked for. From there
// the normal priceMatch()/footballProbs() pipeline takes over — every other
// market derives from these same strengths and everything still updates
// live and settles exactly like a procedurally-generated fixture.
function strengthsForOdds(oddsHome, oddsDraw, oddsAway) {
  const rawH = 1 / oddsHome, rawD = 1 / oddsDraw, rawA = 1 / oddsAway;
  const over = rawH + rawD + rawA;
  const targetH = rawH / over, targetD = rawD / over, targetA = rawA / over;
  // Range/step widened from the original 0.3–3.6 (step 0.1) so heavily
  // lopsided real-world odds (a near-certain favourite like 1.02 against a
  // 50+ underdog) can actually be reached — the narrower grid used to bottom
  // out well short of matching odds that skewed, e.g. solving for a "1.025 /
  // 19.00 / 51.00" line landed on something closer to "1.01 / 17.7 / 74.9".
  let best = null, bestErr = Infinity;
  for (let lh = 0.15; lh <= 4.5; lh += 0.05) {
    for (let la = 0.15; la <= 4.5; la += 0.05) {
      let pH = 0, pD = 0, pA = 0;
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const p = pois(i, lh) * pois(j, la);
          if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
        }
      }
      const err = (pH - targetH) ** 2 + (pD - targetD) ** 2 + (pA - targetA) ** 2;
      if (err < bestErr) { bestErr = err; best = [lh, la]; }
    }
  }
  return best;
}

const TEAMS = {
  football: {
    // ---- Europe: top divisions ----
    'Premier League': ['Arsenal', 'Liverpool', 'Man City', 'Chelsea', 'Tottenham', 'Newcastle', 'Aston Villa', 'Brighton', 'Man United', 'West Ham', 'Everton', 'Fulham', 'Wolves', 'Crystal Palace', 'Brentford', 'Nottingham Forest', 'Bournemouth', 'Ipswich', 'Leicester', 'Southampton'],
    'La Liga': ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Athletic Club', 'Real Sociedad', 'Villarreal', 'Real Betis', 'Sevilla', 'Valencia', 'Girona', 'Osasuna', 'Celta Vigo', 'Rayo Vallecano', 'Getafe', 'Mallorca', 'Alavés'],
    'Serie A': ['Inter', 'Juventus', 'Napoli', 'Milan', 'Atalanta', 'Roma', 'Lazio', 'Fiorentina', 'Bologna', 'Torino', 'Udinese', 'Genoa', 'Monza', 'Verona', 'Cagliari', 'Empoli'],
    'Bundesliga': ['Bayern Munich', 'Bayer Leverkusen', 'Borussia Dortmund', 'RB Leipzig', 'Eintracht Frankfurt', 'VfB Stuttgart', 'Wolfsburg', 'Borussia Mönchengladbach', 'Union Berlin', 'Werder Bremen', 'Freiburg', 'Mainz'],
    'Ligue 1': ['PSG', 'Monaco', 'Marseille', 'Lyon', 'Lille', 'Nice', 'Lens', 'Rennes', 'Toulouse', 'Strasbourg', 'Nantes', 'Reims'],
    'Süper Lig': ['Galatasaray', 'Fenerbahçe', 'Beşiktaş', 'Trabzonspor', 'Başakşehir', 'Adana Demirspor', 'Konyaspor', 'Sivasspor'],
    'Primeira Liga': ['Benfica', 'Porto', 'Sporting CP', 'Braga', 'Vitória SC', 'Famalicão', 'Boavista', 'Gil Vicente'],
    'Eredivisie': ['Ajax', 'PSV', 'Feyenoord', 'AZ Alkmaar', 'FC Twente', 'FC Utrecht', 'Sparta Rotterdam'],
    'Belgian Pro League': ['Club Brugge', 'Anderlecht', 'Genk', 'Union SG', 'Antwerp', 'Gent'],
    'Scottish Premiership': ['Celtic', 'Rangers', 'Hearts', 'Aberdeen', 'Hibernian'],
    'Swiss Super League': ['Young Boys', 'Basel', 'Servette', 'Lugano', 'Zurich'],
    'Austrian Bundesliga': ['Red Bull Salzburg', 'Sturm Graz', 'Rapid Wien', 'Austria Wien'],
    'Greek Super League': ['Olympiacos', 'Panathinaikos', 'AEK Athens', 'PAOK'],
    'Ukrainian Premier League': ['Shakhtar Donetsk', 'Dynamo Kyiv', 'Dnipro-1'],
    'Russian Premier League': ['Zenit', 'Spartak Moscow', 'CSKA Moscow', 'Krasnodar'],
    'Championship': ['Leeds United', 'Sunderland', 'West Brom', 'Norwich City', 'Middlesbrough', 'Watford', 'Coventry City', 'Preston North End'],
    'Serie B': ['Parma', 'Como', 'Venezia', 'Palermo', 'Sampdoria', 'Cremonese'],
    'La Liga 2': ['Deportivo', 'Racing Santander', 'Sporting Gijón', 'Elche'],
    'Croatian HNL': ['Dinamo Zagreb', 'Hajduk Split', 'Rijeka', 'Osijek'],
    'Danish Superliga': ['FC Copenhagen', 'Midtjylland', 'Brøndby', 'Nordsjælland'],
    'Norwegian Eliteserien': ['Bodø/Glimt', 'Molde', 'Rosenborg', 'Viking'],
    'Swedish Allsvenskan': ['Malmö FF', 'AIK', 'Hammarby', 'Djurgården'],
    'Polish Ekstraklasa': ['Legia Warsaw', 'Raków Częstochowa', 'Lech Poznań', 'Jagiellonia'],
    'Czech First League': ['Sparta Prague', 'Slavia Prague', 'Viktoria Plzeň', 'Banik Ostrava'],
    'Romanian Liga I': ['FCSB', 'CFR Cluj', 'Universitatea Craiova', 'Rapid Bucureşti'],
    // ---- Europe: continental competitions ----
    'UEFA Champions League': ['Real Madrid', 'Bayern Munich', 'Paris Saint-Germain', 'Inter', 'Barcelona', 'Manchester City', 'Liverpool', 'Arsenal', 'Borussia Dortmund', 'Atlético Madrid', 'Juventus', 'Napoli'],
    'UEFA Europa League': ['Roma', 'Ajax', 'Liverpool', 'Tottenham', 'Villarreal', 'Rangers', 'Olympiacos', 'Lyon'],
    'UEFA Conference League': ['Fiorentina', 'West Ham', 'Aston Villa', 'Club Brugge', 'PAOK', 'Molde'],
    'UEFA Women\'s Champions League': ['Barcelona Femení', 'Lyon', 'Chelsea Women', 'Wolfsburg Women', 'Bayern Munich Women', 'Arsenal Women'],
    // Nations League groupings use national teams, not clubs — same
    // structure works fine since a league here is just a named pool of teams.
    'UEFA Nations League A': ['France', 'Germany', 'Portugal', 'Spain', 'Italy', 'Netherlands', 'Belgium', 'England'],
    'UEFA Nations League B': ['Turkey', 'Wales', 'Austria', 'Switzerland', 'Israel', 'Serbia', 'Norway', 'Ukraine'],
    'UEFA Nations League C': ['Montenegro', 'Latvia', 'Armenia', 'Cyprus', 'Albania', 'Finland', 'Kazakhstan', 'Slovakia'],
    // ---- Americas ----
    'MLS': ['Inter Miami', 'LAFC', 'LA Galaxy', 'Columbus Crew', 'Seattle Sounders', 'NY Red Bulls', 'Atlanta United', 'Orlando City'],
    'Liga MX': ['Club América', 'Chivas Guadalajara', 'Cruz Azul', 'Monterrey', 'Tigres UANL', 'Pumas UNAM'],
    'Brasileirão': ['Flamengo', 'Palmeiras', 'São Paulo', 'Corinthians', 'Grêmio', 'Internacional', 'Atlético Mineiro', 'Fluminense', 'Botafogo', 'Santos'],
    'Categoría Primera A': ['Independiente Medellín', 'Jaguares de Córdoba', 'Millonarios', 'Atlético Nacional', 'América de Cali', 'Junior'],
    'Argentine Primera División': ['Boca Juniors', 'River Plate', 'Racing Club', 'Independiente', 'San Lorenzo', 'Vélez Sarsfield', 'Estudiantes', 'Talleres'],
    'Chilean Primera División': ['Colo-Colo', 'Universidad de Chile', 'Universidad Católica', 'Palestino'],
    'Uruguayan Primera División': ['Peñarol', 'Nacional', 'Defensor Sporting'],
    'Ecuadorian Serie A': ['LDU Quito', 'Barcelona SC', 'Independiente del Valle'],
    'Paraguayan Primera División': ['Olimpia', 'Cerro Porteño', 'Libertad'],
    'CONMEBOL Libertadores': ['Flamengo', 'Boca Juniors', 'River Plate', 'Palmeiras', 'Atlético Mineiro', 'Colo-Colo'],
    'CONCACAF Champions Cup': ['LAFC', 'Club América', 'Monterrey', 'Seattle Sounders'],
    // ---- Asia / Middle East / Africa / Oceania ----
    'Saudi Pro League': ['Al Hilal', 'Al Nassr', 'Al Ittihad', 'Al Ahli', 'Al Ettifaq', 'Al Shabab'],
    'Lebanese Premier League': ['Nejmeh', 'Ansar', 'Ahed', 'Tadamon Sour', 'Shabab Sahel'],
    'Egyptian Premier League': ['Al Ahly', 'Zamalek', 'Pyramids FC', 'Al Ittihad Alexandria'],
    'J1 League': ['Vissel Kobe', 'Yokohama F. Marinos', 'Kawasaki Frontale', 'Urawa Red Diamonds'],
    'K League 1': ['Ulsan HD', 'Pohang Steelers', 'FC Seoul', 'Jeonbuk Hyundai Motors'],
    'Chinese Super League': ['Shanghai Port', 'Beijing Guoan', 'Shandong Taishan', 'Shanghai Shenhua'],
    'Indian Super League': ['Mohun Bagan', 'Bengaluru FC', 'Mumbai City', 'Kerala Blasters'],
    'A-League': ['Melbourne City', 'Sydney FC', 'Melbourne Victory', 'Western Sydney Wanderers'],
    'South African Premiership': ['Mamelodi Sundowns', 'Orlando Pirates', 'Kaizer Chiefs'],
    'CAF Champions League': ['Al Ahly', 'Mamelodi Sundowns', 'Espérance de Tunis', 'Wydad AC'],
    // ---- International ----
    'FIFA World Cup Qualifiers': ['Brazil', 'Argentina', 'Uruguay', 'Colombia', 'Ecuador', 'Japan', 'South Korea', 'Saudi Arabia'],
    'Copa América': ['Argentina', 'Brazil', 'Uruguay', 'Colombia', 'Chile', 'Peru'],
    'AFCON': ['Nigeria', 'Senegal', 'Morocco', 'Egypt', 'Ivory Coast', 'Algeria'],
  },
  basketball: {
    'NBA': ['Boston Celtics', 'Denver Nuggets', 'LA Lakers', 'Golden State', 'Milwaukee', 'Phoenix Suns', 'Miami Heat', 'Dallas Mavericks', 'New York Knicks', 'Minnesota', 'Philadelphia 76ers', 'Oklahoma City Thunder'],
    'EuroLeague': ['Real Madrid Baloncesto', 'Panathinaikos', 'Fenerbahçe Beko', 'Olympiacos', 'FC Barcelona Bàsquet', 'Anadolu Efes'],
    'ACB': ['Real Madrid Baloncesto', 'FC Barcelona Bàsquet', 'Baskonia', 'Unicaja'],
  },
  tennis: {
    'ATP 1000': ['Alcaraz', 'Sinner', 'Djokovic', 'Medvedev', 'Zverev', 'Rublev', 'Rune', 'De Minaur'],
    'WTA 1000': ['Swiatek', 'Sabalenka', 'Gauff', 'Rybakina', 'Pegula', 'Jabeur'],
    'Grand Slam': ['Alcaraz', 'Djokovic', 'Sinner', 'Swiatek', 'Sabalenka', 'Gauff'],
  },
  nfl: { 'NFL': ['Chiefs', 'Bills', '49ers', 'Eagles', 'Cowboys', 'Ravens', 'Dolphins', 'Lions', 'Packers', 'Bengals'] },
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
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
// Sane per-sport bounds for m.str (team "strength" — expected goals/points
// for the match, or for tennis a raw win probability) — see tick()'s pregame
// drift loop below for why these exist: without a hard ceiling/floor, a
// small multiplicative nudge applied every few seconds compounds, and a
// fixture that sits "upcoming" for many hours (up to 48h — see makeMatch)
// goes through tens of thousands of nudges. A pure random walk with no
// bound doesn't average out to "roughly where it started" — it drifts, and
// over that many steps it drifts far: a moderately-matched fixture could end
// up quoting a near-impossible mismatch by the time it kicks off, which is
// exactly the "many high odds, not real" symptom this fixes. Bounding each
// sport's strength value to the same range makeMatch() already randomizes
// fresh fixtures within keeps the wobble feeling alive (odds still move)
// without ever running away.
const STR_BOUNDS = { football: [0.5, 3.0], basketball: [95, 130], nfl: [12, 34] };
// For a genuine partition — mutually exclusive outcomes whose true
// probabilities already sum to 1 (1X2, Over/Under, BTTS yes/no, Asian
// handicap, half-time result) — the vig is distributed across them together:
// divide each by the group's total (itself ~1) so the whole set still prices
// a "book" that sums to slightly over 100%.
function priceFromProbs(ps) {
  const tot = ps.reduce((a, b) => a + b, 0);
  return ps.map((p) => {
    const q = Math.max(p / tot, 0.004);
    return Math.max(1.01, +((1 / q) * (1 - CONFIG.margin)).toFixed(2));
  });
}
// Double chance's three selections (1X/12/X2) are NOT mutually exclusive —
// "Home or Draw" and "Home or Away" can both be true at once (home wins), so
// their probabilities don't sum to 1 (they sum to 2× the true 1X2 total).
// Feeding them through priceFromProbs's group-normalize logic divided each
// one by that ~2 instead of by its own ~1, which roughly DOUBLED every
// double-chance price — a supposedly ~75%-likely outcome was coming back
// priced near evens/2.50 instead of the ~1.25–1.35 a real book would quote.
// Each selection is priced independently off its own real probability instead.
function priceIndependent(p) {
  const q = Math.max(p, 0.004);
  return Math.max(1.01, +((1 / q) * (1 - CONFIG.margin)).toFixed(2));
}
function lockOdds(...vals) { return vals.some((v) => v <= 1.02); }

// The exact scorelines a "Correct score" market offers — the dozen or so an
// actual sportsbook shows individually, with every longer-shot combination
// folded into a single "Any other score" catch-all instead of listing all 81
// grid cells (which would be unusable as a betslip and, at 8+ goals apiece,
// priced on vanishingly thin probability anyway).
const CORRECT_SCORES = [[0,0],[1,0],[0,1],[1,1],[2,0],[0,2],[2,1],[1,2],[2,2],[3,0],[0,3],[3,1],[1,3],[3,2],[2,3]];
function footballProbs(m) {
  const rem = Math.max(0, (m.live ? 90 - m.minute : 90)) / 90;
  const lh = m.str[0] * rem + 0.001, la = m.str[1] * rem + 0.001;
  let pH = 0, pD = 0, pA = 0, pOv = 0, pBtts = 0, pAHhome = 0, pAHaway = 0, pOdd = 0;
  const ah = m.ahLine || 0;
  const csRemaining = CORRECT_SCORES.map(() => 0);
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = pois(i, lh) * pois(j, la);
      const H = m.score[0] + i, A = m.score[1] + j;
      if (H > A) pH += p; else if (H === A) pD += p; else pA += p;
      if (H + A > m.line) pOv += p;
      if (H > 0 && A > 0) pBtts += p;
      if ((H + A) % 2 === 1) pOdd += p;
      const adj = (H + ah) - A;
      if (adj > 0.001) pAHhome += p; else if (adj < -0.001) pAHaway += p; else { pAHhome += p / 2; pAHaway += p / 2; }
      // i/j is goals still to come this "remaining match" model, so a
      // specific FINAL scoreline requires exactly the goals still needed
      // for both sides from here — anything already ahead of a listed line
      // (e.g. current score already 2–0 against a listed "0–0") simply never
      // matches any row and correctly falls into "any other score" below.
      CORRECT_SCORES.forEach((cs, idx) => { if (H === cs[0] && A === cs[1]) csRemaining[idx] += p; });
    }
  }
  const pCS = csRemaining;
  const pCSOther = Math.max(0, 1 - pCS.reduce((a, b) => a + b, 0));
  // 1st-half market: while the match is still inside its first half, this
  // must reflect the score AS IT ACTUALLY STANDS so far this half, the same
  // way the full-time 1X2 above already reacts to goals — it used to always
  // price off the pregame team strengths alone, completely ignoring the live
  // score, so a team already 2–0 up in the 20th minute still showed a
  // near-even "1st half result" price. No real in-play book does that.
  let pH1 = 0, pD1 = 0, pA1 = 0;
  const htDeadline = 45 + (m.addedHT || 0);
  let baseH1 = 0, baseA1 = 0, htRem = htDeadline;
  if (m.live && !m.htScore) {
    baseH1 = m.score[0]; baseA1 = m.score[1];
    htRem = Math.max(0, htDeadline - m.minute);
  } else if (m.htScore) {
    // Half-time has already happened — the market is closed by then anyway
    // (see markets.HT.closed below), but keep the numbers internally
    // consistent with the actual recorded half-time result rather than 0.
    baseH1 = m.htScore[0]; baseA1 = m.htScore[1]; htRem = 0;
  }
  // Same "goals per 90 minutes" rate model the full-time market above uses —
  // expected additional goals over the minutes remaining until half-time is
  // the full-match strength scaled by that remaining time out of 90.
  const lh1 = m.str[0] * (htRem / 90) + 0.001, la1 = m.str[1] * (htRem / 90) + 0.001;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = pois(i, lh1) * pois(j, la1);
      const H1 = baseH1 + i, A1 = baseA1 + j;
      if (H1 > A1) pH1 += p; else if (H1 === A1) pD1 += p; else pA1 += p;
    }
  }
  const pHY = pH * pBtts, pHN = pH * (1 - pBtts), pDY = pD * pBtts, pDN = pD * (1 - pBtts), pAY = pA * pBtts, pAN = pA * (1 - pBtts);
  return { pH, pD, pA, pOv, pBtts, pAHhome, pAHaway, pH1, pD1, pA1, pHY, pHN, pDY, pDN, pAY, pAN, pOdd, pCS, pCSOther };
}

function priceMatch(m) {
  // API-sourced matches carry real odds fetched from the external feed
  // (apifootball.js), never this engine's own Poisson/logistic model — the
  // model doesn't even have a meaningful m.str for them. Every call site
  // (kickoff, live ticks, and several admin score-edit endpoints) can safely
  // call priceMatch() unconditionally without needing to know which kind of
  // match it's touching; this is the single place that draws the line.
  if (m.apiSourced) return;
  m.prevOdds = JSON.parse(JSON.stringify(m.markets || {}));
  if (m.sport === 'football') {
    if (!m.live) m.ahLine = Math.round((m.str[1] - m.str[0]) * 2) / 2;
    // Keep the total-goals line ahead of the game itself: once the scoreline
    // already clears the quoted line, "Over" is a certainty, not a bet — a
    // real book moves the line up instead of quoting odds that can't lose.
    while (m.score[0] + m.score[1] >= m.line) m.line += 1;
    const { pH, pD, pA, pOv, pBtts, pAHhome, pAHaway, pH1, pD1, pA1, pHY, pHN, pDY, pDN, pAY, pAN, pOdd, pCS, pCSOther } = footballProbs(m);
    const [h, d, a] = priceFromProbs([pH, pD, pA]);
    const [o, u] = priceFromProbs([pOv, 1 - pOv]);
    const [y, n] = priceFromProbs([pBtts, 1 - pBtts]);
    const dc1x = priceIndependent(pH + pD), dc12 = priceIndependent(pH + pA), dcx2 = priceIndependent(pD + pA);
    const [h1, d1, a1] = priceFromProbs([pH1, pD1, pA1]);
    const [wHY, wHN, wDY, wDN, wAY, wAN] = priceFromProbs([pHY, pHN, pDY, pDN, pAY, pAN]);
    const [ahH, ahA] = priceFromProbs([pAHhome, pAHaway]);
    const [oddO, evenO] = priceFromProbs([pOdd, 1 - pOdd]);
    const csOdds = priceFromProbs([...pCS, pCSOther]);
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
      'OE': { label: 'Odd/Even total goals', closed: lockOdds(oddO, evenO), sel: [{ k: 'O', n: 'Odd', o: oddO }, { k: 'E', n: 'Even', o: evenO }] },
      'CS': { label: 'Correct score', closed: lockOdds(...csOdds), sel: [
        ...CORRECT_SCORES.map((cs, idx) => ({ k: cs.join('-'), n: cs.join('–'), o: csOdds[idx] })),
        { k: 'OTHER', n: 'Any other score', o: csOdds[csOdds.length - 1] },
      ] },
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
function capFor(m) { return m.sport === 'football' ? (90 + (m.addedFT || 0)) : m.sport === 'tennis' ? 150 : (m.sport === 'nfl' ? 60 : 48); }
function suspendMatch(m, ms) { m.suspendedUntil = now() + ms; m.suspClosed = false; }
function isSuspended(m) { return m && m.suspendedUntil && now() < m.suspendedUntil; }

function pushEvent(m, partial) {
  const e = Object.assign({ t: now(), mn: m.minute }, partial);
  m.events.unshift(e);
  m.events = m.events.slice(0, 40);
}
// Spreads the goals needed to reach an admin-fixed final score (m.targetScore
// — and, before half-time, an optional intermediate m.targetHT checkpoint)
// naturally across the remaining minutes, instead of the score jumping
// straight to the final number right when the admin sets it or right at
// full-time. Each remaining minute, each side that still needs a goal gets a
// `needed / minutesRemaining` chance to score one now. That's a standard
// "spread N events evenly over T remaining slots" trick: recomputed every
// minute, it guarantees the target is hit exactly by the deadline (the
// probability rises to a dead-certain 1 only on the very last minute that
// could still fit every outstanding goal), while almost always resolving
// well before that, at a different, unpredictable minute every time.
function scriptFootballGoal(m) {
  const htDeadline = 45 + (m.addedHT || 0);
  const ftDeadline = capFor(m);
  const usingHT = Array.isArray(m.targetHT) && !m.htScore && m.minute < htDeadline;
  const deadline = usingHT ? htDeadline : ftDeadline;
  const target = usingHT ? m.targetHT : m.targetScore;
  const remaining = Math.max(1, deadline - m.minute);
  for (const side of [0, 1]) {
    const needed = Math.max(0, (target[side] || 0) - (m.score[side] || 0));
    if (needed > 0 && Math.random() < needed / remaining) {
      m.score[side]++; m.lastScorer = side; suspendMatch(m, CONFIG.suspendMs);
      pushEvent(m, { side, kind: 'goal', txt: 'Goal — ' + (side ? m.away : m.home) + ' ' + m.score.join('–') });
    }
  }
}
function stepMinute(m) {
  m.minute++;
  // >= rather than === so this can't be permanently skipped if an admin
  // lowers addedHT (via the added-time endpoint) to a value at or below the
  // stoppage minute already reached — with a strict equality check, the
  // exact minute this fires on would already be behind us and half-time
  // would never trigger at all for that match.
  if (m.sport === 'football' && !m.htScore && m.minute >= 45 + (m.addedHT || 0)) {
    m.htScore = [...m.score];
    // Half-time marker event — purely additive to the event feed (never read
    // by settlement), used client-side to trigger the half-time banner in the
    // pitch celebration overlay the same way a goal triggers "GOAL!".
    pushEvent(m, { kind: 'half', txt: 'Half-time — ' + m.htScore.join('–') });
    // First-half stoppage time (admin-set `addedHT`) is displayed as "45+N'"
    // while it's being played (see the front-end clock formatting), but once
    // half-time actually hits, the second half should resume counting from a
    // clean 46' — exactly like a real broadcast clock — rather than
    // continuing on from 45+N. Rebase the minute counter back down to 45 and
    // push `liveStart` forward by the same amount of real time so the
    // elapsed-time-driven catch-up loop in advanceMatch() keeps agreeing with
    // this rebased minute instead of immediately fast-forwarding past it.
    if (m.addedHT) {
      m.minute = 45;
      m.liveStart += (m.addedHT * (m.secPerMin || SEC_PER_MATCH_MIN) * 1000);
    }
  }
  const cap = capFor(m);
  // Momentum: a slow random walk biased toward whichever side is currently
  // stronger/ahead, so the momentum bar on the watch page actually moves
  // instead of sitting frozen at 50/50 for the whole match.
  if (m.momentum == null) m.momentum = 50;
  const strBias = (m.str[0] - m.str[1]) / (Math.abs(m.str[0]) + Math.abs(m.str[1]) + 0.01);
  const scoreBias = Math.sign((m.score[0] || 0) - (m.score[1] || 0));
  m.momentum = Math.max(6, Math.min(94, m.momentum + rnd(-6, 6) + strBias * 3 + scoreBias * 2));
  // Verified/real matches (curated real-world fixtures, and every fixture the
  // admin adds — see routes.js's fixture-create handler, which always sets
  // `verified=true`) are meant to reflect the *real* result of that game, so
  // the random goal-simulation engine must never touch their score — only
  // the admin, from kickoff to full-time. `adminLocked` additionally covers
  // the one-off case of a force-scored *unverified* match: once an admin has
  // manually set a score there, it's likewise meant to stick rather than
  // have the random simulation keep adding surprise goals on top of it a few
  // seconds later. Either way, this freezes just the scoring while leaving
  // the clock/momentum/suspense running normally, so the match doesn't look
  // frozen — the score stays exactly what the admin set until they change it
  // again or end the match.
  if (m.sport === 'football' && Array.isArray(m.targetScore)) {
    // Scripted result: the admin has fixed the final (and optionally
    // half-time) score directly, rather than nudging it goal-by-goal with
    // +1 — see scriptFootballGoal() below. This plays the goals out at
    // random-feeling times across the match instead of the score jumping
    // straight to the final number, for both real and FIFA fixtures alike.
    scriptFootballGoal(m);
  } else if (m.verified || m.adminLocked) {
    // no random scoring this tick
  } else if (m.sport === 'football') {
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
    m.ended = true; m.live = false; m.endedAt = now(); return true;
  }
  return false;
}
function advanceMatch(m) {
  const spm = m.secPerMin || SEC_PER_MATCH_MIN;
  if (!m.liveStart) m.liveStart = now() - m.minute * spm * 1000;
  const cap = capFor(m);
  const target = Math.min(cap, Math.floor((now() - m.liveStart) / 1000 / spm));
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
// A just-finished match used to vanish from the board on the very next 3s
// poll — one live match ending and another taking its place felt like a
// jump-cut, and there was no moment to actually see the final score. This
// gives it a brief "Full time" grace window on the board before it drops
// off (see routes.js's /api/matches, which calls this alongside the normal
// not-yet-ended list). Bounded with LIMIT + ORDER BY start DESC so a long-
// running deployment's full match history is never scanned — kickoff-time
// ordering is a good enough proxy for "recently finished" since matches in
// this sped-up simulation end shortly after they start.
const ENDED_GRACE_MS = 5000;
function listRecentlyEnded(sport) {
  let sql = 'SELECT * FROM matches WHERE ended = 1';
  const args = [];
  if (sport) { sql += ' AND sport = ?'; args.push(sport); }
  sql += ' ORDER BY start DESC LIMIT 20';
  return db.prepare(sql).all(...args).map(rowToMatch)
    .filter((m) => m.endedAt && now() - m.endedAt < ENDED_GRACE_MS);
}

// Every league an admin might add a manual fixture under — normally just
// TEAMS's fixed list, but an admin can add a fixture (POST /api/admin/fixtures)
// under a brand-new league name that isn't in TEAMS at all, or the automatic
// sports-data feed can create real fixtures under league names of its own.
// Without this, maybeKickoff()'s loop (which only ever visited
// Object.keys(TEAMS[sport])) silently never looked at that league, so its
// scheduled kickoff time would pass and it would just sit there forever,
// never actually going live no matter how long you waited.
function leaguesFor(sportId) {
  const known = Object.keys(TEAMS[sportId] || {});
  const rows = db.prepare("SELECT DISTINCT league FROM matches WHERE sport = ? AND ended = 0").all(sportId);
  const extra = rows.map((r) => r.league).filter((lg) => !known.includes(lg));
  return known.concat(extra);
}

function kickOffFresh(m) {
  m.live = true; m.minute = 0; m.liveStart = now(); m.momentum = 50;
  // A pregame score an admin deliberately set (adminLocked — see routes.js's
  // force-score handler) used to get silently wiped back to 0-0 the instant
  // the fixture kicked off, since this unconditionally reset the score. Now
  // it survives kickoff exactly as set; stepMinute()'s own adminLocked check
  // then keeps the random simulation from adding further goals on top of it.
  if (!m.adminLocked) {
    m.score = [0, 0];
    if (m.sport === 'tennis') { m.sets = [0, 0]; m.games = [0, 0]; }
  }
  priceMatch(m);
  saveMatch(m);
}
// Only ever kicks off a fixture the ADMIN scheduled by hand (m.adminAdded) —
// every match here now carries a deliberately-chosen real kickoff time, so it
// goes live right at that time, full stop. A match sourced automatically from
// the live sports-data feed (m.apiSourced) is managed exclusively by that
// feed's own sync loop (see apifootball.js) — its live/ended state and score
// come from the real world, never from this engine's clock, so it's excluded
// here entirely; kicking it off "early" or resetting its score the way this
// function does for a manually-scheduled fixture would silently corrupt a
// real result. There is no more procedurally-simulated filler to keep a
// league's board topped up — an empty board now just means there's genuinely
// nothing real scheduled or live, which is the whole point of "real matches
// only".
function maybeKickoff() {
  for (const s of SPORTS) {
    for (const lg of leaguesFor(s.id)) {
      const upcoming = listMatches({ sport: s.id, live: false, ended: false })
        .filter((m) => m.league === lg && m.adminAdded && !m.apiSourced);
      upcoming.filter((m) => m.start <= now()).forEach(kickOffFresh);
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
    // API-sourced matches are driven entirely by the external real-data sync
    // (apifootball.js) — their clock, score and odds come from the real feed,
    // never from this internal simulation clock. Touching them here would
    // corrupt real data with synthetic progression.
    if (m.apiSourced) continue;
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
  maybeKickoff();
}

let engineTimer = null;
function startEngine(onSettle) {
  if (engineTimer) return;
  maybeKickoff();
  engineTimer = setInterval(() => tick(onSettle), 3000);
}

module.exports = {
  TEAMS, SPORTS, priceMatch, makeMatch, isSuspended, capFor,
  saveMatch, getMatch, listMatches, listRecentlyEnded, startEngine, CONFIG,
  suspendMatch,
  BEIRUT_OFFSET_MS, beirutWallToUtc, strengthsForOdds,
  kickOffFresh, REAL_SEC_PER_MIN, FIFA_SEC_PER_MIN, CORRECT_SCORES,
};
