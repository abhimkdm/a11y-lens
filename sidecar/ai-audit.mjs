// A11y Lens — AI Full Scan (per-page manual-reviewer audit).
//
// WHAT THIS IS
// The normal Full Scan runs axe-core per page — deterministic, catches syntax
// violations (missing alt, contrast, empty buttons, invalid ARIA). AI Full Scan
// adds a second pass per page that does what a human accessibility expert does
// AFTER the scanners: it hunts for the things scanners provably cannot evaluate
// — whether names are MEANINGFUL not just present, focus management, keyboard
// operation of custom widgets, state exposure, visual-vs-programmatic mismatch,
// label-in-name. This is the high-value layer for EAA compliance work.
//
// The prompt below is adapted from the "one-shot manual audit" approach: tell
// the model exactly what scanners already catch (so it never duplicates them),
// give it six review perspectives to walk through, demand concrete code-level
// fixes, and enforce strict WCAG discipline. axe's findings for the page are
// passed in as a suppression list so the AI focuses only on the gaps.
//
// EVIDENCE
// Per page we send: a full-page screenshot (ground truth for what users see),
// a sanitized DOM (scripts/styles stripped, ARIA/roles/classes/text intact),
// and the ARIA accessibility tree (ground truth for programmatic state). When
// the screenshot and the tree disagree, that disagreement is often the finding.

import { aiStructured } from "./ai.mjs";
import { estimateCost } from "./cost.mjs";

const BASE_PROMPT = `You are a senior accessibility specialist conducting a manual audit of one page. You are the human expert reviewer who comes AFTER the automated scanners. Treat the work that way: axe/IBM/pa11y already caught the syntax violations — missing attributes, invalid combinations, contrast on static text. Everything else is yours, and the everything else is most of what actually determines whether a person with a disability can use this page.

WHAT SCANNERS RELIABLY CATCH (DO NOT REPORT)
- Missing alt on <img>
- Computed color contrast below threshold on static text
- Empty buttons, empty links, inputs with no programmatic label
- Invalid ARIA attribute values or role/state combinations
- Missing lang, duplicate IDs, tabindex > 0
- Missing top-level landmarks (no <main>, etc.)
- Static heading hierarchy gaps
- label-for / id mismatches on native form controls
If a scanner would have flagged it, do not report it. A suppression list of rule IDs already found on this page is provided — never re-report those.

WHAT SCANNERS CANNOT EVALUATE (THIS IS YOUR WORK)
- Whether labels and accessible names are MEANINGFUL in context, or just present
- Tab order: logical sequence, gaps, traps, focus on invisible/offscreen elements
- Focus management around dynamic content: modals, drawers, menus, toasts
- Keyboard operation of custom widgets — arrow keys, Escape, Home/End, roving tabindex
- State exposure: aria-expanded on disclosures, aria-selected on tabs, aria-checked on toggles, aria-busy during loading, aria-current for the active item
- Live regions: are dynamic updates announced, with the right politeness
- Visual structure vs programmatic structure: a heading-styled <p>, a button-styled <div>, a radio-like choice without role="radiogroup"
- Modal-style overlays without role="dialog" / aria-modal / focus containment
- Repeated link or button text without a programmatic disambiguator
- Information conveyed only by color, position, or icon shape
- Form usability: error messages near the field, recoverable errors, redundant entry, autocomplete tokens, instruction placement
- Label-in-name mismatch (visible label != accessible name) — breaks voice control
- Reading order vs visual order in flex/grid/absolute layouts
- Touch target size and spacing (2.5.8 AA minimum is 24x24 CSS px — do NOT cite 44x44 for AA; 44x44 is 2.5.5 AAA, out of scope)
- Motion, autoplay, time limits, content that changes on focus or input without warning
- Plain-language clarity, jargon, instructions that assume knowledge
- Page-level identity: is the <title> meaningful, does the <h1> describe this state

REVIEW PERSPECTIVES — apply EACH across the whole page. Findings emerge when you switch perspectives.
- Keyboard-only user: trace Tab order; is it logical, does it match visual order, does it reach every control, does it land on hidden elements, does it trap? Do custom widgets support expected keys?
- Screen-reader user: read the accessibility tree top to bottom. Does each name make sense without seeing the page? "Læs mere", "Click here", icon-only buttons are useless alone. Are repeated controls distinguishable by name? Are states (selected, expanded, busy, invalid, current) reflected?
- Low-vision / zoom user: is meaning conveyed only by color? Are targets reasonably sized/spaced? Does absolute positioning break at zoom or narrow width?
- Cognitive / learning: plain language? Specific recoverable errors, not "Invalid input"? Required fields clear before submit? Jargon avoided? Critical actions protected? Time pressure or unannounced movement?
- Voice-control / switch: label-in-name — if the visible label is "Se produkt" but the accessible name is "Details", voice activation fails. Are similar controls disambiguated by unique speakable names?
- Visual-vs-programmatic: when the screenshot shows a heading/group/state/hierarchy, verify the markup carries it. A bold label that anchors a section but is not a heading. A grouped set of radios that is not a fieldset. A chevron implying a disclosure with no aria-expanded. A modal-styled overlay that is not a dialog.

EVIDENCE — two kinds are valid, both real findings.
- Presence: a verbatim string from the DOM, accessibility tree, or screenshot text that shows the problem directly.
- Absence: required markup is verifiably missing — quote the surrounding element to make the gap concrete (e.g. quote a disclosure-styled <button> and note "no aria-expanded attribute").
Screenshot is ground truth for what users see; DOM and accessibility tree are ground truth for programmatic state. When they disagree, that disagreement is often the finding.

KEYBOARD NAVIGATION TRACE
When a Tab-order trace is provided, review EVERY step — including steps outside the visible viewport. It is direct, citable evidence for focus order (does Tab order match reading order), focus traps, and focus landing on invisible/0x0/offscreen elements. Do not treat "focus lands on control" as proof a visible focus indicator exists.

DETERMINISTIC PROBE RESULTS (ALREADY MEASURED — DO NOT RE-REPORT)
When focus-visible (WCAG 2.4.7) or reflow (1.4.10) probe results are provided, those controls were measured in code and are reported separately. Do NOT re-report a control the probe already flagged as MISSING, and do not claim keyboard focus "works" on a control the probe marked missing. A distinct additional issue on the same control is fine.

OUTPUT — aim for 6–16 findings on a substantive page. Do not under-report; meaningful-name quality, missing state attributes, visual-vs-programmatic mismatch, error recovery, and keyboard operation are real findings, not speculation. Be discerning only about purely cosmetic concerns. Also list up to 3 honest PASSES — things that genuinely work — or none if nothing real passes.

SEVERITY
- critical: blocks task completion for a keyboard or screen-reader user, or causes severe disorientation.
- serious: major friction; AT users likely to fail or give up.
- moderate: workaround exists but the experience is degraded.
- minor: cosmetic or edge case.

WCAG — cite the MOST SPECIFIC criterion. Use AA criteria scanners cannot evaluate: 1.3.1, 1.3.2, 1.4.1, 1.4.10, 1.4.11, 1.4.13, 2.1.1, 2.1.2, 2.4.3, 2.4.4, 2.4.6, 2.4.7, 2.5.3, 2.5.8, 3.2.1, 3.2.2, 3.2.4, 3.3.1, 3.3.3, 3.3.4, 4.1.2, 4.1.3. Do not default everything to Level A.

HARD RULES
- LANGUAGE: write title, description, userImpact, and fix in English even when the page is in another language. The evidence field is the only place verbatim foreign-language quotes belong.
- Evidence must be a real string from the inputs. No paraphrasing, no invented quotes.
- Do not re-report anything on the scanner suppression list.
- Be specific. "Improve labels" is useless — cite the element and the actual problem.
- The fix field is read by a developer who implements it. Write a concrete code-level instruction, not a WCAG paraphrase. Bad: "Provide an accessible name." Good: "Add aria-label=\\"Close dialog\\" to the <button class=\\"close\\">, or wrap the SVG in <span class=\\"sr-only\\">Close dialog</span>."
- Output STRICT JSON, exactly this shape and nothing else — a top-level "findings" array of flat objects, plus a "passes" array:
  { "findings": [ { "severity": "critical|serious|moderate|minor", "wcag": "2.4.3", "description": "...", "evidence": "...", "recommendation": "...", "codeExample": "...", "selector": "..." } ], "passes": [ { "message": "..." } ] }
  FIELD RULES:
  - severity: one of critical | serious | moderate | minor.
  - wcag: the single MOST specific criterion number as a string (e.g. "4.1.2"). Not a level, not an array.
  - description: what is wrong and who it affects, in English, specific to the cited element.
  - evidence: a REAL verbatim string from the DOM, accessibility tree, screenshot text, or keyboard trace. No paraphrasing, no invented quotes. This is the only field where foreign-language quotes belong.
  - recommendation: plain-language what to change.
  - codeExample: a concrete code snippet a developer can paste or adapt. Not a WCAG paraphrase. Bad: "Provide an accessible name." Good: \`<button class="close" aria-label="Close dialog">…</button>\`.
  - selector: a CSS selector that uniquely matches the ONE failing element in the DOM above, so the report can outline it on a screenshot. Copy real attributes from the DOM you were given — id, name, class, type, aria-label, data-* — e.g. \`input[name="hasLimits"][value="NO_LIMIT"]\`, \`#search\`, \`button.close[aria-label="Luk"]\`. Prefer the most specific selector that still matches. NEVER return a URL, a page path, an XPath, or a guess at a class that does not appear in the DOM above. If you truly cannot identify the element, return "".
  Only report issues with STRONG evidence. No prose outside the JSON.`;

const SKIP_CHROME = `

SCOPE — IGNORE SITE CHROME: do NOT audit the top navigation/header, footer, cookie consent banner, chat/support widget, or skip links. Those are audited once on a dedicated chrome pass; reporting them here only creates duplicates across every page. Focus EXCLUSIVELY on the page's main content: hero, product details, drawers, panels, forms, tabs, listings, error states, page-specific dialogs.`;

const CHROME_ONLY = `

CHROME-ONLY MODE — audit ONLY the site-wide chrome visible on this page: top navigation/header, footer, cookie consent banner, chat/support widget, skip links, and page-level landmark structure. IGNORE the main content area entirely. This is the one dedicated chrome pass, so be thorough on what you can see.`;

export function buildAuditPrompt({ chromeOnly = false } = {}) {
  return BASE_PROMPT + (chromeOnly ? CHROME_ONLY : SKIP_CHROME);
}

// JSON schema handed to aiStructured (mirrors the flat output contract above).
const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "serious", "moderate", "minor"] },
          wcag: { type: "string" },
          description: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
          codeExample: { type: "string" },
          selector: { type: "string" },
        },
        required: ["severity", "wcag", "description", "evidence", "recommendation", "selector"],
      },
    },
    passes: {
      type: "array",
      items: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  },
  required: ["findings", "passes"],
};

// Read a sanitized DOM + ARIA tree from the live page. Runs in-page: strips
// scripts/styles/svg-guts, keeps structure + ARIA + text, and truncates to a
// budget so a huge SPA doesn't blow the context window.
function collectDomAndTree() {
  const clone = document.body.cloneNode(true);
  for (const el of clone.querySelectorAll("script, style, noscript, svg > *, path, iframe")) el.remove();
  // Drop inline styles/data-* noise but keep aria-*, role, class, id, name, type, alt, title, href, label.
  const KEEP = /^(aria-|role$|class$|id$|name$|type$|alt$|title$|href$|for$|label$|placeholder$|value$|tabindex$|hidden$|disabled$|checked$|selected$|expanded$|contenteditable$)/i;
  for (const el of clone.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!KEEP.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  let html = clone.innerHTML.replace(/\s+/g, " ").replace(/> </g, "><").trim();
  const MAX = 42000;
  const truncated = html.length > MAX;
  if (truncated) html = html.slice(0, MAX);
  return { html, truncated, title: document.title || "", h1: (document.querySelector("h1")?.textContent || "").trim().slice(0, 200) };
}

export async function auditPageAi(page, ai, {
  url,
  chromeOnly = false,
  suppressRuleIds = [],
  keyboard = null,          // captureKeyboardEvidence() result: { walk, focusProbe, findings, stats }
  maxTokens = 6000,
  stateContext = null,      // { trigger, kind } when auditing an interaction-revealed state (modal/drawer/menu/validation)
} = {}) {
  // --- capture evidence -----------------------------------------------------
  let screenshot = null;
  try {
    const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 70 });
    screenshot = buf.toString("base64");
  } catch { /* proceed text-only if the screenshot fails */ }

  let dom = { html: "(unavailable)", truncated: false, title: "", h1: "" };
  try { dom = await page.evaluate(collectDomAndTree); } catch { /* keep default */ }

  let ariaTree = "(unavailable)";
  try {
    // Modern Playwright: ARIA snapshot as YAML. Fall back to accessibility.snapshot.
    ariaTree = await page.locator("body").ariaSnapshot();
  } catch {
    try {
      const snap = await page.accessibility.snapshot();
      ariaTree = snap ? JSON.stringify(snap).slice(0, 30000) : "(unavailable)";
    } catch { /* keep unavailable */ }
  }
  if (typeof ariaTree === "string" && ariaTree.length > 30000) ariaTree = ariaTree.slice(0, 30000);

  const suppression = suppressRuleIds.length
    ? `\n\nSCANNER SUPPRESSION LIST (already found by axe on this page — do NOT re-report):\n${[...new Set(suppressRuleIds)].join(", ")}`
    : "\n\nSCANNER SUPPRESSION LIST: (none provided)";

  // Keyboard trace + deterministic focus-visible probe (already measured in code).
  const keyboardBlock = formatKeyboardEvidence(keyboard);

  // When auditing an interaction-revealed state, tell the model exactly that —
  // otherwise it audits the whole page (including the inert content behind an
  // open modal) and floods the report with base-page duplicates. The base page
  // is audited separately, so here we point the model at the newly revealed UI.
  const stateBlock = stateContext
    ? [
        "## INTERACTION-REVEALED STATE",
        `This is NOT the initial page load. It is the state that appeared after activating "${stateContext.trigger}"${stateContext.kind ? ` (${stateContext.kind})` : ""}.`,
        "Concentrate ONLY on the newly revealed UI and its interaction semantics:",
        "- Dialog/drawer: did focus move in, is it trapped, aria-modal, role, Escape-to-close, focus return on close.",
        "- Menu/listbox/combobox: option roles, selection/active-descendant announcement, keyboard operability.",
        "- Expander/accordion/tab: aria-expanded / aria-selected correctness against the visible state.",
        "- Validation: is each error announced (live region / role=alert), associated (aria-describedby), and is focus sent to the first error.",
        "Do NOT report issues that belong to the base page behind this state — those are audited separately and would be duplicates.",
        "",
      ].join("\n")
    : "";

  const userText = [
    `PAGE: ${url}`,
    `DOCUMENT TITLE: ${dom.title || "(empty)"}`,
    `H1: ${dom.h1 || "(none)"}`,
    "",
    stateBlock,
    "## Accessibility tree (ARIA snapshot)",
    "```",
    ariaTree,
    "```",
    keyboardBlock,
    "",
    `## Sanitized DOM${dom.truncated ? " (truncated)" : ""}`,
    "```html",
    dom.html,
    "```",
    suppression,
  ].join("\n");

  // --- one structured call --------------------------------------------------
  let data, usage = { inputTokens: 0, outputTokens: 0 };
  const warnings = [];
  try {
    data = await aiStructured(ai, {
      system: buildAuditPrompt({ chromeOnly }),
      user: userText,
      images: screenshot ? [screenshot] : [],
      schema: AUDIT_SCHEMA,
      maxTokens,
    });
    usage = data.__usage ?? usage;
  } catch (e) {
    warnings.push(`AI audit failed for ${url}: ${String(e.message ?? e)}`);
    return { findings: [], passes: [], usage, cost: zeroCost(ai), warnings, screenshot };
  }

  // --- map findings ---------------------------------------------------------
  // Each finding carries BOTH the flat 6-key contract you specified
  // (severity, wcag, description, evidence, recommendation, codeExample) AND the
  // internal fields the crawler's recordScan + reports need (id, impact, wcag[],
  // nodes). Same object, two views — nothing downstream has to change.
  const findings = (Array.isArray(data.findings) ? data.findings : [])
    .filter((f) => f && f.description && f.evidence)   // "strong evidence only"
    .map((f) => {
      const wcagStr = String(f.wcag || "").split(" ")[0];
      const rec = f.recommendation || "";
      const code = f.codeExample || "";
      return {
        // flat contract (as requested) — wcag as a single string
        severity: normSeverity(f.severity),
        wcagString: wcagStr,
        description: f.description,
        evidence: f.evidence,
        recommendation: rec,
        codeExample: code,
        // internal fields for recordScan / site report / cost report
        id: `ai-audit:${slug(f.description)}`,
        impact: normSeverity(f.severity),
        help: f.description.slice(0, 120),
        title: f.description.slice(0, 120),
        explanation: f.description,
        fix: [rec, code].filter(Boolean).join("\n\n"),
        wcag: wcagStr ? [wcagStr] : [],     // array, as other findings use
        source: "ai-audit",
        evidenceStatus: "reported",
        selector: String(f.selector || "").trim(),
        nodes: [{
          target: String(f.selector || "").trim() || url,
          html: "",
          failureSummary: [rec, code].filter(Boolean).join(" — "),
        }],
      };
    });

  const passes = (Array.isArray(data.passes) ? data.passes : [])
    .map((p) => ({ message: p.message }))
    .filter((p) => p.message);

  // Resolve each finding's selector on the LIVE page into a bounding box + the
  // element's real HTML. Without this an AI finding has nothing to outline, which
  // is why AI cards showed an empty "failing elements" box and no screenshot.
  // Done here because this is the only moment the audited state is still open —
  // an interaction-revealed drawer is gone by the time the report is built.
  for (const f of findings) {
    const sel = f.selector;
    if (!sel) continue;
    try {
      const found = await page.evaluate((s) => {
        let el = null;
        try { el = document.querySelector(s); } catch { return null; }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return {
          box: {
            x: Math.round(r.left + window.scrollX),
            y: Math.round(r.top + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
          html: el.outerHTML.slice(0, 400),
        };
      }, sel);
      if (found) {
        f.nodes[0].box = found.box;
        f.nodes[0].html = found.html;
      } else {
        f.nodes[0].boxSkipped = "not-found";
      }
    } catch {
      f.nodes[0].boxSkipped = "not-found";
    }
  }

  const cost = estimateCost({ provider: ai.provider, model: ai.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

  return { findings, passes, usage, cost, warnings, screenshot };
}

// Render the keyboard walk + focus-visible probe into a compact evidence block
// the model can cite. Steps outside the viewport are included on purpose.
function formatKeyboardEvidence(keyboard) {
  if (!keyboard || !keyboard.walk) return "";
  const lines = ["", "## Keyboard navigation trace (Tab order)"];
  const trace = keyboard.walk.trace ?? [];
  if (!trace.length) {
    lines.push("(no focusable elements traced)");
  } else {
    lines.push("```");
    for (const s of trace.slice(0, 60)) {
      const flags = [s.hidden && "HIDDEN", s.zeroSize && "0x0", s.offscreen && "OFFSCREEN", s.tabindex && +s.tabindex > 0 && `tabindex=${s.tabindex}`].filter(Boolean).join(",");
      lines.push(`${String(s.step).padStart(2, " ")}. ${s.role || s.tag} "${s.name || "(no name)"}" ${s.selector}${flags ? `  [${flags}]` : ""}`);
    }
    if (trace.length > 60) lines.push(`… +${trace.length - 60} more steps`);
    lines.push("```");
  }
  const st = keyboard.stats ?? {};
  if (st.focusIndicatorsChecked) {
    lines.push(`Focus-visible probe (WCAG 2.4.7, measured): ${st.focusIndicatorsMissing} of ${st.focusIndicatorsChecked} controls have NO visible focus indicator. These are already reported — do not re-report them.`);
  }
  return lines.join("\n");
}

function zeroCost(ai) {
  return { usd: 0, inputTokens: 0, outputTokens: 0, note: "AI audit did not run" };
}
function normSeverity(s) {
  const v = String(s || "").toLowerCase();
  return ["critical", "serious", "moderate", "minor"].includes(v) ? v : "moderate";
}
function slug(s) {
  return String(s || "finding").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
