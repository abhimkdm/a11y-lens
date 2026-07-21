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

// WAL + a busy timeout. Without these, a second sidecar instance dies at import
// time with a bare "database is locked" — which masks the ACTUAL problem (the
// port is already taken) behind a misleading error. Now it gets past the DB and
// fails on the port, where the message is honest.
try {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
} catch {
  // Older drivers may not support these; not fatal.
}

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
  CREATE TABLE IF NOT EXISTS crawls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    root_url TEXT NOT NULL,
    source TEXT NOT NULL,              -- crawl | sitemap | list | import
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    config TEXT                        -- JSON: maxPages, maxDepth, includeExternal...
  );
  CREATE TABLE IF NOT EXISTS crawl_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    parent_url TEXT,                   -- NULL for roots; this is what makes it a tree
    depth INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    status_code INTEGER,
    content_type TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    discovered_at TEXT NOT NULL,
    last_scanned TEXT,
    last_score INTEGER,
    note TEXT,
    UNIQUE(crawl_id, url)
  );
  CREATE INDEX IF NOT EXISTS idx_crawl_urls_crawl ON crawl_urls(crawl_id);
  CREATE INDEX IF NOT EXISTS idx_crawl_urls_parent ON crawl_urls(crawl_id, parent_url);
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

// The underlying SQLite handle, so modules that own their own table (the healing
// memory) can create and query it without routing through these collections.
export const rawDb = db;

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

export const crawls = {
  create({ name, rootUrl, source, config }) {
    const now = new Date().toISOString();
    const info = db.prepare(
      `INSERT INTO crawls (name, root_url, source, created_at, updated_at, config)
       VALUES (@name, @rootUrl, @source, @now, @now, @config)`
    ).run({ name, rootUrl, source, now, config: JSON.stringify(config ?? {}) });
    return Number(info.lastInsertRowid);
  },

  list() {
    return db.prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM crawl_urls u WHERE u.crawl_id = c.id) AS urlCount,
              (SELECT COUNT(*) FROM crawl_urls u WHERE u.crawl_id = c.id AND u.enabled = 1) AS enabledCount
       FROM crawls c ORDER BY c.updated_at DESC`
    ).all().map((r) => ({ ...r, config: r.config ? JSON.parse(r.config) : {} }));
  },

  get(id) {
    const c = db.prepare("SELECT * FROM crawls WHERE id = ?").get(id);
    if (!c) return null;
    const urls = db.prepare(
      "SELECT * FROM crawl_urls WHERE crawl_id = ? ORDER BY depth, url"
    ).all(id).map((u) => ({ ...u, enabled: !!u.enabled }));
    return { ...c, config: c.config ? JSON.parse(c.config) : {}, urls };
  },

  remove(id) {
    db.prepare("DELETE FROM crawl_urls WHERE crawl_id = ?").run(id);
    return db.prepare("DELETE FROM crawls WHERE id = ?").run(id).changes > 0;
  },

  touch(id) {
    db.prepare("UPDATE crawls SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  },

  // Insert or update a discovered URL. A re-crawl must not duplicate rows, and it
  // must not silently reset the enable/disable choices the user already made —
  // that is their curation, and losing it would be worse than a stale title.
  upsertUrl(crawlId, u) {
    db.prepare(
      `INSERT INTO crawl_urls (crawl_id, url, parent_url, depth, title, status_code, content_type, enabled, discovered_at)
       VALUES (@crawlId, @url, @parentUrl, @depth, @title, @statusCode, @contentType, 1, @now)
       ON CONFLICT(crawl_id, url) DO UPDATE SET
         title = COALESCE(excluded.title, crawl_urls.title),
         status_code = COALESCE(excluded.status_code, crawl_urls.status_code),
         content_type = COALESCE(excluded.content_type, crawl_urls.content_type),
         parent_url = COALESCE(crawl_urls.parent_url, excluded.parent_url),
         depth = MIN(crawl_urls.depth, excluded.depth)`
    ).run({
      crawlId,
      url: u.url,
      parentUrl: u.parentUrl ?? null,
      depth: u.depth ?? 0,
      title: u.title ?? null,
      statusCode: u.statusCode ?? null,
      contentType: u.contentType ?? null,
      now: new Date().toISOString(),
    });
  },

  setEnabled(crawlId, urls, enabled) {
    const stmt = db.prepare("UPDATE crawl_urls SET enabled = ? WHERE crawl_id = ? AND url = ?");
    for (const url of urls) stmt.run(enabled ? 1 : 0, crawlId, url);
    this.touch(crawlId);
    return urls.length;
  },

  markScanned(crawlId, url, score) {
    db.prepare(
      "UPDATE crawl_urls SET last_scanned = ?, last_score = ? WHERE crawl_id = ? AND url = ?"
    ).run(new Date().toISOString(), score ?? null, crawlId, url);
  },

  enabledUrls(crawlId) {
    return db.prepare(
      "SELECT url FROM crawl_urls WHERE crawl_id = ? AND enabled = 1 ORDER BY depth, url"
    ).all(crawlId).map((r) => r.url);
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
      // hasAi lets the UI hide AI-only actions (the AI cost export) on scans that
      // never ran a model. Computed with json_extract so we don't parse 200 blobs:
      // an AI Full Scan sets data.aiAudit, "Generate AI Report" sets data.aiReport.
      `SELECT id, url, title, timestamp, score, kind, counts,
              (json_extract(data, '$.aiAudit')  IS NOT NULL
            OR json_extract(data, '$.aiReport') IS NOT NULL) AS hasAi
       FROM sessions ORDER BY timestamp DESC LIMIT 200`
    ).all().map(r => ({ ...r, counts: JSON.parse(r.counts), hasAi: !!r.hasAi }));
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
