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
  return { pH, pD, pA, pOv, pBtts, pAHhome, pAHaway, pH1, pD1, pA1, pHY, pHN, pDY, pDN, pAY, pAN, pOdd, pCS, pCSOther };
}

function priceMatch(m) {
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
// computed relative to `now()` (next occurrence of a given weekday/hour, in
// Beirut time — see nextWeekday() near the top of this file) so they never
// look stale, unlike a hardcoded past date would. They're seeded once
// alongside the normal procedural fixtures and marked m.verified = true,
// same flag the admin-added-fixture flow already uses for its "✓ Verified" badge.
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
    { league: 'Süper Lig', home: 'Galatasaray', away: 'Fenerbahçe', start: nextWeekday(0, 19, 0) },
    { league: 'Süper Lig', home: 'Beşiktaş', away: 'Trabzonspor', start: nextWeekday(6, 17, 0) },
    { league: 'Primeira Liga', home: 'Benfica', away: 'Porto', start: nextWeekday(0, 20, 30) },
    { league: 'Primeira Liga', home: 'Sporting CP', away: 'Braga', start: nextWeekday(6, 19, 0) },
    // Nations League matchdays run roughly two weeks apart — spreading these
    // a couple of days apart (rather than all on one night) mirrors that.
    { league: 'UEFA Nations League A', home: 'France', away: 'Germany', start: nextWeekday(2, 20, 45) },
    { league: 'UEFA Nations League A', home: 'Portugal', away: 'Spain', start: nextWeekday(3, 20, 45) },
    { league: 'UEFA Nations League A', home: 'Italy', away: 'Netherlands', start: nextWeekday(2, 20, 45) },
    { league: 'UEFA Nations League B', home: 'Turkey', away: 'Wales', start: nextWeekday(3, 20, 45) },
    { league: 'UEFA Nations League B', home: 'Switzerland', away: 'Serbia', start: nextWeekday(2, 18, 0) },
    { league: 'UEFA Nations League C', home: 'Armenia', away: 'Cyprus', start: nextWeekday(3, 18, 0) },
  ];
}
function seedRealFixtures() {
  for (const fx of buildRealFixtures()) {
    const m = makeMatch('football', fx.league, fx.home, fx.away, false);
    m.start = fx.start;
    // NOT verified: these are recurring "next Saturday/Tuesday" placeholder
    // fixtures (see nextWeekday() above) that recompute to a different date
    // every time the server restarts — they were never tied to an actual
    // confirmed real-world kickoff, just headline team names spread across
    // every league so each one had *something* in its rotation. Marking them
    // verified made them show up in the "✓ Verified real matches" tab
    // alongside genuinely researched, dated fixtures (see
    // buildSpecialFixtures()), which is misleading — they play out like any
    // other procedurally-simulated match, just with real team names.
    saveMatch(m);
  }
}
// One-time cleanup for databases seeded before the change above: demotes any
// already-verified row that matches one of buildRealFixtures()'s recurring
// placeholder fixtures back to a normal (non-verified) match, so an already-
// running deployment's "Verified real matches" tab also stops showing them,
// not just freshly-seeded ones. Matched by sport/league/home/away only (not
// `start`, which recomputes every boot) and only touches matches still in
// play (not yet ended), so a genuinely-finished historical result is left
// alone.
function demoteUnreliableVerifiedFixtures() {
  for (const fx of buildRealFixtures()) {
    const rows = db.prepare('SELECT id, data FROM matches WHERE sport = ? AND league = ? AND home = ? AND away = ? AND ended = 0 AND verified = 1')
      .all('football', fx.league, fx.home, fx.away);
    for (const row of rows) {
      const m = JSON.parse(row.data);
      m.verified = false;
      saveMatch(m);
    }
  }
}
// One-off, dated real-world fixtures (as opposed to buildRealFixtures()'s
// recurring "next Tuesday/Wednesday" ones) — e.g. a specific matchday copied
// in from a real competition's real schedule and odds. Runs on every boot
// (not just when the DB is empty, unlike seedRealFixtures()/seedIfEmpty()),
// but is idempotent: it skips any fixture that already exists for the same
// league/teams/kickoff so restarting the server never creates duplicates.
// Every match here is `verified`, so stepMinute()'s admin-only scoring gate
// applies — the engine will never touch their score; only the admin can, via
// force-score, exactly the "full result only admin put" behaviour requested.
function buildSpecialFixtures() {
  return [
    // UEFA Women's Champions League — Matchday 1, Wed 23 Sep 2026 (Beirut time)
    { league: "UEFA Women's Champions League", home: 'Real Madrid (W)', away: 'PSG (W)', start: beirutWallToUtc(2026, 9, 23, 22, 0), odds: [1.44, 4.50, 7.00] },
    { league: "UEFA Women's Champions League", home: 'Juventus (W)', away: 'Benfica (W)', start: beirutWallToUtc(2026, 9, 23, 22, 0), odds: [1.72, 3.20, 5.50] },
    { league: "UEFA Women's Champions League", home: 'Arsenal (W)', away: 'HB Køge (W)', start: beirutWallToUtc(2026, 9, 23, 22, 0), odds: [1.10, 8.00, 15.00] },
    { league: "UEFA Women's Champions League", home: 'OH Leuven (W)', away: 'Roma (W)', start: beirutWallToUtc(2026, 9, 23, 19, 45), odds: [3.90, 4.20, 1.61] },
    { league: "UEFA Women's Champions League", home: 'Servette FC Chenois (W)', away: 'OL Lyonnes (W)', start: beirutWallToUtc(2026, 9, 23, 19, 45), odds: [67.00, 21.00, 1.015] },
    { league: "UEFA Women's Champions League", home: 'Barcelona (W)', away: 'Paris FC (W)', start: beirutWallToUtc(2026, 9, 23, 22, 0), odds: [1.025, 17.00, 51.00] },
    { league: "UEFA Women's Champions League", home: 'Chelsea (W)', away: 'FK Austria Vienna (W)', start: beirutWallToUtc(2026, 9, 23, 22, 0), odds: [1.025, 19.00, 51.00] },
    // Colombia — Categoría Primera A / Liga BetPlay, matchday 12. Kickoff
    // 19:00 Bogotá time (UTC-5, no DST) = 03:00 Beirut the next calendar day.
    // Deep search on the other big South American leagues for this same
    // window came up empty/unconfirmed: Brazil's Série A has no fixtures at
    // all between 20 Sep and 2 Oct 2026 (an international-break gap), and
    // Argentina's Liga Profesional round for this week couldn't be pinned to
    // an exact, reliably-sourced date/time — so neither is included here
    // rather than guessing at "real" matches that aren't actually confirmed.
    { league: 'Categoría Primera A', home: 'Independiente Medellín', away: 'Jaguares de Córdoba', start: beirutWallToUtc(2026, 9, 23, 3, 0), odds: [1.30, 5.00, 9.00] },
    // UEFA Nations League A/B — Matchday 1, confirmed against UEFA's own
    // published schedule. Kickoffs are 20:45/18:00 CEST → +1h = Beirut.
    // (Unlike the old buildRealFixtures() Nations League entries — now
    // demoted, see demoteUnreliableVerifiedFixtures() — these are dated,
    // confirmed real fixtures, not a recurring placeholder.)
    { league: 'UEFA Nations League A', home: 'Netherlands', away: 'Germany', start: beirutWallToUtc(2026, 9, 24, 21, 45), odds: [2.37, 3.80, 2.70] },
    { league: 'UEFA Nations League A', home: 'Norway', away: 'Denmark', start: beirutWallToUtc(2026, 9, 24, 21, 45), odds: [1.70, 4.10, 4.50] },
    { league: 'UEFA Nations League A', home: 'Portugal', away: 'Wales', start: beirutWallToUtc(2026, 9, 24, 21, 45), odds: [1.22, 6.50, 13.00] },
    { league: 'UEFA Nations League A', home: 'Serbia', away: 'Greece', start: beirutWallToUtc(2026, 9, 24, 21, 45), odds: [2.62, 3.30, 2.70] },
    { league: 'UEFA Nations League A', home: 'Italy', away: 'Belgium', start: beirutWallToUtc(2026, 9, 25, 21, 45), odds: [2.20, 3.50, 3.20] },
    { league: 'UEFA Nations League A', home: 'Türkiye', away: 'France', start: beirutWallToUtc(2026, 9, 25, 21, 45), odds: [6.50, 4.75, 1.44] },
    { league: 'UEFA Nations League B', home: 'Austria', away: 'Israel', start: beirutWallToUtc(2026, 9, 24, 21, 45), odds: [1.42, 4.75, 6.50] },
    { league: 'UEFA Nations League B', home: 'Kosovo', away: 'Republic of Ireland', start: beirutWallToUtc(2026, 9, 24, 21, 45), odds: [2.40, 3.10, 3.10] },
    { league: 'UEFA Nations League B', home: 'Georgia', away: 'Northern Ireland', start: beirutWallToUtc(2026, 9, 25, 19, 0), odds: [1.83, 3.50, 4.10] },
  ];
}
function seedSpecialFixtures() {
  for (const fx of buildSpecialFixtures()) {
    const dupe = db.prepare('SELECT id FROM matches WHERE sport = ? AND league = ? AND home = ? AND away = ? AND start = ?')
      .get('football', fx.league, fx.home, fx.away, Math.round(fx.start));
    if (dupe) continue;
    const m = makeMatch('football', fx.league, fx.home, fx.away, false);
    m.start = fx.start;
    m.verified = true;
    m.secPerMin = REAL_SEC_PER_MIN;
    const [oh, od, oa] = fx.odds;
    const str = strengthsForOdds(oh, od, oa);
    if (str) m.str = str;
    priceMatch(m);
    // The Poisson-grid solve above gets every other market (O/U, BTTS,
    // handicap…) internally consistent, but at very lopsided odds (a heavy
    // 1.01-ish favourite against a 50+ underdog) the grid's own resolution
    // can't quite reach the exact typed price. Since the whole point here is
    // "same odds" as given, pin the pregame 1X2 line to the exact input —
    // once the match kicks off, live play reprices it (and everything else)
    // off the solved strengths as normal, same as any other fixture.
    if (m.markets['1X2']) {
      const sel = m.markets['1X2'].sel;
      sel.find((s) => s.k === '1').o = oh;
      sel.find((s) => s.k === 'X').o = od;
      sel.find((s) => s.k === '2').o = oa;
    }
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
// Every league maybeKickoff()/topUpFixtures() know to manage — normally just
// TEAMS's fixed list, but an admin can add a fixture (POST /api/admin/fixtures)
// under a brand-new league name that isn't in TEAMS at all. Without this,
// maybeKickoff()'s loop (which only ever visited Object.keys(TEAMS[sport]))
// silently never looked at that league, so a custom-league fixture's
// scheduled kickoff time would pass and it would just sit there forever,
// never actually going live no matter how long you waited.
function leaguesFor(sportId) {
  const known = Object.keys(TEAMS[sportId] || {});
  const rows = db.prepare("SELECT DISTINCT league FROM matches WHERE sport = ? AND ended = 0").all(sportId);
  const extra = rows.map((r) => r.league).filter((lg) => !known.includes(lg));
  return known.concat(extra);
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
function maybeKickoff() {
  for (const s of SPORTS) {
    for (const lg of leaguesFor(s.id)) {
      const upcomingAll = () => listMatches({ sport: s.id, live: false, ended: false }).filter((m) => m.league === lg);
      // A verified fixture (admin-added, or one of the curated real-world
      // ones) carries an explicit, deliberately-chosen kickoff time, so it
      // always goes live right at that time — even if it means briefly
      // exceeding the league's normal live cap below. An admin who set
      // "23/09 8:00 PM" expects the match to actually start then, not
      // silently wait for a slot some procedurally-generated filler fixture
      // is occupying.
      // Same guarantee now covers every admin-scheduled fixture (`adminAdded`
      // — real *or* FIFA, verified or not), not just verified ones: without
      // this, a FIFA fixture (never verified) whose scheduled kickoff had
      // already passed could sit stuck in "upcoming" indefinitely once its
      // league's live slots were full, since the filler-fallback below
      // deliberately skips adminAdded fixtures too. Once its own clock says
      // it's time, it goes live — full stop, cap or no cap.
      upcomingAll().filter((m) => (m.verified || m.adminAdded) && m.start <= now()).forEach(kickOffFresh);

      const live = listMatches({ sport: s.id, live: true, ended: false }).filter((m) => m.league === lg);
      if (live.length >= MAX_LIVE_PER_LEAGUE) continue;
      const upcoming = upcomingAll();
      if (!upcoming.length) continue;
      let due = upcoming.filter((m) => m.start <= now());
      // Never let a league's board go completely dark: if nothing is live at
      // all in this league, kick off the soonest upcoming fixture right away
      // instead of waiting out its scheduled start — a real book always has
      // *something* on, even if the strict schedule says otherwise. This
      // filler-only fallback must never pick a *verified* fixture — those
      // carry a deliberately-chosen real kickoff time (e.g. tomorrow at
      // 21:00), and force-starting one early just because its league has
      // nothing live yet would silently move a real match's kickoff. A
      // verified fixture only ever goes live via the `.filter(m => m.verified
      // && m.start <= now())` line above, right at its own scheduled time.
      if (!due.length) {
        if (live.length === 0) {
          const filler = upcoming.filter((m) => !m.verified && !m.adminAdded).sort((a, b) => a.start - b.start)[0];
          due = filler ? [filler] : [];
        }
        if (!due.length) continue; // nothing fillable — wait for a fixture's own kick-off time
      }
      kickOffFresh(pick(due));
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
  demoteUnreliableVerifiedFixtures();
  seedSpecialFixtures();
  maybeKickoff();
  engineTimer = setInterval(() => tick(onSettle), 3000);
}

module.exports = {
  TEAMS, SPORTS, priceMatch, makeMatch, isSuspended, capFor,
  saveMatch, getMatch, listMatches, listRecentlyEnded, startEngine, CONFIG,
  startSim, listSims, MAX_SIMS_PER_USER, suspendMatch,
  BEIRUT_OFFSET_MS, beirutWallToUtc, strengthsForOdds, MAX_LIVE_PER_LEAGUE,
  kickOffFresh, REAL_SEC_PER_MIN, FIFA_SEC_PER_MIN, CORRECT_SCORES,
};
