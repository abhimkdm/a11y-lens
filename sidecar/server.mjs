// A11y Lens sidecar — Playwright + axe-core automation layer.
// Runs as a local HTTP server the Tauri/React app talks to.
//
//   POST /session/open     { url }            -> launches headed Chromium, user logs in manually
//   POST /scan/quick       { }                -> injects axe-core into the CURRENT page, returns violations
//   POST /scan/keyboard    { }                -> tab-order + focus-visibility audit of current page
//   POST /overlay/show     { violations }     -> draw markers + tooltips on the live page
//   POST /overlay/clear                       -> remove overlay
//   GET  /session/status                      -> { open, url, title }
//
// Install:  npm i playwright axe-core express   &&   npx playwright install chromium
import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { OVERLAY_SOURCE } from "./overlay.mjs";
import { TOOLBAR_SOURCE } from "./toolbar.mjs";
import { createCrawler } from "./crawler.mjs";
import { generateAiReport } from "./report.mjs";
import { AI_PROVIDER_DEFAULTS, testAiConnection } from "./ai.mjs";
import { sessions, settings, audit } from "./db.mjs";
import { encrypt, decrypt, maskScan, assertProviderAllowed } from "./security.mjs";
import { compareScans } from "./compare.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const app = express();
app.use(cors());               // allow the Tauri webview / dev server to call this local API
app.use(express.json({ limit: "40mb" }));

let browser = null;
let page = null;
const crawler = createCrawler();

app.post("/session/open", async (req, res) => {
  try {
    if (!browser) {
      browser = await chromium.launch({ headless: false, channel: "chrome" })
        .catch(() => chromium.launch({ headless: false }));
    }
    const ctx = await browser.newContext({ viewport: null });
    page = await ctx.newPage();
    if (req.body?.url) await page.goto(req.body.url, { waitUntil: "domcontentloaded" });
    res.json({ ok: true, message: "Browser open. Log in manually, then run a scan." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/session/status", async (_req, res) => {
  if (!page) return res.json({ open: false });
  res.json({ open: true, url: page.url(), title: await page.title().catch(() => "") });
});

app.post("/scan/quick", async (_req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one first." });
  try {
    await page.evaluate(axeSource);
    const results = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
        resultTypes: ["violations", "incomplete"],
      });
    });
    const screenshot = await page.screenshot({ fullPage: false }).then(b => b.toString("base64"));
    const violations = results.violations.map(v => ({
      id: v.id,
      impact: v.impact ?? "minor",
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      wcag: v.tags.filter(t => /^wcag\d/.test(t)),
      nodes: v.nodes.slice(0, 25).map(n => ({
        target: n.target.join(" "),
        html: n.html,
        failureSummary: n.failureSummary,
      })),
    }));
    const score = computeScore(violations);
    res.json({
      ok: true,
      url: page.url(),
      title: await page.title(),
      timestamp: new Date().toISOString(),
      score,
      counts: countBySeverity(violations),
      violations,
      screenshot,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/scan/keyboard", async (_req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session." });
  try {
    const findings = await page.evaluate(() => {
      const issues = [];
      const focusables = [...document.querySelectorAll(
        'a[href],button,input,select,textarea,[tabindex]'
      )];
      for (const el of focusables) {
        const style = getComputedStyle(el);
        const hidden = style.display === "none" || style.visibility === "hidden";
        const ti = el.getAttribute("tabindex");
        if (hidden && (!ti || +ti >= 0))
          issues.push({ type: "hidden-focusable", target: el.tagName.toLowerCase(), html: el.outerHTML.slice(0, 160) });
        if (ti && +ti > 0)
          issues.push({ type: "positive-tabindex", target: el.tagName.toLowerCase(), html: el.outerHTML.slice(0, 160) });
        if (style.outlineStyle === "none" && !style.boxShadow.includes("rgb"))
          issues.push({ type: "possible-missing-focus-indicator", target: el.tagName.toLowerCase(), html: el.outerHTML.slice(0, 160) });
      }
      return issues;
    });
    res.json({ ok: true, findings, count: findings.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});


app.post("/overlay/show", async (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session." });
  try {
    const violations = req.body?.violations ?? [];
    const placed = await page.evaluate(`(${OVERLAY_SOURCE})(${JSON.stringify(violations)})`);
    res.json({ ok: true, placed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/overlay/clear", async (_req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session." });
  await page.evaluate("window.__a11yLens && window.__a11yLens.destroy()").catch(() => {});
  res.json({ ok: true });
});


// ---- Phase 6: AI Full Scan --------------------------------------------
app.post("/scan/full/start", (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one and log in first." });
  if (crawler.state.running) return res.status(409).json({ ok: false, error: "A full scan is already running." });
  crawler.start(page, { maxPages: req.body?.maxPages, ai: req.body?.ai });
  res.json({ ok: true });
});

app.get("/scan/full/status", (_req, res) => {
  const s = crawler.state;
  res.json({
    ok: true, running: s.running, currentUrl: s.currentUrl,
    pages: s.pagesScanned, log: s.log.slice(-12), error: s.error, result: s.result,
  });
});

app.post("/scan/full/stop", (_req, res) => { crawler.stop(); res.json({ ok: true }); });


// ---- Phase 8: AI report ------------------------------------------------
app.post("/report/ai", async (req, res) => {
  const { scan, ai } = req.body ?? {};
  // eslint-disable-next-line no-unused-vars
  if (!scan?.violations) return res.status(400).json({ ok: false, error: "No scan data provided." });
  try {
    const resolved = resolveAi(ai);
    audit.log("report.ai.generate", `${resolved.provider}/${resolved.model}`);
    const report = await generateAiReport(scan, resolved);
    res.json({ ok: true, report });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});


// ---- Phase 10: sessions (SQLite) --------------------------------------
app.get("/sessions", (_req, res) => res.json({ ok: true, sessions: sessions.list() }));

app.get("/sessions/:id", (req, res) => {
  const scan = sessions.get(+req.params.id);
  scan ? res.json({ ok: true, scan }) : res.status(404).json({ ok: false, error: "Session not found." });
});

app.post("/sessions", (req, res) => {
  let scan = req.body?.scan;
  if (!scan?.url || !scan?.timestamp) return res.status(400).json({ ok: false, error: "Invalid scan payload." });
  if (securityConfig().masking) scan = maskScan(scan);
  audit.log("session.save", scan.url);
  res.json({ ok: true, id: sessions.save(scan) });
});

app.delete("/sessions/:id", (req, res) => {
  audit.log("session.delete", req.params.id);
  res.json({ ok: sessions.remove(+req.params.id) });
});

// ---- Phase 11: import (export is a client-side file download) ---------
app.post("/sessions/import", (req, res) => {
  const scan = req.body?.scan;
  if (!scan?.url || !scan?.violations) return res.status(400).json({ ok: false, error: "Not a valid A11y Lens session file." });
  audit.log("session.import", scan.url);
  res.json({ ok: true, id: sessions.save(securityConfig().masking ? maskScan(scan) : scan) });
});

// ---- Phase 13: comparison ----------------------------------------------
app.post("/compare", (req, res) => {
  const { prevId, currId } = req.body ?? {};
  const a = sessions.get(+prevId), b = sessions.get(+currId);
  if (!a || !b) return res.status(404).json({ ok: false, error: "One or both sessions not found." });
  res.json({ ok: true, comparison: compareScans(a, b) });
});


// ---- Phase 15: security ------------------------------------------------
function securityConfig() {
  return settings.get("security") ?? { localOnly: false, masking: true };
}

// Resolve the AI config for a request: stored encrypted key wins over a
// request-supplied one; local-only mode is enforced for every AI call.
function resolveAi(reqAi) {
  const stored = settings.get("ai");
  const provider = reqAi?.provider || stored?.provider;
  const defaults = AI_PROVIDER_DEFAULTS[provider] ?? {};
  const ai = {
    provider,
    model: reqAi?.model || stored?.model || defaults.model,
    baseUrl: reqAi?.baseUrl || stored?.baseUrl || defaults.baseUrl,
    apiKey: stored?.apiKeyEnc ? decrypt(stored.apiKeyEnc) : reqAi?.apiKey,
  };
  assertProviderAllowed(ai.provider, securityConfig().localOnly);
  return ai;
}

app.get("/settings/ai", (_req, res) => {
  const s = settings.get("ai") ?? {};
  res.json({ ok: true, provider: s.provider ?? "", model: s.model ?? "", baseUrl: s.baseUrl ?? "", hasKey: !!s.apiKeyEnc });
});

app.get("/settings/ai/providers", (_req, res) => {
  res.json({ ok: true, defaults: AI_PROVIDER_DEFAULTS });
});

app.post("/settings/ai", (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body ?? {};
  const prev = settings.get("ai") ?? {};
  settings.set("ai", {
    provider, model, baseUrl,
    apiKeyEnc: apiKey ? encrypt(apiKey) : prev.apiKeyEnc, // keep existing key if blank
  });
  audit.log("settings.ai.update", `${provider}/${model}`);
  res.json({ ok: true });
});

app.post("/settings/ai/test", async (req, res) => {
  try {
    const ai = resolveAi(req.body?.ai);
    const result = await testAiConnection(ai);
    audit.log("settings.ai.test", `${result.provider}/${result.model}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.get("/settings/security", (_req, res) => res.json({ ok: true, ...securityConfig() }));

app.post("/settings/security", (req, res) => {
  const cfg = { ...securityConfig(), ...req.body };
  settings.set("security", cfg);
  audit.log("settings.security.update", JSON.stringify(cfg));
  res.json({ ok: true, ...cfg });
});

app.get("/audit", (_req, res) => res.json({ ok: true, entries: audit.list() }));


// ---- Inspect Toolbar (Silktide-style manual tools) ---------------------
app.post("/toolbar/show", async (_req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session." });
  try {
    await page.evaluate(`(${TOOLBAR_SOURCE})()`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/toolbar/hide", async (_req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session." });
  await page.evaluate("window.__a11yToolbar && window.__a11yToolbar.destroy()").catch(() => {});
  res.json({ ok: true });
});

function countBySeverity(vs) {
  const c = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of vs) c[v.impact] = (c[v.impact] ?? 0) + v.nodes.length;
  return c;
}
function computeScore(vs) {
  const w = { critical: 10, serious: 5, moderate: 2, minor: 1 };
  const penalty = vs.reduce((s, v) => s + (w[v.impact] ?? 1) * Math.min(v.nodes.length, 10), 0);
  return Math.max(0, Math.round(100 - penalty));
}

const PORT = process.env.A11Y_SIDECAR_PORT || 8787;
app.listen(PORT, () => console.log(`[a11y-sidecar] listening on http://localhost:${PORT}`));
