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
// node:sqlite emits an ExperimentalWarning on every launch. It is stable enough
// for our use and the warning only confuses users reading the app log.
process.env.NODE_NO_WARNINGS = "1";

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { OVERLAY_SOURCE } from "./overlay.mjs";
import { TOOLBAR_SOURCE } from "./toolbar.mjs";
import { createCrawler } from "./crawler.mjs";
import { generateAiReport } from "./report.mjs";
import { deduplicate, generateExecutiveSummary } from "./report-site.mjs";
import { buildSiteReport } from "./report-site-html.mjs";
import { AI_PROVIDER_DEFAULTS, aiChat } from "./ai.mjs";
import { createRecorder } from "./recorder.mjs";
import { createReplayer, replayAll, validateRecording } from "./replay.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runExpertAudit } from "./expert-audit.mjs";
import { runCrossCheckAudit } from "./cross-check.mjs";
import { captureElementScreenshots, installHighlighter } from "./element-shots.mjs";
import { captureKeyboardEvidence } from "./keyboard-evidence.mjs";
import { createCrawlExplorer } from "./crawl-explorer.mjs";
import { browserStatus, createBrowserInstaller } from "./browser-setup.mjs";
import {
  toolchainStatus, listAllDevices, bootAndroidEmulator, bootIosSimulator,
  listAndroidApps, launchAndroidApp, listIosApps, launchIosApp
} from "./mobile/device.mjs";
import { scanMobile } from "./mobile/scanner.mjs";
import { startFlow, flowStep, stopFlow, cancelFlow, flowStatus } from "./mobile/flow.mjs";
import { renderMobileReportHtml } from "./mobile/report-html.mjs";
import { renderMobileAiUsageReportHtml } from "./mobile/report-ai-usage-html.mjs";
import { sessions, settings, audit, logs, crawls } from "./db.mjs";
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
const recorder = createRecorder();
const explorer = createCrawlExplorer();
const browserInstaller = createBrowserInstaller();

app.post("/session/open", async (req, res) => {
  // Fail with the actual cause, not a Playwright stack trace the user can't act on.
  if (!browserStatus().installed) {
    return res.status(412).json({
      ok: false,
      error: "The browser engine isn't installed yet.",
      needsBrowser: true,
    });
  }
  try {
    if (recorder.state.active) recorder.stop(); // avoid a dangling listener on the old page object
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

// Identifies THIS process as an A11y Lens sidecar. Rust probes it before
// spawning: if our own sidecar is already healthy we reuse it rather than
// starting a second one; if something else holds the port we can say so.
app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "a11y-lens-sidecar", version: "2.0.0", pid: process.pid });
});

app.get("/session/status", async (_req, res) => {
  if (!page) return res.json({ open: false });
  res.json({ open: true, url: page.url(), title: await page.title().catch(() => "") });
});

// ---- Path recorder (v2 — action capture) ---------------------------------
// Record a QA person's manual journey (login -> open account -> checkout) as an
// ordered list of ACTIONS with ranked selector chains — not just URLs — so the
// path replays on a SPA where views don't change the URL. Export to disk, import
// later, and replay either to reproduce the path or to scan every state it
// reveals. Secrets are never captured (masked) and never written to disk.

// A recording loaded from disk, held in memory for replay. Never persisted with
// secrets — validateRecording strips any value from masked steps on the way in.
let importedRecording = null;

// Reproduce-only replay progress (scan replays reuse crawler.state instead).
let replayState = { running: false, mode: null, log: [], summary: null, error: null };
function rlog(msg) {
  replayState.log.push({ t: new Date().toISOString(), msg });
  if (replayState.log.length > 200) replayState.log.shift();
}

app.post("/record/start", async (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one first." });
  try {
    await recorder.start(page);
    audit.log("record.start", page.url());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.post("/record/stop", (_req, res) => {
  const entries = recorder.stop();
  const recording = recorder.toJSON();
  audit.log("record.stop", `${entries.length} checkpoints, ${recording.steps.length} actions`);
  res.json({ ok: true, entries, steps: recording.steps.length, checkpoints: recording.checkpoints.length, recording });
});

app.get("/record/status", (_req, res) => {
  res.json({
    ok: true,
    active: recorder.state.active,
    entries: recorder.state.entries,
    steps: recorder.state.steps.length,
  });
});

// Export the current recording as a downloadable JSON file (safe: no secrets).
app.get("/record/export", (_req, res) => {
  const rec = recorder.toJSON();
  if (!rec.steps.length) return res.status(400).json({ ok: false, error: "Nothing recorded yet." });
  audit.log("record.export", `${rec.steps.length} actions`);
  res.json({ ok: true, recording: rec });
});

// Import a previously saved recording so it can be replayed on another machine
// or in a later session. Rejects anything without our marker and defensively
// strips any masked-field values that a hand-edited file might contain.
app.post("/record/import", (req, res) => {
  try {
    const rec = validateRecording(req.body?.recording ?? req.body);
    importedRecording = rec;
    audit.log("record.import", `${rec.steps.length} actions, ${(rec.checkpoints || []).length} checkpoints`);
    res.json({
      ok: true,
      startUrl: rec.startUrl,
      origin: rec.origin,
      steps: rec.steps.length,
      checkpoints: (rec.checkpoints || []).length,
      masked: rec.steps.filter((s) => s.masked).length,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message ?? e) });
  }
});

// Replay. Two modes:
//   scan=false  -> reproduce the path only (QA checks it still works).
//   scan=true   -> drive to each checkpoint and run the full scan on that state,
//                  including the AI audit + interaction pass, exactly like a
//                  normal AI Full Scan but on states reached by real actions.
// source: "imported" (default if present) or "current" (the just-recorded one).
app.post("/record/replay/start", async (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one and log in first." });
  if (replayState.running || crawler.state.running) {
    return res.status(409).json({ ok: false, error: "A scan or replay is already running." });
  }
  const source = req.body?.source === "current" ? "current" : (importedRecording ? "imported" : "current");
  const recording = source === "imported" ? importedRecording : recorder.toJSON();
  if (!recording || !Array.isArray(recording.steps) || recording.steps.length === 0) {
    return res.status(400).json({ ok: false, error: "No recording to replay. Record a path or import one first." });
  }

  // Safety: the session is authenticated against the currently open origin. If
  // the recording was made against a different origin, refuse rather than driving
  // recorded actions (possibly form submits) against the wrong host.
  let pageOrigin = null;
  try { pageOrigin = new URL(page.url()).origin; } catch { /* blank page */ }
  if (recording.origin && pageOrigin && recording.origin !== pageOrigin && pageOrigin !== "null") {
    return res.status(409).json({
      ok: false,
      error: `Recording was made on ${recording.origin} but the open session is on ${pageOrigin}. Open a session on the recording's origin first.`,
    });
  }

  const scan = req.body?.scan !== false;
  const replayer = createReplayer(recording, { onLog: (m) => (scan ? null : rlog(m)) });

  if (!scan) {
    // Reproduce-only: run every step, report where it breaks / where it's fragile.
    replayState = { running: true, mode: "reproduce", log: [], summary: null, error: null };
    audit.log("record.replay", `reproduce · ${recording.steps.length} actions`);
    res.json({ ok: true, mode: "reproduce", steps: recording.steps.length });
    try {
      const summary = await replayAll(page, recording, { onLog: rlog });
      replayState.summary = summary;
    } catch (e) {
      replayState.error = String(e.message ?? e);
    } finally {
      replayState.running = false;
    }
    return;
  }

  // Scan mode: hand the crawler a navigator that drives the recorded actions.
  let ai;
  try { ai = resolveAi(req.body?.ai); } catch (e) { return res.status(403).json({ ok: false, error: String(e.message ?? e) }); }
  const aiAudit = req.body?.aiAudit === true;
  if (aiAudit && !ai?.provider) {
    return res.status(403).json({ ok: false, error: "AI replay scan needs an AI provider. Configure one in Settings first." });
  }
  const interact = !!req.body?.interact;
  const allowMutations = interact && req.body?.allowMutations === true;

  audit.log(
    "record.replay",
    `scan · ${replayer.checkpointCount} checkpoints${aiAudit ? " · AI-audit" : ""}` +
    `${interact ? ` · interaction:${allowMutations ? "OPERATE" : "explore"}` : ""}`
  );

  crawler.start(page, {
    ai, aiAudit, interact, allowMutations,
    valueProfile: req.body?.valueProfile ?? null,
    maxInteractions: req.body?.maxInteractions,
    navigator: replayer.navigator,
    checkpointCount: replayer.checkpointCount,
  });
  res.json({ ok: true, mode: "scan", checkpoints: replayer.checkpointCount, aiAudit });
});

app.get("/record/replay/status", (_req, res) => {
  if (replayState.mode === "reproduce") {
    res.json({
      ok: true, mode: "reproduce", running: replayState.running,
      log: replayState.log.slice(-20), summary: replayState.summary, error: replayState.error,
    });
  } else {
    // scan replays report through the normal crawler status
    const s = crawler.state;
    res.json({
      ok: true, mode: "scan", running: s.running, currentUrl: s.currentUrl,
      pages: s.pagesScanned, log: s.log.slice(-12), error: s.error, result: s.result,
    });
  }
});

app.post("/scan/quick", async (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one first." });
  try {
    await page.evaluate(axeSource);
    const results = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: {
          type: "tag",
          // WCAG 2.1 Level A + AA only — the target standard.
          // "best-practice" is deliberately excluded: those rules are good advice
          // but are NOT WCAG conformance failures, and mixing them in overstates
          // the violation count against WCAG 2.1.
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
        resultTypes: ["violations", "incomplete"],
      });
    });
    const screenshot = await page.screenshot({ fullPage: false }).then(b => b.toString("base64"));
    let violations = results.violations.map(v => ({
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
    // Visual evidence: a screenshot of each failing element, highlighted. A
    // selector tells a developer where the problem is; a picture tells them
    // WHICH of five near-identical banners is actually broken.
    let shotStats = null;
    if (req.body?.elementScreenshots !== false) {
      try {
        await installHighlighter(page);
        const r = await captureElementScreenshots(page, violations, {
          maxPerRule: Number(req.body?.maxShotsPerRule) || 5,
          maxTotal: Number(req.body?.maxShotsTotal) || 40,
        });
        violations = r.violations;
        shotStats = r.stats;
      } catch (e) {
        // Visual evidence is a bonus, never a reason to lose the scan.
        logs.add({ level: "warning", source: "scan",
                   message: `Could not capture element screenshots: ${String(e.message ?? e)}`,
                   detail: e.stack, context: { url: page.url() } });
      }
    }

    // Keyboard & focus evidence. axe cannot press Tab, so focus order, traps,
    // hidden focus targets and missing focus rings are invisible to it — and were
    // therefore invisible to the AI report. Captured here so the report can see them.
    let keyboard = null;
    if (req.body?.keyboardEvidence !== false) {
      try {
        keyboard = await captureKeyboardEvidence(page, { excludeChrome: false });
      } catch (e) {
        logs.add({ level: "warning", source: "scan",
                   message: `Keyboard/focus evidence capture failed: ${String(e.message ?? e)}`,
                   detail: e.stack, context: { url: page.url() } });
      }
    }

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
      shotStats,
      keyboard,
    });
  } catch (e) {
    logs.add({ level: "error", source: "scan", message: String(e.message ?? e),
               detail: e.stack, context: { url: page?.url?.() } });
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


// ---- AI Expert Audit ---------------------------------------------------
// The complement to the axe pass: finds what scanners structurally cannot see
// (meaningful names, focus management, state exposure, visual-vs-programmatic
// mismatch). Runs against whatever page the existing session already has open —
// no separate navigation, no hardcoded paths.
let expertRunning = false;

app.post("/audit/expert", async (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one and log in first." });
  if (expertRunning) return res.status(409).json({ ok: false, error: "An expert audit is already running." });

  let ai;
  try { ai = resolveAi(req.body?.ai); } catch (e) { return res.status(403).json({ ok: false, error: String(e.message ?? e) }); }

  expertRunning = true;
  const started = Date.now();
  try {
    // Feed the model this page's real scanner results so it never re-reports
    // what axe already caught. Falls back to an empty list if no scan has run.
    const axeViolations = Array.isArray(req.body?.axeViolations) ? req.body.axeViolations : [];
    audit.log("audit.expert", `${ai.provider}/${ai.model} on ${page.url()}`);

    const common = {
      axeViolations,
      keyboardWalk: req.body?.keyboardWalk !== false,
      scope: req.body?.scope ?? "main",      // main | chrome | all
      probes: req.body?.probes !== false,    // deterministic focus + zoom/reflow probes
    };

    let result;
    if (req.body?.mode === "cross-check") {
      const aiB = resolveAiB(req.body?.aiB);
      if (!aiB) {
        return res.status(400).json({
          ok: false,
          error: "Cross-check needs a second model. Configure the cross-check agent in Settings — ideally a different provider family than your primary.",
        });
      }
      audit.log("audit.expert.crosscheck", `${ai.provider}/${ai.model} + ${aiB.provider}/${aiB.model}`);
      result = await runCrossCheckAudit(page, { aiA: ai, aiB, ...common });
    } else {
      result = await runExpertAudit(page, { ai, ...common });
    }
    result.durationMs = Date.now() - started;
    res.json({ ok: true, audit: result });
  } catch (e) {
    audit.log("audit.expert", `failed: ${String(e.message ?? e).slice(0, 120)}`);
    logs.add({ level: "error", source: "expert-audit", message: String(e.message ?? e),
               detail: [e.raw ? "MODEL OUTPUT (truncated):\n" + e.raw : null, e.stack].filter(Boolean).join("\n\n"),
               context: { url: page?.url?.(), provider: ai?.provider, model: ai?.model } });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  } finally {
    expertRunning = false;
  }
});

// ---- Phase 6: AI Full Scan --------------------------------------------
app.post("/scan/full/start", (req, res) => {
  if (!page) return res.status(400).json({ ok: false, error: "No browser session. Open one and log in first." });
  if (crawler.state.running) return res.status(409).json({ ok: false, error: "A full scan is already running." });
  let ai;
  try { ai = resolveAi(req.body?.ai); } catch (e) { return res.status(403).json({ ok: false, error: String(e.message ?? e) }); }
  const urlList = Array.isArray(req.body?.urlList) ? req.body.urlList : undefined;

  // Interaction scanning. The Operate gear (form-fill + real submit) is gated
  // ENTIRELY on this per-run flag — there is no stored default, so it cannot be
  // left on by accident: every mutating run is a fresh, explicit decision. We
  // also record which URL the run actually operated against, so a mutating run
  // pointed at the wrong host is visible after the fact.
  const interact = !!req.body?.interact;
  const allowMutations = interact && req.body?.allowMutations === true;
  const valueProfile = req.body?.valueProfile ?? null;
  // AI Full Scan: run the per-page manual-reviewer AI audit alongside axe.
  // Needs a working provider (the audit is the whole point), so fail clearly if
  // one wasn't resolved rather than silently running a plain Full Scan.
  const aiAudit = req.body?.aiAudit === true;
  if (aiAudit && !ai?.provider) {
    return res.status(403).json({ ok: false, error: "AI Full Scan needs an AI provider. Configure one in Settings first." });
  }

  audit.log(
    "scan.full.start",
    `${urlList ? `custom URL list (${urlList.length})` : page.url()}` +
    `${aiAudit ? " · AI-audit" : ""}` +
    `${interact ? ` · interaction:${allowMutations ? "OPERATE(mutations allowed)" : "explore"}` : ""}` +
    `${allowMutations ? ` · operating-against:${page.url()}` : ""}`
  );

  crawler.start(page, {
    maxPages: req.body?.maxPages, ai, urlList,
    interact, allowMutations, valueProfile,
    maxInteractions: req.body?.maxInteractions,
    aiAudit,
  });
  res.json({ ok: true, interaction: interact ? (allowMutations ? "operate" : "explore") : "off", aiAudit });
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
  if (!scan?.violations) return res.status(400).json({ ok: false, error: "No scan data provided." });

  let resolved;
  try {
    resolved = resolveAi(ai);
  } catch (e) {
    logs.add({ level: "error", source: "ai-report", message: String(e.message ?? e) });
    return res.status(403).json({ ok: false, error: String(e.message ?? e) });
  }

  try {
    audit.log("report.ai.generate", `${resolved.provider}/${resolved.model}`);
    const { report, warnings, degraded } = await generateAiReport(scan, resolved);

    // A model that emits one malformed snippet must not cost the user the whole
    // report. We got a report back, so by definition nothing here was fatal —
    // these are warnings, not errors. (Reserving "error" for genuine failures is
    // what keeps the "check Logs" alert meaningful instead of crying wolf.)
    for (const w of warnings ?? []) {
      logs.add({
        level: "warning",
        source: "ai-report",
        message: w.message,
        detail: w.detail,
        context: { url: scan.url, provider: resolved.provider, model: resolved.model, stage: w.stage },
      });
    }

    res.json({ ok: true, report, degraded: !!degraded, warningCount: (warnings ?? []).length });
  } catch (e) {
    // Total failure — nothing salvageable. Record everything we know about it.
    logs.add({
      level: "error",
      source: "ai-report",
      message: String(e.message ?? e),
      detail: [e.raw ? "MODEL OUTPUT (truncated):\n" + e.raw : null, e.stack].filter(Boolean).join("\n\n"),
      context: { url: scan.url, provider: resolved.provider, model: resolved.model },
    });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});


// ---- Site report (multi-page, deduplicated) -----------------------------
// A flat report of a 20-page scan repeats every footer issue 20 times. This
// collapses shared chrome into one "site-wide" section, gives each finding a
// stable id for ticketing, and writes a small static report site to disk.
app.post("/report/site", async (req, res) => {
  const scan = req.body?.scan;
  if (!Array.isArray(scan?.pages) || !scan.pages.length) {
    return res.status(400).json({
      ok: false,
      error: "A site report needs a multi-page scan. Run an AI Full Scan first.",
    });
  }

  try {
    const dedup = deduplicate(scan.pages);

    // The summary is a bonus — if the AI is unreachable we still write the
    // report rather than losing the whole thing.
    let summary = null;
    if (req.body?.summary !== false) {
      try {
        const ai = resolveAi(req.body?.ai);
        const r = await generateExecutiveSummary(dedup, ai, { generatedAt: new Date().toISOString() });
        summary = r.summary;
        for (const w of r.warnings ?? []) {
          logs.add({ level: "warning", source: "site-report", message: w.message, detail: w.detail });
        }
      } catch (e) {
        logs.add({
          level: "warning", source: "site-report",
          message: `Executive summary skipped: ${String(e.message ?? e)}`,
          detail: e.stack,
        });
      }
    }

    const files = buildSiteReport(dedup, summary, { generatedAt: new Date().toISOString() }, scan.pageShots ?? {});

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const dir = join(EXPORT_DIR, `a11y-report-${stamp}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, html] of Object.entries(files)) {
      writeFileSync(join(dir, name), html, "utf8");
    }

    audit.log("report.site", `${dedup.stats.pages} pages -> ${dir}`);
    res.json({
      ok: true,
      dir,
      index: join(dir, "index.html"),
      files: Object.keys(files).length,
      stats: dedup.stats,
      hasSummary: !!summary,
    });
  } catch (e) {
    logs.add({ level: "error", source: "site-report", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});


// ---- Crawl Explorer -----------------------------------------------------
// Discover a site's pages and organise them into a tree the user can curate,
// instead of trusting the AI crawler to wander somewhere useful. Crawling runs
// inside the authenticated browser session when one is open — an anonymous
// fetch of an enterprise app just maps the login page.
app.post("/crawl/start", async (req, res) => {
  if (explorer.state.running) {
    return res.status(409).json({ ok: false, error: "A crawl is already running." });
  }
  const { source = "crawl", rootUrl, sitemapUrl, urls, name, maxPages, maxDepth } = req.body ?? {};
  // Default both ON: confine to the root's path section and skip site chrome
  // (header/nav/footer) links, so a crawl seeded at /ecare/products stays inside
  // the app area instead of wandering out into the marketing site.
  const confinePath = req.body?.confinePath !== false;
  const skipChrome = req.body?.skipChrome !== false;
  const collapseTemplates = req.body?.collapseTemplates !== false;
  const routeTemplates = Array.isArray(req.body?.routeTemplates)
    ? req.body.routeTemplates.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const routeVars = (req.body?.routeVars && typeof req.body.routeVars === "object") ? req.body.routeVars : {};
  const autoHarvest = req.body?.autoHarvest !== false;
  const seedUrls = Array.isArray(req.body?.seedUrls)
    ? req.body.seedUrls.map((s) => String(s).trim()).filter(Boolean)
    : [];

  const seed = rootUrl || sitemapUrl || (Array.isArray(urls) && urls[0]);
  if (!seed) return res.status(400).json({ ok: false, error: "A root URL, sitemap URL, or URL list is required." });

  let origin;
  try { origin = new URL(seed).origin; }
  catch { return res.status(400).json({ ok: false, error: `Not a valid URL: ${seed}` }); }

  try {
    const crawlId = crawls.create({
      name: name || origin,
      rootUrl: rootUrl || origin,
      source,
      config: { maxPages: maxPages ?? 100, maxDepth: maxDepth ?? 3 },
    });

    audit.log("crawl.start", `${source} ${seed}`);

    // Fire and forget — the UI polls /crawl/status. A 500-page sitemap would
    // otherwise time out the request.
    explorer.start(page, {
      source,
      rootUrl,
      sitemapUrl,
      urls,
      maxPages: Math.min(Number(maxPages) || 100, 2000),
      maxDepth: Math.min(Number(maxDepth) || 3, 10),
      confinePath,
      skipChrome,
      seedUrls,
      collapseTemplates,
      routeTemplates,
      routeVars,
      autoHarvest,
      store: crawls,
      crawlId,
    }).catch((e) => {
      logs.add({ level: "error", source: "crawl", message: String(e.message ?? e), detail: e.stack });
    });

    res.json({ ok: true, crawlId, usingSession: !!page });
  } catch (e) {
    logs.add({ level: "error", source: "crawl", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.get("/crawl/status", (_req, res) => {
  const s = explorer.state;
  res.json({
    ok: true,
    running: s.running,
    done: s.done,
    crawlId: s.crawlId,
    source: s.source,
    discovered: s.discovered,
    queued: s.queued,
    currentUrl: s.currentUrl,
    error: s.error,
    log: s.log.slice(-12),
  });
});

app.post("/crawl/stop", (_req, res) => {
  explorer.stop();
  res.json({ ok: true });
});

app.get("/crawls", (_req, res) => res.json({ ok: true, crawls: crawls.list() }));

app.get("/crawls/:id", (req, res) => {
  const c = crawls.get(+req.params.id);
  c ? res.json({ ok: true, crawl: c }) : res.status(404).json({ ok: false, error: "Crawl not found." });
});

app.delete("/crawls/:id", (req, res) => {
  audit.log("crawl.delete", req.params.id);
  res.json({ ok: crawls.remove(+req.params.id) });
});

// Enable/disable pages for scanning. This is the user's curation, and a re-crawl
// deliberately preserves it.
app.patch("/crawls/:id/urls", (req, res) => {
  const { urls, enabled } = req.body ?? {};
  if (!Array.isArray(urls)) return res.status(400).json({ ok: false, error: "urls must be an array." });
  const n = crawls.setEnabled(+req.params.id, urls, !!enabled);
  res.json({ ok: true, updated: n });
});

// Re-crawl: refresh titles/status for selected URLs (or all enabled ones)
// without discarding the enable/disable choices already made.
app.post("/crawls/:id/recrawl", async (req, res) => {
  if (explorer.state.running) {
    return res.status(409).json({ ok: false, error: "A crawl is already running." });
  }
  const id = +req.params.id;
  const c = crawls.get(id);
  if (!c) return res.status(404).json({ ok: false, error: "Crawl not found." });

  const urls = Array.isArray(req.body?.urls) && req.body.urls.length
    ? req.body.urls
    : c.urls.filter((u) => u.enabled).map((u) => u.url);

  if (!urls.length) return res.status(400).json({ ok: false, error: "No URLs selected to re-crawl." });

  audit.log("crawl.recrawl", `${id}: ${urls.length} url(s)`);
  explorer.start(page, {
    source: "list",
    urls,
    maxPages: urls.length,
    store: crawls,
    crawlId: id,
  }).catch((e) => logs.add({ level: "error", source: "crawl", message: String(e.message ?? e) }));

  res.json({ ok: true, crawlId: id, count: urls.length });
});

// Export/import the crawl configuration so a curated page set can be shared or
// version-controlled rather than rebuilt by hand on every machine.
app.get("/crawls/:id/export", (req, res) => {
  const c = crawls.get(+req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: "Crawl not found." });
  res.json({
    ok: true,
    config: {
      format: "a11y-lens-crawl",
      version: 1,
      name: c.name,
      rootUrl: c.root_url,
      source: c.source,
      exportedAt: new Date().toISOString(),
      settings: c.config,
      urls: c.urls.map((u) => ({
        url: u.url,
        parentUrl: u.parent_url,
        depth: u.depth,
        title: u.title,
        enabled: u.enabled,
      })),
    },
  });
});

app.post("/crawls/import", (req, res) => {
  const cfg = req.body?.config ?? req.body;
  if (!cfg?.urls || !Array.isArray(cfg.urls)) {
    return res.status(400).json({ ok: false, error: "Not a valid A11y Lens crawl configuration." });
  }
  try {
    const crawlId = crawls.create({
      name: cfg.name || "Imported crawl",
      rootUrl: cfg.rootUrl || cfg.urls[0]?.url || "",
      source: "import",
      config: cfg.settings ?? {},
    });
    const disabled = [];
    for (const u of cfg.urls) {
      if (!u?.url) continue;
      crawls.upsertUrl(crawlId, {
        url: u.url,
        parentUrl: u.parentUrl ?? null,
        depth: u.depth ?? 0,
        title: u.title ?? null,
      });
      if (u.enabled === false) disabled.push(u.url);
    }
    // upsert defaults to enabled, so re-apply the exported disables.
    if (disabled.length) crawls.setEnabled(crawlId, disabled, false);

    audit.log("crawl.import", `${cfg.urls.length} url(s)`);
    res.json({ ok: true, crawlId, imported: cfg.urls.length });
  } catch (e) {
    logs.add({ level: "error", source: "crawl", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});


// ---- Browser engine bootstrap -------------------------------------------
// Chromium can't be bundled into an installer, and telling a QA tester to run
// `npx playwright install` is useless — they have an MSI, not a terminal. We
// ship Playwright's CLI and a Node runtime, so the app installs its own browser.
app.get("/browser/status", (_req, res) => {
  const st = browserStatus();
  res.json({
    ok: true,
    ...st,
    installing: browserInstaller.state.running,
    progress: browserInstaller.state.progress,
    installError: browserInstaller.state.error,
  });
});

app.post("/browser/install", (_req, res) => {
  if (browserInstaller.state.running) {
    return res.status(409).json({ ok: false, error: "The browser engine is already downloading." });
  }
  if (browserStatus().installed) {
    return res.json({ ok: true, alreadyInstalled: true });
  }
  audit.log("browser.install", "started");
  browserInstaller.install();
  res.json({ ok: true, started: true });
});

app.get("/browser/install/status", (_req, res) => {
  const s = browserInstaller.state;
  res.json({
    ok: true,
    running: s.running,
    done: s.done,
    error: s.error,
    progress: s.progress,
    log: s.log.slice(-10),
  });
});


// ---- Mobile scanner (Android / iOS) --------------------------------------
// A COMPLETELY SEPARATE engine from the web scanner. Native apps have no DOM,
// so Playwright, axe-core, the crawler and the overlay have no meaning here and
// none of them are used. Shared with the web engine: the AI layer, evidence
// verification, sessions and logs — the parts that aren't web-specific.
let mobileScanning = false;

app.get("/mobile/toolchain", async (_req, res) => {
  try {
    res.json({ ok: true, ...(await toolchainStatus()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.get("/mobile/devices", async (_req, res) => {
  try {
    res.json({ ok: true, ...(await listAllDevices()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.post("/mobile/boot", async (req, res) => {
  const { platform, id } = req.body ?? {};
  try {
    const r = platform === "ios" ? await bootIosSimulator(id) : await bootAndroidEmulator(id);
    audit.log("mobile.boot", `${platform} ${id}`);
    res.json({ ok: true, ...r });
  } catch (e) {
    logs.add({ level: "error", source: "mobile", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e), hint: e.hint ?? null });
  }
});

app.post("/mobile/scan", async (req, res) => {
  if (mobileScanning) {
    return res.status(409).json({ ok: false, error: "A mobile scan is already running." });
  }
  const { platform, deviceId, aiReview } = req.body ?? {};
  if (!["android", "ios"].includes(platform)) {
    return res.status(400).json({ ok: false, error: "platform must be 'android' or 'ios'." });
  }

  let ai = null;
  try { ai = resolveAi(req.body?.ai); } catch { /* AI is optional — the measured tier still runs */ }

  mobileScanning = true;
  try {
    audit.log("mobile.scan", `${platform} ${deviceId ?? "default"}`);
    const result = await scanMobile({ platform, deviceId, ai, aiReview: aiReview !== false });

    for (const w of result.warnings ?? []) {
      logs.add({ level: "warning", source: "mobile", message: w.message, detail: w.detail,
                 context: { platform, deviceId } });
    }

    // Mobile scans are stored as sessions too, so comparison and history work
    // exactly as they do for the web.
    const scan = {
      url: `${platform}://${result.app?.package ?? result.deviceId ?? "device"}`,
      title: `${result.device?.model ?? platform} — ${result.app?.package ?? "screen"}`,
      timestamp: result.timestamp,
      score: Math.max(0, 100 - (result.counts.critical * 10 + result.counts.serious * 5 +
                                result.counts.moderate * 2 + result.counts.minor)),
      counts: result.counts,
      violations: [],           // deliberately empty: these are not axe rules
      mobile: result,
    };
    const cfg = securityConfig();
    const id = sessions.save(cfg.masking ? maskScan(scan, { storeScreenshots: cfg.storeScreenshots }) : scan);

    res.json({ ok: true, result, sessionId: id });
  } catch (e) {
    logs.add({ level: "error", source: "mobile", message: String(e.message ?? e),
               detail: e.stack, context: { platform, deviceId } });
    res.status(500).json({ ok: false, error: String(e.message ?? e), hint: e.hint ?? null });
  } finally {
    mobileScanning = false;
  }
});

// ---- Mobile: app launcher -------------------------------------------------
app.get("/mobile/apps", async (req, res) => {
  const { platform, deviceId, all } = req.query ?? {};
  try {
    const includeSystem = all === "1" || all === "true";
    const apps = platform === "ios"
      ? await listIosApps(deviceId, { includeSystem })
      : await listAndroidApps(deviceId, { includeSystem });
    res.json({ ok: true, apps });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e), hint: e.hint ?? null });
  }
});

app.post("/mobile/launch", async (req, res) => {
  const { platform, deviceId, appId } = req.body ?? {};
  if (!appId) return res.status(400).json({ ok: false, error: "appId is required." });
  try {
    const r = platform === "ios"
      ? await launchIosApp(deviceId, appId)
      : await launchAndroidApp(deviceId, appId);
    audit.log("mobile.launch", `${platform} ${appId}`);
    res.json({ ok: true, ...r });
  } catch (e) {
    logs.add({ level: "error", source: "mobile", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e), hint: e.hint ?? null });
  }
});

// ---- Mobile: flow scanning -------------------------------------------------
// A user journey scanned one screen at a time, with cross-step deduplication.
// The tester navigates the app by hand; every "step" is a full single-screen
// scan of whatever is on screen right now.
app.get("/mobile/flow/status", (_req, res) => res.json({ ok: true, ...flowStatus() }));

app.post("/mobile/flow/start", (req, res) => {
  const { platform, deviceId, name } = req.body ?? {};
  if (!["android", "ios"].includes(platform)) {
    return res.status(400).json({ ok: false, error: "platform must be 'android' or 'ios'." });
  }
  try {
    audit.log("mobile.flow.start", `${platform} ${deviceId ?? "default"} "${name ?? ""}"`);
    res.json({ ok: true, ...startFlow({ platform, deviceId, name }) });
  } catch (e) {
    res.status(409).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.post("/mobile/flow/step", async (req, res) => {
  if (mobileScanning) {
    return res.status(409).json({ ok: false, error: "A mobile scan is already running." });
  }
  let ai = null;
  try { ai = resolveAi(req.body?.ai); } catch { /* AI is optional — the measured tier still runs */ }

  mobileScanning = true;
  try {
    const { label, aiReview } = req.body ?? {};
    const r = await flowStep({ ai, aiReview: aiReview !== false, label });
    audit.log("mobile.flow.step", `step ${r.step.index} "${r.step.label}"`);
    res.json({ ok: true, ...r });
  } catch (e) {
    logs.add({ level: "error", source: "mobile", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e), hint: e.hint ?? null });
  } finally {
    mobileScanning = false;
  }
});

app.post("/mobile/flow/stop", (req, res) => {
  try {
    const result = stopFlow();

    // A finished flow is one session — history and comparison work unchanged.
    const scan = {
      url: `${result.platform}-flow://${result.name.replace(/\s+/g, "-").toLowerCase()}`,
      title: `${result.name} — ${result.steps.length} steps`,
      timestamp: result.timestamp,
      score: Math.max(0, 100 - (result.counts.critical * 10 + result.counts.serious * 5 +
                                result.counts.moderate * 2 + result.counts.minor)),
      counts: result.counts,
      violations: [],           // deliberately empty: these are not axe rules
      mobile: result,
    };
    const cfg = securityConfig();
    const id = sessions.save(cfg.masking ? maskScan(scan, { storeScreenshots: cfg.storeScreenshots }) : scan);
    audit.log("mobile.flow.stop", `"${result.name}" ${result.steps.length} steps, ${result.findings.length} unique findings`);
    res.json({ ok: true, result, sessionId: id });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.post("/mobile/flow/cancel", (_req, res) => {
  const r = cancelFlow();
  if (r.name) audit.log("mobile.flow.cancel", r.name);
  res.json({ ok: true, ...r });
});

// ---- Mobile: HTML report ---------------------------------------------------
// Renders a self-contained .html file and writes it next to the web reports.
app.post("/mobile/report/html", (req, res) => {
  const { result, filename } = req.body ?? {};
  if (!result || !Array.isArray(result.findings)) {
    return res.status(400).json({ ok: false, error: "A mobile scan result is required." });
  }
  try {
    const html = renderMobileReportHtml(result);
    const base = (filename || `a11y-mobile-${result.flow ? "flow" : "scan"}-${
      new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`)
      .replace(/[/\\]/g, "_").replace(/\.\./g, "_");
    mkdirSync(EXPORT_DIR, { recursive: true });
    const path = join(EXPORT_DIR, base);
    writeFileSync(path, html, "utf8");
    audit.log("mobile.report", base);
    res.json({ ok: true, path, dir: EXPORT_DIR });
  } catch (e) {
    logs.add({ level: "error", source: "mobile", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

// AI usage & cost report — a separate management-facing document (model,
// context/token consumption, estimated spend). Works for a single scan or a
// finished flow. Only meaningful when an AI review ran, but it renders a clear
// "not run" state rather than erroring so the UI can always offer the button.
app.post("/mobile/report/ai-usage/html", (req, res) => {
  const { result, filename } = req.body ?? {};
  if (!result || typeof result !== "object") {
    return res.status(400).json({ ok: false, error: "A mobile scan result is required." });
  }
  try {
    const html = renderMobileAiUsageReportHtml(result);
    const base = (filename || `a11y-mobile-ai-usage-${result.flow ? "flow" : "scan"}-${
      new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`)
      .replace(/[/\\]/g, "_").replace(/\.\./g, "_");
    mkdirSync(EXPORT_DIR, { recursive: true });
    const path = join(EXPORT_DIR, base);
    writeFileSync(path, html, "utf8");
    audit.log("mobile.report.ai-usage", base);
    res.json({ ok: true, path, dir: EXPORT_DIR });
  } catch (e) {
    logs.add({ level: "error", source: "mobile", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

// ---- Logs ---------------------------------------------------------------
app.get("/logs", (req, res) => {
  res.json({ ok: true, logs: logs.list(Number(req.query.limit) || 200) });
});

app.delete("/logs", (_req, res) => {
  logs.clear();
  audit.log("logs.clear", "");
  res.json({ ok: true });
});

// Lets the UI record client-side failures in the same place, so "check Logs"
// means one place rather than two.
app.post("/logs", (req, res) => {
  const { level, source, message, detail, context } = req.body ?? {};
  const id = logs.add({ level, source: source || "ui", message, detail, context });
  res.json({ ok: !!id, id });
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
  const cfg = securityConfig();
  if (cfg.masking) scan = maskScan(scan, { storeScreenshots: cfg.storeScreenshots });
  audit.log("session.save", scan.url);
  res.json({ ok: true, id: sessions.save(scan) });
});

app.delete("/sessions/:id", (req, res) => {
  audit.log("session.delete", req.params.id);
  res.json({ ok: sessions.remove(+req.params.id) });
});


// ---- Export -------------------------------------------------------------
// Tauri's webview (WebView2 / WKWebView) does NOT honour <a download> on blob
// URLs, so the browser-style download trick silently does nothing in the
// packaged app. The reliable path is: the UI posts the content here, the
// sidecar writes it to disk with Node, and we hand back the absolute path.
const EXPORT_DIR = process.env.A11Y_EXPORT_DIR || join(homedir(), "A11yLens", "reports");

app.post("/export", (req, res) => {
  const { filename, content } = req.body ?? {};
  if (!filename || typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "filename and content are required." });
  }
  // Never let a filename escape the export directory.
  const safe = String(filename).replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  try {
    mkdirSync(EXPORT_DIR, { recursive: true });
    const path = join(EXPORT_DIR, safe);
    writeFileSync(path, content, "utf8");
    audit.log("export", safe);
    res.json({ ok: true, path, dir: EXPORT_DIR });
  } catch (e) {
    logs.add({ level: "error", source: "export", message: String(e.message ?? e), detail: e.stack });
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

// ---- Update an existing session -----------------------------------------
// An AI report or expert audit is attached AFTER the scan is first saved, so
// without this the SQLite row keeps the original scan and every export comes
// out missing the AI sections.
app.put("/sessions/:id", (req, res) => {
  let scan = req.body?.scan;
  if (!scan?.url) return res.status(400).json({ ok: false, error: "Invalid scan payload." });
  const cfg = securityConfig();
  if (cfg.masking) scan = maskScan(scan, { storeScreenshots: cfg.storeScreenshots });
  const ok = sessions.update(+req.params.id, scan);
  if (!ok) return res.status(404).json({ ok: false, error: "Session not found." });
  audit.log("session.update", `${req.params.id} ${scan.url}`);
  res.json({ ok: true, id: +req.params.id });
});

// ---- Phase 11: import (export is a client-side file download) ---------
app.post("/sessions/import", (req, res) => {
  const scan = req.body?.scan;
  if (!scan?.url || !scan?.violations) return res.status(400).json({ ok: false, error: "Not a valid A11y Lens session file." });
  audit.log("session.import", scan.url);
  const cfgImp = securityConfig();
  res.json({ ok: true, id: sessions.save(cfgImp.masking ? maskScan(scan, { storeScreenshots: cfgImp.storeScreenshots }) : scan) });
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
  return { localOnly: false, masking: true, storeScreenshots: false, ...(settings.get("security") ?? {}) };
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

// The cross-check agent. Deliberately a SEPARATE stored config: agreement
// between two models of the same family proves much less than agreement across
// families, so the second model should usually be a different provider.
function resolveAiB(reqAi) {
  const stored = settings.get("aiB");
  const provider = reqAi?.provider || stored?.provider;
  if (!provider) return null;
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

app.get("/settings/ai/crosscheck", (_req, res) => {
  const s = settings.get("aiB") ?? {};
  res.json({ ok: true, provider: s.provider ?? "", model: s.model ?? "", baseUrl: s.baseUrl ?? "", hasKey: !!s.apiKeyEnc });
});

app.post("/settings/ai/crosscheck", (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body ?? {};
  const prev = settings.get("aiB") ?? {};
  settings.set("aiB", {
    provider, model, baseUrl,
    apiKeyEnc: apiKey ? encrypt(apiKey) : prev.apiKeyEnc,
  });
  audit.log("settings.aiB.update", `${provider}/${model}`);
  res.json({ ok: true });
});

app.get("/settings/ai", (_req, res) => {
  const s = settings.get("ai") ?? {};
  res.json({ ok: true, provider: s.provider ?? "", model: s.model ?? "", baseUrl: s.baseUrl ?? "", hasKey: !!s.apiKeyEnc });
});

app.get("/settings/ai/providers", (_req, res) => {
  res.json({ ok: true, defaults: AI_PROVIDER_DEFAULTS });
});

// Test the AI provider config with a minimal real completion call.
// Uses request-supplied values (what's currently typed in the form) merged
// with the stored encrypted key, so users can test before or after saving.
app.post("/settings/ai/test", async (req, res) => {
  const started = Date.now();
  try {
    const ai = resolveAi(req.body ?? {});
    const reply = await aiChat(ai, 'Reply with exactly the word "OK" and nothing else.', 10);
    audit.log("settings.ai.test", `${ai.provider}/${ai.model} ok`);
    res.json({
      ok: true,
      provider: ai.provider,
      model: ai.model,
      baseUrl: ai.baseUrl ?? null,
      latencyMs: Date.now() - started,
      reply: String(reply).slice(0, 80),
    });
  } catch (e) {
    audit.log("settings.ai.test", `failed: ${String(e.message ?? e).slice(0, 120)}`);
    res.status(502).json({ ok: false, error: String(e.message ?? e), latencyMs: Date.now() - started });
  }
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

const server = app.listen(PORT, () => {
  console.log(`[a11y-sidecar] listening on http://localhost:${PORT} (pid ${process.pid})`);
});

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    // The port is taken. Before treating that as a failure, find out BY WHAT.
    //
    // If it's already one of ours and it's healthy, there is nothing wrong: a
    // second instance is simply redundant. Exit cleanly (0) so whatever launched
    // us — `concurrently`, a dev script, a double-click — doesn't tear down the
    // rest of the run over a non-problem.
    //
    // If it's something ELSE holding 8787, that IS a failure, and we say so.
    try {
      const res = await fetch(`http://localhost:${PORT}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const body = await res.json();
      if (body?.app === "a11y-lens-sidecar") {
        console.log(
          `[a11y-sidecar] an A11y Lens sidecar is already running on port ${PORT} ` +
          `(pid ${body.pid}). Reusing it — nothing to do.`
        );
        process.exit(0);
      }
    } catch {
      // No health response — so it isn't us.
    }

    console.error(
      `[a11y-sidecar] port ${PORT} is in use by another program. ` +
      `Stop it, or set A11Y_SIDECAR_PORT to a free port.`
    );
    process.exit(3);
  }
  console.error(`[a11y-sidecar] failed to start: ${err.message}`);
  process.exit(1);
});

// Shut down cleanly when Tauri kills us, so the port is released immediately.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
