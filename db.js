// Real, persistent SQLite database — zero external dependencies. Node's
// built-in `node:sqlite` module (stable enough for this use, marked
// experimental by Node itself) ships with Node 22.5+, so there is nothing to
// `npm install` for the database layer at all: it just works the moment you
// run `node server.js`.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'stakebet.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  country TEXT,
  joined_at INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  odds_format TEXT NOT NULL DEFAULT 'decimal',
  deposit_limit REAL NOT NULL DEFAULT 0,
  loss_limit REAL NOT NULL DEFAULT 0,
  lock_until INTEGER,
  lifetime_wagered REAL NOT NULL DEFAULT 0,
  wagering_required REAL NOT NULL DEFAULT 0,
  wagering_progress REAL NOT NULL DEFAULT 0,
  kyc_verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS verifications (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  league TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  start INTEGER NOT NULL,
  live INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_sport ON matches(sport);
CREATE INDEX IF NOT EXISTS idx_matches_live ON matches(live, ended);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  stake REAL NOT NULL,
  odds REAL NOT NULL,
  payout REAL NOT NULL,
  status TEXT NOT NULL,
  returned REAL,
  placed_at INTEGER NOT NULL,
  legs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  extra TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  msg TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id);

CREATE TABLE IF NOT EXISTS platform (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  msg TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat(created_at);

CREATE TABLE IF NOT EXISTS sim_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sport TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  final_score TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sim_history_user ON sim_history(user_id);
`);

// Defensive migration for a database created before these columns existed —
// harmless no-op on a fresh database (the CREATE TABLE above already has them).
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('users', 'lifetime_wagered', "REAL NOT NULL DEFAULT 0");
ensureColumn('users', 'wagering_required', "REAL NOT NULL DEFAULT 0");
ensureColumn('users', 'wagering_progress', "REAL NOT NULL DEFAULT 0");
ensureColumn('users', 'kyc_verified', "INTEGER NOT NULL DEFAULT 0");
// Welcome bonus is now a claimed code (see /api/me/claim-bonus in routes.js),
// not an auto-credit on verify — this tracks whether that one-time claim has
// already been used, independent of wagering_required/progress (which now
// only get set at claim time, not at signup).
ensureColumn('users', 'bonus_claimed', "INTEGER NOT NULL DEFAULT 0");

for (const k of ['staked', 'deposited', 'withdrawn', 'betsPlaced', 'payout']) {
  db.prepare('INSERT OR IGNORE INTO platform (key, value) VALUES (?, 0)').run(k);
}

module.exports = db;
