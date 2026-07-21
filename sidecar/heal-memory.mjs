// Healing memory — the tool gets smarter each time it repairs itself.
//
// The first time a control moves ("Continue" became "Next"), healing costs a
// fingerprint scan and possibly a model call. Remembering that mapping means
// every later replay resolves it instantly, for free. Without this, the same
// page change is re-diagnosed on every run — the expensive part repeated forever.
//
// Keyed by origin + a hash of the recorded identity, so a memory learned on one
// journey helps every other journey that touches the same control.

import { createHash } from "node:crypto";

export function fingerprintKey(origin, fp) {
  if (!fp) return null;
  // Identity, not position: the same control keeps its key even after it moves.
  const parts = [
    String(origin || ""),
    (fp.role || "").toLowerCase(),
    (fp.name || fp.text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60),
    (fp.section || "").toLowerCase().slice(0, 40),
    (fp.page || ""),
  ].join("|");
  return createHash("sha1").update(parts).digest("hex").slice(0, 16);
}

export function createHealMemory(db) {
  // Table is created lazily so the module works even against an older database.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS healing_history (
      key         TEXT PRIMARY KEY,
      origin      TEXT,
      was         TEXT,
      now         TEXT,
      selector    TEXT NOT NULL,
      confidence  INTEGER,
      healed_by   TEXT,
      hits        INTEGER DEFAULT 0,
      created_at  TEXT,
      last_used   TEXT
    )`);
  } catch { /* read-only or older schema — memory just stays disabled */ }

  const ready = (() => {
    try { db.prepare("SELECT 1 FROM healing_history LIMIT 1").get(); return true; }
    catch { return false; }
  })();

  return {
    enabled: ready,

    // Look up a previously learned mapping. Returns the selector to try first.
    recall(origin, fp) {
      if (!ready) return null;
      const key = fingerprintKey(origin, fp);
      if (!key) return null;
      try {
        const r = db.prepare("SELECT * FROM healing_history WHERE key = ?").get(key);
        if (!r) return null;
        return {
          selector: JSON.parse(r.selector),
          confidence: r.confidence,
          was: r.was, now: r.now,
          hits: r.hits,
          healedBy: r.healed_by,
        };
      } catch { return null; }
    },

    // Record a successful heal so the next run skips straight to the answer.
    remember(origin, fp, { selector, confidence, healedBy, was, now }) {
      if (!ready) return;
      const key = fingerprintKey(origin, fp);
      if (!key) return;
      const iso = new Date().toISOString();
      try {
        db.prepare(`INSERT INTO healing_history
            (key, origin, was, now, selector, confidence, healed_by, hits, created_at, last_used)
          VALUES (?,?,?,?,?,?,?,1,?,?)
          ON CONFLICT(key) DO UPDATE SET
            now=excluded.now, selector=excluded.selector,
            confidence=MAX(healing_history.confidence, excluded.confidence),
            healed_by=excluded.healed_by,
            hits=healing_history.hits+1, last_used=excluded.last_used`)
          .run(key, origin ?? "", was ?? "", now ?? "", JSON.stringify(selector),
               confidence ?? 0, healedBy ?? "", iso, iso);
      } catch { /* never let bookkeeping break a replay */ }
    },

    // Confirm a recalled mapping still worked (raises its standing).
    confirm(origin, fp) {
      if (!ready) return;
      const key = fingerprintKey(origin, fp);
      if (!key) return;
      try {
        db.prepare("UPDATE healing_history SET hits = hits + 1, last_used = ? WHERE key = ?")
          .run(new Date().toISOString(), key);
      } catch { /* ignore */ }
    },

    // A recalled mapping that no longer resolves is stale — forget it rather than
    // keep trying a selector the page has moved past.
    forget(origin, fp) {
      if (!ready) return;
      const key = fingerprintKey(origin, fp);
      if (!key) return;
      try { db.prepare("DELETE FROM healing_history WHERE key = ?").run(key); } catch { /* ignore */ }
    },

    list(limit = 200) {
      if (!ready) return [];
      try {
        return db.prepare(
          `SELECT key, origin, was, now, confidence, healed_by AS healedBy, hits, created_at AS createdAt, last_used AS lastUsed
           FROM healing_history ORDER BY last_used DESC LIMIT ?`).all(limit);
      } catch { return []; }
    },

    clear() {
      if (!ready) return 0;
      try { return db.prepare("DELETE FROM healing_history").run().changes; } catch { return 0; }
    },
  };
}
