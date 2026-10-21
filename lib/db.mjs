import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, vpa TEXT NOT NULL UNIQUE COLLATE NOCASE,
      payee_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('FIXED','OPEN')),
      account_id TEXT NOT NULL REFERENCES accounts(id), amount_paise INTEGER,
      title TEXT NOT NULL, customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '',
      external_id TEXT UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, expires_at TEXT,
      CHECK((type='FIXED' AND amount_paise > 0) OR (type='OPEN' AND amount_paise IS NULL))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id),
      account_id TEXT NOT NULL, vpa TEXT NOT NULL, payee_name TEXT NOT NULL,
      amount_paise INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      utr TEXT, verification TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      customer_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at DESC);
    CREATE INDEX IF NOT EXISTS payments_link ON payments(link_id);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT, action TEXT NOT NULL,
      details TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observer_events (
      id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, amount_paise INTEGER NOT NULL,
      utr TEXT NOT NULL, received_at TEXT NOT NULL
    );
  `);
  if (!db.prepare("SELECT value FROM settings WHERE key='branding'").get()) {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('branding', JSON.stringify({title:'Your Payment Gateway',logoUrl:'',theme:'indigo',businessName:'Your Business'}));
  }
  return db;
}

export const getBrand = db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='branding'").get().value);
export const allAccounts = db => db.prepare('SELECT * FROM accounts ORDER BY is_default DESC, created_at ASC').all().map(a=>({...a,active:!!a.active,is_default:!!a.is_default}));
export const getAccount = (db,id) => db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
export const getLink = (db,id) => db.prepare('SELECT * FROM links WHERE id=?').get(id);
export const getPayment = (db,id) => db.prepare('SELECT * FROM payments WHERE id=?').get(id);
export function withWrite(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch(e) { db.exec('ROLLBACK'); throw e; }
}
