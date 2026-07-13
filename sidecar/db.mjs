// A11y Lens session store (Phase 10) — SQLite via better-sqlite3.
// Every scan becomes a session row; full scan payload is stored as JSON.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const dir = process.env.A11Y_DATA_DIR || join(homedir(), ".a11y-lens");
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, "sessions.db");

// Prefer Node's BUILT-IN SQLite (Node >= 22.5). Two concrete reasons, both of
// which we hit for real:
//
//   1. better-sqlite3 is a native addon compiled against a specific Node ABI.
//      Upgrading Node breaks it with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION
//      mismatch, which is exactly the crash we saw on Node 24.
//   2. Native .node binaries do not bundle reliably into a single-file sidecar
//      executable, so the packaged MSI would ship a sidecar that dies on launch.
//
// node:sqlite has no addon to compile and no addon to bundle. The API is
// compatible with the subset we use (prepare/run/get/all/exec, @named params),
// so this is a genuine drop-in. better-sqlite3 remains the fallback for older Node.
function openDatabase() {
  try {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const { DatabaseSync } = require_("node:sqlite");
    return { db: new DatabaseSync(dbPath), driver: "node:sqlite" };
  } catch {
    const Database = require_("better-sqlite3");
    return { db: new Database(dbPath), driver: "better-sqlite3" };
  }
}

const require_ = createRequire(import.meta.url);
const { db, driver } = openDatabase();
console.log(`[a11y-sidecar] storage: ${driver} (${dbPath})`);

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
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,          -- error | warning | info
    source TEXT NOT NULL,         -- ai-report | expert-audit | scan | export | sidecar
    message TEXT NOT NULL,
    detail TEXT,                  -- stack, offending payload, model output excerpt
    context TEXT                  -- JSON: url, provider, model, etc.
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp DESC);
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

export const logs = {
  add({ level = "error", source = "sidecar", message, detail = null, context = null }) {
    if (!message) return null;
    const info = db.prepare(
      `INSERT INTO logs (timestamp, level, source, message, detail, context)
       VALUES (@timestamp, @level, @source, @message, @detail, @context)`
    ).run({
      timestamp: new Date().toISOString(),
      level, source,
      message: String(message).slice(0, 2000),
      detail: detail ? String(detail).slice(0, 20000) : null,
      context: context ? JSON.stringify(context).slice(0, 4000) : null,
    });
    return Number(info.lastInsertRowid);
  },

  list(limit = 200) {
    return db.prepare(
      `SELECT id, timestamp, level, source, message, detail, context
       FROM logs ORDER BY id DESC LIMIT ?`
    ).all(limit).map((r) => ({
      ...r,
      context: r.context ? JSON.parse(r.context) : null,
    }));
  },

  unreadErrorCount(sinceId = 0) {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM logs WHERE level = 'error' AND id > ?`
    ).get(sinceId);
    return r?.n ?? 0;
  },

  clear() {
    db.prepare("DELETE FROM logs").run();
    return true;
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

  update(id, scan) {
    const info = db.prepare(
      `UPDATE sessions SET url=@url, title=@title, score=@score, counts=@counts, data=@data WHERE id=@id`
    ).run({
      id,
      url: scan.url,
      title: scan.title ?? "",
      score: scan.score ?? 0,
      counts: JSON.stringify(scan.counts ?? {}),
      data: JSON.stringify(scan),
    });
    return info.changes > 0;
  },

  remove(id) {
    return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
  },
};
