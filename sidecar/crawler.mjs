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
import { captureElementScreenshots, captureFullPageAnnotated, installHighlighter } from "./element-shots.mjs";
import { captureKeyboardEvidence } from "./keyboard-evidence.mjs";
import { exploreInteractions } from "./interact.mjs";
import { auditPageAi } from "./ai-audit.mjs";
import { dedupeFindings } from "./ai-dedupe.mjs";
import { smellToFinding } from "./replay.mjs";
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
    // Honest progress: units are PAGES/CHECKPOINTS (the real work unit), not the
    // recorded-row count, which also includes every interaction-revealed state.
    unitsDone: 0,
    unitsTotal: 0,
    stage: "scanning",  // scanning -> deduping -> reporting -> done
    // Where a URL list actually ended up, so the report can distinguish
    // "scanned 37 pages" from "requested 37 and reached 31".
    redirects: { list: [], failed: [], auth: 0, warned: false },
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

  // Paths that mean "you are not logged in", in the languages this tool meets.
  const AUTH_RE = /(^|\/)(login|signin|sign-in|log-in|auth|sso|oauth|account\/login|logon|identity|adfs|saml)(\/|$|\?)/i;

  async function scanPage(page, opts = {}) {
    await page.evaluate(axeSource);
    // Third-party widget DOM (cookie banners, chat, analytics) can be excluded so
    // a scan's SCOPE matches another suite's. Kept opt-in and off by default:
    // silently hiding a cookie banner would understate real barriers, and a
    // consent dialog you cannot dismiss with a keyboard is a genuine defect.
    const exclude = Array.isArray(opts.excludeSelectors) ? opts.excludeSelectors : [];
    const results = await page.evaluate(async (excl) =>
      window.axe.run(excl.length ? { exclude: excl.map((s) => [s]) } : document, {
        runOnly: {
          type: "tag",
          // WCAG 2.1 Level A + AA only — the target standard.
          // "best-practice" is deliberately excluded: those rules are good advice
          // but are NOT WCAG conformance failures, and mixing them in overstates
          // the violation count against WCAG 2.1.
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
        resultTypes: ["violations"],
      }), exclude
    );
    const violations = results.violations.map(v => ({
      id: v.id, impact: v.impact ?? "minor", description: v.description, help: v.help,
      helpUrl: v.helpUrl, wcag: v.tags.filter(t => /^wcag\d/.test(t)),
      nodes: v.nodes.slice(0, 15).map(n => ({
        target: n.target.join(" "), html: n.html, failureSummary: n.failureSummary,
      })),
    }));

    // Visual evidence: ONE full-page screenshot per page, plus each failing
    // element's box (drawn as an overlay in the report). Storing the image once
    // per page keeps a big crawl's payload sane; the boxes are tiny.
    if (opts.elementScreenshots !== false) {
      try {
        const r = await captureFullPageAnnotated(page, violations, { maxPerRule: 3, maxTotal: 30 });
        if (r.pageShot) {
          const shot = { shot: r.pageShot, w: r.pageW, h: r.pageH };
          // Held for the base-page recordScan…
          state.__pendingShot = shot;
          // …and ALSO carried on the returned array, because the interaction pass
          // scans every revealed state BEFORE any of them are recorded. With a
          // single shared slot the first state consumed the last state's image and
          // the rest got none — which is why interaction pages had findings but no
          // screenshots. Non-enumerable so it never lands in the session JSON.
          Object.defineProperty(r.violations, "__shot", { value: shot, enumerable: false });
        }
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
    // Shared across the whole scan: signatures of interactive controls already
    // audited, so site-global chrome (filters, drawers, nav) is scanned once, not
    // once per page. Reset every run because it lives in this closure.
    const scanCache = { interaction: new Set() };
    const urlList = Array.isArray(opts.urlList) ? opts.urlList.filter(u => typeof u === "string" && u.trim()) : null;
    const maxPages = urlList ? Math.min(urlList.length, 100) : Math.min(opts.maxPages ?? 10, 40);

    state.running = true;
    state.startedAt = new Date().toISOString();
    state.pagesScanned = [];
    state.pageShots = {};   // scan-row key -> { shot(base64), w, h } (one full-page shot per row)
    state.unitsDone = 0;
    state.unitsTotal = 0;
    state.redirects = { list: [], failed: [], auth: 0, warned: false };
    state.stage = "scanning";
    state.log = [];
    state.error = null;
    state.result = null;

    function recordScan(url, title, violations, keyboard = null, meta = {}) {
      const u = new URL(url);
      // One screenshot per scan row (page or interaction-revealed state), named by
      // the row so a drawer's state doesn't overwrite the base page's image.
      const shotKey = `${u.pathname}${u.search}||${title || ""}`;
      if (state.__pendingShot) {
        state.pageShots[shotKey] = state.__pendingShot;
        state.__pendingShot = null;
      }
      // Stamp every node with its row + a callout number, so the report can draw
      // numbered red boxes on that row's screenshot.
      let callout = 0;
      const annotated = violations.map((v) => ({
        ...v,
        nodes: (v.nodes ?? []).map((n) => ({
          ...n,
          page: u.pathname,
          shotKey,
          shotTitle: title || u.pathname,
          callout: n.box ? ++callout : undefined,
        })),
      }));
      for (const v of annotated) {
        const cur = merged.get(v.id) ?? { ...v, nodes: [] };
        for (const n of v.nodes)
          cur.nodes.push({ ...n, failureSummary: `[${u.pathname}] ${n.failureSummary ?? ""}` });
        merged.set(v.id, cur);
      }
      violations = annotated;
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
        // What was ASKED for vs what was actually scanned — a redirect makes
        // those two different, and the report must not conflate them.
        requestedUrl: meta.requestedUrl ?? url,
        redirected: !!meta.redirected,
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
            // Scan-wide de-duplication of interactive controls (see scanCache).
            dedupe: {
              seen: (sig) => scanCache.interaction.has(sig),
              add: (sig) => scanCache.interaction.add(sig),
            },
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
          // Restore the screenshot captured while THIS state was open.
          if (sc.shot) state.__pendingShot = sc.shot;
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
      if (opts.navigator) {
        // Recorded-path replay. Instead of page.goto()-ing a list of URLs, we
        // ask the replayer to DRIVE the recorded actions up to each checkpoint,
        // then scan whatever DOM state that produced. This is what makes SPA
        // journeys (open drawer, add to cart) scannable — there is no URL to go
        // to, only a sequence of clicks that reveals the state.
        const total = opts.checkpointCount || 0;
        state.unitsTotal = total;
        log(`Recorded-path replay: ${total} checkpoint${total === 1 ? "" : "s"} to reproduce and scan.`);
        for (let i = 0; i < total; i++) {
          if (!state.running) break;
          let nav;
          try {
            nav = await opts.navigator(i, page);
          } catch (e) {
            log(`Replay stopped at checkpoint ${i + 1}/${total}: ${String(e.message ?? e).slice(0, 160)}`);
            state.error = state.error || `Recorded path broke at checkpoint ${i + 1}: ${String(e.message ?? e).slice(0, 160)}`;
            break;
          }
          if (!nav) break;
          await page.waitForTimeout(400);
          let url = nav.url;
          const title = nav.title || (await page.title().catch(() => ""));
          // SPA checkpoints often share a URL; disambiguate so recordScan does
          // not merge two genuinely different states into one row.
          let pageKey;
          try { const u = new URL(url); pageKey = u.origin + u.pathname + u.search; } catch { pageKey = url; }
          if (visited.has(pageKey)) { url = `${url}#state-${i + 1}`; }
          visited.add(pageKey);

          state.currentUrl = url;
          log(`Scanning checkpoint ${i + 1}/${total}: ${title || pageKey}`);
          const violations = await scanPage(page, { elementScreenshots: opts.elementScreenshots });
          const kb = opts.keyboardEvidence === false ? null : await captureKeyboardEvidence(page).catch(() => null);
          const aiFindings = await runAiAudit(page, url, violations, kb);
          // Any control that could only be reached by XPath during replay is a
          // Name/Role/Value smell — attach it right where it happened.
          const smellFindings = (nav.smells || []).map(smellToFinding);
          for (const sf of smellFindings) log(`⚠ ${sf.evidence} — no accessible/stable selector (WCAG 4.1.2)`);
          recordScan(url, title, [...violations, ...aiFindings, ...smellFindings], kb);
          await runInteractionPass(page, url, title);
          state.unitsDone = i + 1;   // a checkpoint is done only after its states are scanned
        }
      } else if (urlList) {
        state.unitsTotal = Math.min(urlList.length, maxPages);
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
            state.redirects.failed.push({ requested: target.href, reason: String(e).slice(0, 80) });
            continue;
          }
          await page.waitForTimeout(500);

          // Did we actually ARRIVE? A URL list is a list of REQUESTS, not results.
          // An expired session, a permission check or a canonical redirect can land
          // us somewhere else entirely — and scanning that under the requested URL
          // produces a report that looks complete and is quietly wrong.
          const landed = new URL(page.url());
          const sameRoute = landed.origin === target.origin && landed.pathname === target.pathname;
          if (!sameRoute) {
            const landedKey = landed.origin + landed.pathname;
            const authish = AUTH_RE.test(landed.pathname) || AUTH_RE.test(landed.search);
            state.redirects.list.push({ requested: target.href, landed: landed.href, auth: authish });

            if (authish) {
              state.redirects.auth++;
              log(`⚠ ${target.pathname} redirected to a login/auth page (${landed.pathname}) — not scanned.`);
              // Many auth redirects in a row means the session is gone. Continuing
              // would fill the report with copies of the login screen.
              if (state.redirects.auth >= 3 && !state.redirects.warned) {
                state.redirects.warned = true;
                state.error = state.error ||
                  `${state.redirects.auth} URLs redirected to login — the browser session is not authenticated for these pages. Log in again and re-run.`;
                log(`✖ Stopping the URL list: the session does not have access to these pages.`);
                break;
              }
              continue;
            }

            // A non-auth redirect is legitimate (canonical URL, locale, tenant).
            // Scan where we landed, but record it under the URL that was actually
            // scanned and skip it if we have already been there.
            if (visited.has(landedKey)) {
              log(`↪ ${target.pathname} redirects to ${landed.pathname}, already scanned — skipped.`);
              continue;
            }
            visited.add(landedKey);
            log(`↪ ${target.pathname} redirected to ${landed.pathname} — scanning the destination.`);
          }

          const scannedUrl = sameRoute ? target.href : page.url();
          const title = await page.title().catch(() => "");
          log(`Scanning: ${title || pageKey}`);
          const violations = await scanPage(page, {
            elementScreenshots: opts.elementScreenshots,
            excludeSelectors: opts.excludeSelectors,
          });
          const kb = opts.keyboardEvidence === false
            ? null
            : await captureKeyboardEvidence(page).catch(() => null);
          const aiFindings = await runAiAudit(page, scannedUrl, violations, kb);
          recordScan(scannedUrl, title, [...violations, ...aiFindings], kb, {
            requestedUrl: target.href, redirected: !sameRoute,
          });
          await runInteractionPass(page, scannedUrl, title);
          state.unitsDone++;
        }
      } else {
        state.unitsTotal = maxPages;
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
            state.unitsDone++;
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
        pageShots: state.pageShots,   // pathname+search -> { shot, w, h }
        // What a URL list actually reached. Without this a report saying
        // "31 pages" hides that 6 were requested and never scanned.
        redirects: state.redirects,
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
          state.stage = "deduping";
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
          provider: state.aiProviderModel.model.startsWith(`${state.aiProviderModel.provider}/`)
            ? state.aiProviderModel.model                      // model already namespaced (e.g. "nvidia/nemotron-…")
            : `${state.aiProviderModel.provider}/${state.aiProviderModel.model}`,
          findingsRaw: aiFindings.length,
          groups: aiGroups,
          groupCount: aiGroups ? aiGroups.length : null,
        };
        state.result.usage = state.aiUsage;
        state.result.cost = cost;
        // Reconcile requested vs reached BEFORE the totals, so nobody reads
        // "31 pages scanned" as "all 37 URLs were covered".
        const rd = state.redirects;
        if (rd && (rd.list.length || rd.failed.length)) {
          const reached = state.pagesScanned.filter((p) => !/— Interaction:/.test(p.title || "")).length;
          log(`URL list: ${state.unitsTotal} requested · ${reached} scanned · ${rd.list.length} redirected · ${rd.failed.length} unreachable.`);
          if (rd.auth) log(`  ${rd.auth} redirected to login — those pages were NOT scanned.`);
          for (const r of rd.list.slice(0, 8)) {
            try {
              log(`  ↪ ${new URL(r.requested).pathname} → ${new URL(r.landed).pathname}${r.auth ? "  (auth)" : ""}`);
            } catch { /* ignore */ }
          }
        }
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
      state.stage = "done";
    }
  }

  return {
    state,
    start: (page, opts) => { if (!state.running) run(page, opts); },
    stop: () => { state.running = false; },
  };
}
