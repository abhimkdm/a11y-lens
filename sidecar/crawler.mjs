// A11y Lens crawler — AI autonomous exploration engine (Phase 6).
//
// Two modes:
//   1. AI-driven: observe page -> collect candidate actions -> safety filter ->
//      AI (or heuristic) picks next action -> Playwright executes -> axe scan -> repeat.
//   2. Custom URL list: user supplies an ordered list of URLs (e.g. from a
//      sitemap or a JSON upload); each is visited and scanned in sequence,
//      no AI action-picking involved. Still origin-locked for safety.
//
// Hard safety rules (never overridden, not even by the AI):
//   - never leave the origin the crawl started on
//   - never click anything whose text/attributes match the DENY list
//   - navigation-only: links, menus, tabs, read-only pages
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { aiChat } from "./ai.mjs";
import { captureElementScreenshots, installHighlighter } from "./element-shots.mjs";
import { captureKeyboardEvidence } from "./keyboard-evidence.mjs";
import { exploreInteractions } from "./interact.mjs";
import { auditPageAi } from "./ai-audit.mjs";
import { dedupeFindings } from "./ai-dedupe.mjs";
import { estimateCost } from "./cost.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const DENY = /\b(delete|remove|destroy|submit|save|send|pay|payment|purchase|buy|checkout|order|approve|reject|deny|confirm|cancel|logout|log out|sign out|signout|deactivate|unsubscribe|transfer|withdraw)\b/i;

export function createCrawler() {
  const state = {
    running: false,
    startedAt: null,
    pagesScanned: [],   // { url, title, score, counts, violationRuleCount }
    currentUrl: null,
    log: [],
    error: null,
    result: null,       // aggregate ScanResult when done
    aiUsage: { inputTokens: 0, outputTokens: 0 },  // AI Full Scan token total
    aiProviderModel: null,
    aiAuditPages: 0,
    aiAuditStates: 0,   // interaction-revealed states (modals/drawers/validation) the AI audited
  };

  function log(msg) {
    state.log.push({ t: new Date().toISOString(), msg });
    if (state.log.length > 200) state.log.shift();
  }

  async function observe(page) {
    return page.evaluate(() => {
      const acts = [];
      const seen = new Set();
      const els = document.querySelectorAll(
        'a[href], [role="tab"], [role="menuitem"], nav button, [role="link"]'
      );
      for (const el of els) {
        const text = (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 80);
        const href = el.getAttribute("href") || "";
        const key = text + "|" + href;
        if (!text || seen.has(key)) continue;
        seen.add(key);
        const r = el.getBoundingClientRect();
        acts.push({
          text, href,
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          visible: r.width > 0 && r.height > 0,
        });
      }
      return acts.filter(a => a.visible).slice(0, 60);
    });
  }

  function safe(action, origin, visited) {
    if (DENY.test(action.text)) return false;
    if (action.href) {
      if (/^(mailto:|tel:|javascript:|#$)/i.test(action.href)) return false;
      try {
        const u = new URL(action.href, origin);
        if (u.origin !== origin) return false;              // stay on-origin
        if (visited.has(u.origin + u.pathname)) return false;
      } catch { return false; }
    }
    return true;
  }

  // Provider-agnostic "pick the next action" call. Falls back to the first
  // candidate if no AI is configured or the call fails.
  async function aiPick(ai, pageInfo, candidates) {
    if (!ai?.provider || !candidates.length) return 0;
    const prompt =
      `You are exploring a web app to audit accessibility. Current page: "${pageInfo.title}" (${pageInfo.url}).\n` +
      `Pick the ONE most valuable unexplored navigation action from this JSON list (prefer main sections over footer/legal links). ` +
      `Reply with ONLY the index number.\n${JSON.stringify(candidates.map((c, i) => ({ i, text: c.text, href: c.href })))}`;
    try {
      const text = await aiChat(ai, prompt, 10);
      const idx = parseInt(String(text).match(/\d+/)?.[0] ?? "0", 10);
      return idx >= 0 && idx < candidates.length ? idx : 0;
    } catch (e) {
      log(`AI pick failed (${e}); using heuristic.`);
      return 0;
    }
  }

  async function scanPage(page, opts = {}) {
    await page.evaluate(axeSource);
    const results = await page.evaluate(async () =>
      window.axe.run(document, {
        runOnly: {
          type: "tag",
          // WCAG 2.1 Level A + AA only — the target standard.
          // "best-practice" is deliberately excluded: those rules are good advice
          // but are NOT WCAG conformance failures, and mixing them in overstates
          // the violation count against WCAG 2.1.
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
        resultTypes: ["violations"],
      })
    );
    const violations = results.violations.map(v => ({
      id: v.id, impact: v.impact ?? "minor", description: v.description, help: v.help,
      helpUrl: v.helpUrl, wcag: v.tags.filter(t => /^wcag\d/.test(t)),
      nodes: v.nodes.slice(0, 15).map(n => ({
        target: n.target.join(" "), html: n.html, failureSummary: n.failureSummary,
      })),
    }));

    // Visual evidence per element. Capped harder than a quick scan — a 10-page
    // crawl at 40 shots/page would be both slow and enormous.
    if (opts.elementScreenshots !== false) {
      try {
        await installHighlighter(page);
        const r = await captureElementScreenshots(page, violations, { maxPerRule: 2, maxTotal: 10 });
        return r.violations;
      } catch {
        return violations;   // never lose a page's findings over a screenshot
      }
    }
    return violations;
  }

  async function run(page, opts) {
    const ai = opts.ai;
    const origin = new URL(page.url()).origin;
    const visited = new Set();
    const merged = new Map(); // ruleId -> violation with nodes annotated by page
    const urlList = Array.isArray(opts.urlList) ? opts.urlList.filter(u => typeof u === "string" && u.trim()) : null;
    const maxPages = urlList ? Math.min(urlList.length, 100) : Math.min(opts.maxPages ?? 10, 40);

    state.running = true;
    state.startedAt = new Date().toISOString();
    state.pagesScanned = [];
    state.log = [];
    state.error = null;
    state.result = null;

    function recordScan(url, title, violations, keyboard = null) {
      const u = new URL(url);
      for (const v of violations) {
        const cur = merged.get(v.id) ?? { ...v, nodes: [] };
        for (const n of v.nodes)
          cur.nodes.push({ ...n, page: u.pathname, failureSummary: `[${u.pathname}] ${n.failureSummary ?? ""}` });
        merged.set(v.id, cur);
      }
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of violations) counts[v.impact] += v.nodes.length;
      const w = { critical: 10, serious: 5, moderate: 2, minor: 1 };
      const penalty = violations.reduce((s, v) => s + w[v.impact] * Math.min(v.nodes.length, 10), 0);
      state.pagesScanned.push({
        url, title, score: Math.max(0, 100 - penalty),
        counts, violationRuleCount: violations.length,
        // Keep the per-page findings. Merging everything into one flat list
        // destroys the information the site report needs: whether a rule fails on
        // ONE page (page-specific) or on EVERY page (site-wide chrome). Without
        // this, a 20-page scan reports the same footer issue 20 times.
        violations,
        // Keyboard/focus evidence is per-page too: focus order on checkout is a
        // different thing from focus order on the front page.
        keyboard,
      });
    }

    // Run the interaction pass for the page currently loaded, recording each
    // revealed state (open modal, expanded dropdown, validation error, etc.) as
    // its own scenario via the SAME recordScan path — so interaction states flow
    // into the site report, the AI report, and the AI cost report unchanged.
    // deps inject the crawler's own axe run and keyboard capture so there's no
    // second copy of that config to drift, and no circular import.
    async function runInteractionPass(page, baseUrl, baseTitle) {
      if (!opts.interact) return;
      try {
        const { scenarios, valueLog } = await exploreInteractions(
          page,
          {
            allowMutations: !!opts.allowMutations,
            valueProfile: opts.valueProfile ?? null,
            maxInteractions: opts.maxInteractions ?? 12,
            keyboardEvidence: opts.keyboardEvidence !== false,
          },
          {
            scanPage: (p) => scanPage(p, { elementScreenshots: opts.elementScreenshots }),
            captureKeyboard: (p) => captureKeyboardEvidence(p),
            log,
            // Only present when AI Full Scan is on: runs the manual-reviewer AI
            // audit on the revealed state (open modal, drawer, menu, validation
            // errors) while it is live, so focus-trap / aria-modal / announcement
            // findings — which a closed-page snapshot can never surface — are
            // caught. Findings carry source:"ai-audit" so they flow into the
            // per-page record, cross-page dedupe, and cost report unchanged.
            auditState: (opts.aiAudit && ai?.provider)
              ? async (p, { url, label, trigger, kind, suppressRuleIds, keyboard }) => {
                  try {
                    state.aiProviderModel = { provider: ai.provider, model: ai.model };
                    log(`AI audit (state): ${label} …`);
                    const r = await auditPageAi(p, ai, {
                      url,
                      chromeOnly: false,
                      suppressRuleIds: suppressRuleIds ?? [],
                      keyboard: keyboard ?? null,
                      stateContext: { trigger, kind },
                    });
                    state.aiUsage.inputTokens += r.usage?.inputTokens ?? 0;
                    state.aiUsage.outputTokens += r.usage?.outputTokens ?? 0;
                    state.aiAuditStates++;
                    for (const w of r.warnings ?? []) log(w);
                    log(`AI audit (state): ${label} — ${r.findings.length} finding(s)`);
                    return r.findings;
                  } catch (e) {
                    log(`AI audit (state) failed on ${label}: ${String(e).slice(0, 120)}`);
                    return [];
                  }
                }
              : null,
          }
        );
        for (const sc of scenarios) {
          // Each interaction state is recorded under a synthetic URL so it reads
          // as a distinct scenario in the report while still tracing back to the
          // page it came from.
          const label = `${baseTitle || baseUrl} — ${sc.label}`;
          recordScan(`${baseUrl}#${encodeURIComponent(sc.label)}`, label, sc.violations, sc.keyboard);
        }
        if (valueLog && valueLog.length) {
          state.interactionValueLog = (state.interactionValueLog ?? []).concat(
            valueLog.map((v) => ({ ...v, page: baseUrl }))
          );
        }
      } catch (e) {
        log(`Interaction pass failed on ${baseUrl}: ${String(e).slice(0, 120)}`);
      }
    }

    // AI Full Scan: after a page's axe scan, run the manual-reviewer AI audit and
    // merge its findings into the SAME page record (so the site report, AI report,
    // and cost report all include them). axe's rule ids for the page are passed as
    // a suppression list so the AI focuses only on what scanners miss. Returns the
    // AI findings so the caller records them under the page.
    async function runAiAudit(page, baseUrl, axeViolations, keyboard) {
      if (!opts.aiAudit || !ai?.provider) return [];
      try {
        state.aiProviderModel = { provider: ai.provider, model: ai.model };
        const suppress = (axeViolations ?? []).map((v) => v.id);
        log(`AI audit: ${baseUrl} …`);
        const r = await auditPageAi(page, ai, {
          url: baseUrl,
          chromeOnly: false,
          suppressRuleIds: suppress,
          keyboard,          // feed the Tab trace + focus-visible probe into the audit
        });
        state.aiUsage.inputTokens += r.usage?.inputTokens ?? 0;
        state.aiUsage.outputTokens += r.usage?.outputTokens ?? 0;
        state.aiAuditPages++;
        for (const w of r.warnings ?? []) log(w);
        log(`AI audit: ${baseUrl} — ${r.findings.length} finding(s), ${r.passes.length} pass(es)`);
        return r.findings;
      } catch (e) {
        log(`AI audit failed on ${baseUrl}: ${String(e).slice(0, 120)}`);
        return [];
      }
    }

    try {
      if (urlList) {
        log(`Custom URL list scan started at ${origin} (${urlList.length} URL${urlList.length === 1 ? "" : "s"} provided).`);
        for (const raw of urlList) {
          if (!state.running) break;
          const trimmed = raw.trim();
          const looksAbsolute = /^https?:\/\//i.test(trimmed);
          const looksPath = trimmed.startsWith("/");
          if (!looksAbsolute && !looksPath) {
            log(`Skipping invalid entry (must be an absolute http(s) URL or start with "/"): "${trimmed}"`);
            continue;
          }
          let target;
          try { target = new URL(trimmed, origin); } catch { log(`Skipping invalid URL: "${trimmed}"`); continue; }
          if (!/^https?:$/.test(target.protocol)) { log(`Skipping non-http(s) URL: "${trimmed}"`); continue; }
          if (target.origin !== origin) { log(`Skipping off-origin URL (safety — must match ${origin}): ${trimmed}`); continue; }
          const pageKey = target.origin + target.pathname;
          if (visited.has(pageKey)) { log(`Skipping duplicate: ${trimmed}`); continue; }
          visited.add(pageKey);

          state.currentUrl = target.href;
          try {
            await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 20000 });
          } catch (e) {
            log(`Navigation failed for ${trimmed}: ${String(e).slice(0, 100)}`);
            continue;
          }
          await page.waitForTimeout(500);
          const title = await page.title().catch(() => "");
          log(`Scanning: ${title || pageKey}`);
          const violations = await scanPage(page, { elementScreenshots: opts.elementScreenshots });
          const kb = opts.keyboardEvidence === false
            ? null
            : await captureKeyboardEvidence(page).catch(() => null);
          const aiFindings = await runAiAudit(page, target.href, violations, kb);
          recordScan(target.href, title, [...violations, ...aiFindings], kb);
          await runInteractionPass(page, target.href, title);
        }
      } else {
        log(`Crawl started at ${origin} (max ${maxPages} pages).`);
        while (state.pagesScanned.length < maxPages && state.running) {
          const url = new URL(page.url());
          const pageKey = url.origin + url.pathname;
          state.currentUrl = page.url();

          if (!visited.has(pageKey)) {
            visited.add(pageKey);
            const title = await page.title().catch(() => "");
            log(`Scanning: ${title || pageKey}`);
            const violations = await scanPage(page, { elementScreenshots: opts.elementScreenshots });
            const kb = opts.keyboardEvidence === false
              ? null
              : await captureKeyboardEvidence(page).catch(() => null);
            const aiFindings = await runAiAudit(page, page.url(), violations, kb);
            recordScan(page.url(), title, [...violations, ...aiFindings], kb);
            await runInteractionPass(page, page.url(), title);
          }

          if (state.pagesScanned.length >= maxPages) break;

          const actions = await observe(page);
          const candidates = actions.filter(a => safe(a, origin, visited)).slice(0, 20);
          if (!candidates.length) { log("No safe unexplored actions left. Stopping."); break; }

          const pick = candidates[await aiPick(ai, { url: page.url(), title: await page.title().catch(() => "") }, candidates)];
          log(`Next: "${pick.text}"`);
          try {
            if (pick.href) {
              await page.goto(new URL(pick.href, origin).href, { waitUntil: "domcontentloaded", timeout: 20000 });
            } else {
              await page.getByText(pick.text, { exact: false }).first().click({ timeout: 8000 });
              await page.waitForLoadState("domcontentloaded").catch(() => {});
            }
            await page.waitForTimeout(700);
            if (new URL(page.url()).origin !== origin) {          // belt-and-braces
              log("Left origin unexpectedly — going back.");
              await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
            }
          } catch (e) {
            log(`Action failed (${String(e).slice(0, 100)}); continuing.`);
          }
        }
      }

      // Aggregate result in the same shape as a quick scan
      const violations = [...merged.values()];
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of violations) counts[v.impact] += v.nodes.length;
      const avg = state.pagesScanned.length
        ? Math.round(state.pagesScanned.reduce((s, p) => s + p.score, 0) / state.pagesScanned.length)
        : 100;
      state.result = {
        url: origin, title: `Full scan · ${state.pagesScanned.length} pages`,
        timestamp: new Date().toISOString(), score: avg, counts, violations,
        pages: state.pagesScanned,
      };
      // When AI Full Scan ran, attach the token usage + priced cost across every
      // page it audited, so the AI cost report can bill the whole crawl as one job.
      if (opts.aiAudit && state.aiProviderModel) {
        // Semantic dedupe: the same header/nav issue reported on 20 pages becomes
        // ONE group, so the report is readable. Collect every ai-audit finding
        // across pages first.
        const aiFindings = [];
        for (const v of merged.values()) {
          if (v.source === "ai-audit") aiFindings.push(v);
        }
        let aiGroups = null, dedupeUsage = { inputTokens: 0, outputTokens: 0 };
        if (aiFindings.length) {
          try {
            log(`AI audit: deduplicating ${aiFindings.length} findings across pages …`);
            const d = await dedupeFindings(aiFindings, ai);
            aiGroups = d.groups;
            dedupeUsage = d.usage;
            state.aiUsage.inputTokens += dedupeUsage.inputTokens;
            state.aiUsage.outputTokens += dedupeUsage.outputTokens;
            log(`AI audit: ${aiFindings.length} findings → ${aiGroups.length} unique after dedupe.`);
          } catch (e) {
            log(`AI dedupe failed: ${String(e).slice(0, 100)}`);
          }
        }

        const cost = estimateCost({
          provider: state.aiProviderModel.provider,
          model: state.aiProviderModel.model,
          inputTokens: state.aiUsage.inputTokens,
          outputTokens: state.aiUsage.outputTokens,
        });
        state.result.aiAudit = {
          pagesAudited: state.aiAuditPages,
          statesAudited: state.aiAuditStates,
          provider: `${state.aiProviderModel.provider}/${state.aiProviderModel.model}`,
          findingsRaw: aiFindings.length,
          groups: aiGroups,
          groupCount: aiGroups ? aiGroups.length : null,
        };
        state.result.usage = state.aiUsage;
        state.result.cost = cost;
        const stateNote = state.aiAuditStates ? ` + ${state.aiAuditStates} revealed state(s)` : "";
        log(`AI audit: ${state.aiAuditPages} pages${stateNote}, ${state.aiUsage.inputTokens + state.aiUsage.outputTokens} tokens, ${cost.usd === null ? "unpriced" : "$" + (cost.usd ?? 0).toFixed(4)}.`);
      }
      log(`Done. ${state.pagesScanned.length} pages, ${violations.length} failing rules, average score ${avg}.`);
    } catch (e) {
      state.error = String(e);
      log(`Crawl error: ${state.error}`);
    } finally {
      state.running = false;
      state.currentUrl = null;
    }
  }

  return {
    state,
    start: (page, opts) => { if (!state.running) run(page, opts); },
    stop: () => { state.running = false; },
  };
}
