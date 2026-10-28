import fs from 'node:fs';
import path from 'node:path';
import Database from './sqlite.js';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  agent_token_hash  TEXT NOT NULL,
  bw_rate           REAL NOT NULL DEFAULT 2,
  color_rate        REAL NOT NULL DEFAULT 10,
  supports_color    INTEGER NOT NULL DEFAULT 1,
  supports_duplex   INTEGER NOT NULL DEFAULT 0,
  is_open           INTEGER NOT NULL DEFAULT 1,
  last_heartbeat_at TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  shop_id          TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,
  customer_name    TEXT,
  file_path        TEXT,
  page_count       INTEGER NOT NULL,
  print_pages      INTEGER NOT NULL,
  copies           INTEGER NOT NULL DEFAULT 1,
  color            INTEGER NOT NULL DEFAULT 0,
  paper            TEXT NOT NULL DEFAULT 'A4',
  orientation      TEXT NOT NULL DEFAULT 'auto',
  duplex           INTEGER NOT NULL DEFAULT 0,
  pages            TEXT,
  price            REAL NOT NULL,
  payment_status   TEXT NOT NULL DEFAULT 'none',
  payment_order_id TEXT,
  payment_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  printed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(shop_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_code  ON jobs(shop_id, code, created_at);
`);

// Columns added after the first release — add them to existing databases too
const shopColumns = db.prepare('PRAGMA table_info(shops)').all().map((c) => c.name);
const addShopColumn = (name, definition) => {
  if (!shopColumns.includes(name)) db.exec(`ALTER TABLE shops ADD COLUMN ${name} ${definition}`);
};
addShopColumn('disabled', 'INTEGER NOT NULL DEFAULT 0');
addShopColumn('subscription_until', 'TEXT'); // NULL = no expiry
addShopColumn('activation_code', 'TEXT'); // one-time code the desktop agent exchanges for a token
addShopColumn('phone', 'TEXT');
addShopColumn('note', 'TEXT');

export const nowIso = () => new Date().toISOString();

export function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
