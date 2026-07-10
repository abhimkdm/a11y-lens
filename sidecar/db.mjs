// A11y Lens session store (Phase 10) — SQLite via better-sqlite3.
// Every scan becomes a session row; full scan payload is stored as JSON.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.A11Y_DATA_DIR || join(homedir(), ".a11y-lens");
mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, "sessions.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    timestamp TEXT NOT NULL,
    score INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'quick',   -- quick | full
    counts TEXT NOT NULL,                 -- JSON
    data TEXT NOT NULL                    -- full ScanResult JSON (violations, pages, aiReport, screenshot)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_url ON sessions(url);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
`);

export const settings = {
  get(key) {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return r ? JSON.parse(r.value) : null;
  },
  set(key, value) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  },
};

export const audit = {
  log(action, detail = "") {
    db.prepare("INSERT INTO audit (timestamp, action, detail) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), action, String(detail).slice(0, 300));
  },
  list(limit = 100) {
    return db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
  },
};

export const sessions = {
  save(scan) {
    const info = db.prepare(
      `INSERT INTO sessions (url, title, timestamp, score, kind, counts, data)
       VALUES (@url, @title, @timestamp, @score, @kind, @counts, @data)`
    ).run({
      url: scan.url, title: scan.title ?? "", timestamp: scan.timestamp,
      score: scan.score, kind: scan.pages ? "full" : "quick",
      counts: JSON.stringify(scan.counts ?? {}),
      data: JSON.stringify(scan),
    });
    return Number(info.lastInsertRowid);
  },

  list() {
    return db.prepare(
      `SELECT id, url, title, timestamp, score, kind, counts
       FROM sessions ORDER BY timestamp DESC LIMIT 200`
    ).all().map(r => ({ ...r, counts: JSON.parse(r.counts) }));
  },

  get(id) {
    const r = db.prepare(`SELECT data FROM sessions WHERE id = ?`).get(id);
    return r ? JSON.parse(r.data) : null;
  },

  remove(id) {
    return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
  },
};
