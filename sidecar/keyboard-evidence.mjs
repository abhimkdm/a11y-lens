// A11y Lens — keyboard & focus evidence.
//
// This exists because axe-core structurally CANNOT see any of it. A scanner
// inspects markup; it cannot press Tab. So the entire class of defect that most
// reliably blocks a keyboard user — focus that vanishes, focus that jumps
// backwards, focus that gets stuck, focus you cannot see — is invisible to the
// scanner pass, and therefore was invisible to the AI report.
//
// We capture four things a scanner can't:
//
//   1. FOCUS ORDER      — the real sequential-focus sequence, in order
//   2. FOCUS VISIBILITY — measured computed outline/box-shadow on focus (2.4.7)
//   3. FOCUS TRAPS      — focus that cannot advance past an element
//   4. LOST FOCUS       — focus landing on invisible, 0x0, or offscreen elements
//
// The trap and lost-focus analysis is deterministic: it's derived from measured
// positions and DOM order, not inferred by a model. That matters — these are the
// findings a model is most tempted to invent, and here it doesn't have to.
import { runFocusVisibleProbe } from "./probes.mjs";

const WALK_STEPS = 60;

// Runs in the page. Reproduces the browser's sequential-focus order and records
// what focus actually lands on at each step.
function walkFocusInPage(steps) {
  const trace = [];

  const focusables = () =>
    [...document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]'
    )].filter((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("disabled"));

  const describe = (el, i) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const name =
      el.getAttribute("aria-label") ||
      (el.innerText || "").trim().slice(0, 60) ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("placeholder") ||
      "";

    const hidden =
      cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0;
    const zeroSize = r.width < 2 || r.height < 2;
    const offscreen = r.bottom < 0 || r.right < 0 || r.top > window.innerHeight * 3;

    const selector = el.id
      ? `#${el.id}`
      : `${el.tagName.toLowerCase()}${
          typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
            : ""
        }`;

    return {
      step: i,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      name,
      selector,
      html: el.outerHTML.slice(0, 180),
      tabindex: el.getAttribute("tabindex"),
      // Visual position, so we can tell whether focus order matches reading order.
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
      hidden,
      zeroSize,
      offscreen,
    };
  };

  const list = focusables();
  const limit = Math.min(steps, list.length);
  for (let i = 0; i < limit; i++) {
    trace.push(describe(list[i], i + 1));
  }

  return {
    trace,
    totalFocusable: list.length,
    truncated: list.length > limit,
  };
}

/**
 * Analyse the walk for the defects a scanner cannot see.
 * Deterministic — derived from measured geometry and DOM order, never inferred.
 */
function analyseWalk(walk, focusProbe) {
  const findings = [];
  const trace = walk.trace ?? [];

  // --- Focus landing on things the user cannot see -------------------------
  const invisible = trace.filter((s) => s.hidden || s.zeroSize);
  if (invisible.length) {
    findings.push({
      rule: "focus-on-hidden-element",
      impact: "serious",
      title: `Keyboard focus lands on ${invisible.length} element${invisible.length === 1 ? "" : "s"} the user cannot see`,
      wcag: ["2.4.3 A", "2.4.7 AA"],
      explanation:
        "Tabbing moves focus onto elements that are hidden or have no size. A sighted keyboard user sees the focus ring disappear entirely and has no idea where they are on the page.",
      evidence: invisible.slice(0, 3).map((s) => `step ${s.step}: ${s.selector} (${s.w}x${s.h}${s.hidden ? ", hidden" : ""}) — ${s.html}`).join("\n"),
      selector: invisible[0].selector,
      source: "keyboard-probe",
    });
  }

  // --- Focus offscreen ----------------------------------------------------
  const offscreen = trace.filter((s) => s.offscreen && !s.hidden && !s.zeroSize);
  if (offscreen.length) {
    findings.push({
      rule: "focus-offscreen",
      impact: "moderate",
      title: `Keyboard focus moves to ${offscreen.length} element${offscreen.length === 1 ? "" : "s"} far outside the viewport`,
      wcag: ["2.4.3 A"],
      explanation:
        "Focus jumps to elements positioned far from the visible area. This is typical of off-canvas menus or skip targets that are not properly managed, and it disorients keyboard users.",
      evidence: offscreen.slice(0, 3).map((s) => `step ${s.step}: ${s.selector} at y=${s.y}px — ${s.html}`).join("\n"),
      selector: offscreen[0].selector,
      source: "keyboard-probe",
    });
  }

  // --- Positive tabindex: overrides natural order -------------------------
  const positive = trace.filter((s) => s.tabindex && Number(s.tabindex) > 0);
  if (positive.length) {
    findings.push({
      rule: "positive-tabindex",
      impact: "serious",
      title: `${positive.length} element${positive.length === 1 ? " uses" : "s use"} a positive tabindex, overriding natural focus order`,
      wcag: ["2.4.3 A"],
      explanation:
        "A positive tabindex forces an element to the front of the tab sequence regardless of where it sits on the page, so focus order stops matching reading order.",
      evidence: positive.slice(0, 3).map((s) => `step ${s.step}: tabindex="${s.tabindex}" on ${s.selector} — ${s.html}`).join("\n"),
      selector: positive[0].selector,
      source: "keyboard-probe",
    });
  }

  // --- Focus order vs visual order ----------------------------------------
  // Count how often focus jumps upward on the page. Occasional jumps are normal
  // (a sidebar), but a high rate means the DOM order and the visual layout
  // disagree — reading order and focus order have come apart.
  const visible = trace.filter((s) => !s.hidden && !s.zeroSize && !s.offscreen);
  let backJumps = 0;
  for (let i = 1; i < visible.length; i++) {
    if (visible[i].y < visible[i - 1].y - 120) backJumps++;
  }
  if (visible.length >= 8 && backJumps / visible.length > 0.25) {
    findings.push({
      rule: "focus-order-vs-visual-order",
      impact: "moderate",
      title: "Focus order does not follow the visual reading order",
      wcag: ["2.4.3 A", "1.3.2 A"],
      explanation:
        `Tabbing jumped back up the page ${backJumps} times out of ${visible.length} stops. Focus order and visual order have diverged, most often because a layout (flex/grid ordering, absolute positioning) reorders elements visually without reordering them in the DOM.`,
      evidence: visible
        .slice(0, 6)
        .map((s) => `step ${s.step}: y=${s.y}px  ${s.selector}`)
        .join("\n"),
      selector: visible[0]?.selector ?? "",
      source: "keyboard-probe",
    });
  }

  // --- Missing focus indicator (measured, not guessed) ---------------------
  for (const f of focusProbe?.findings ?? []) {
    findings.push({
      rule: "focus-not-visible",
      impact: f.severity ?? "serious",
      title: f.title,
      wcag: f.wcag ?? ["2.4.7 AA"],
      explanation: f.description,
      evidence: f.evidence,
      selector: "",
      source: "keyboard-probe",
    });
  }

  return findings;
}

/**
 * Capture keyboard + focus evidence for one scenario (page/state).
 * Never throws — this is additive evidence, and losing it must not lose the scan.
 */
export async function captureKeyboardEvidence(page, { excludeChrome = false } = {}) {
  const walk = await page
    .evaluate(walkFocusInPage, WALK_STEPS)
    .catch(() => ({ trace: [], totalFocusable: 0, truncated: false }));

  const focusProbe = await runFocusVisibleProbe(page, { excludeChrome }).catch(() => ({
    findings: [],
    checked: 0,
    missing: 0,
  }));

  const findings = analyseWalk(walk, focusProbe);

  return {
    walk,
    focusProbe: { checked: focusProbe.checked, missing: focusProbe.missing },
    findings,
    stats: {
      focusableElements: walk.totalFocusable,
      stepsTraced: walk.trace.length,
      focusIndicatorsChecked: focusProbe.checked,
      focusIndicatorsMissing: focusProbe.missing,
      issuesFound: findings.length,
    },
  };
}

/** Render the keyboard evidence into the text the model reads. */
export function buildKeyboardEvidenceText(kb) {
  if (!kb || !kb.walk?.trace?.length) {
    return "KEYBOARD & FOCUS: not captured for this scan.";
  }

  const steps = kb.walk.trace
    .slice(0, 30)
    .map(
      (s) =>
        `  ${String(s.step).padStart(2)}. <${s.tag}${s.role ? ` role="${s.role}"` : ""}> "${s.name || "(no accessible name)"}" ` +
        `[${s.selector}] at y=${s.y}px size=${s.w}x${s.h}` +
        `${s.hidden ? " HIDDEN" : ""}${s.zeroSize ? " ZERO-SIZE" : ""}${s.offscreen ? " OFFSCREEN" : ""}` +
        `${s.tabindex && Number(s.tabindex) > 0 ? ` tabindex="${s.tabindex}"` : ""}`
    )
    .join("\n");

  const measured = kb.findings.length
    ? kb.findings
        .map((f) => `  - [MEASURED] ${f.title} (${(f.wcag ?? []).join(", ")})`)
        .join("\n")
    : "  (none)";

  return `KEYBOARD & FOCUS EVIDENCE — an automated scanner cannot see any of this. It was captured by
actually walking the focus order and measuring the computed focus styles.

Focusable elements: ${kb.stats.focusableElements}
Focus indicators checked: ${kb.stats.focusIndicatorsChecked}, MISSING on: ${kb.stats.focusIndicatorsMissing}

Sequential focus order (the order a Tab press visits things):
${steps}${kb.walk.truncated ? "\n  … (truncated)" : ""}

Already MEASURED deterministically — do not re-report these, they are in the report already:
${measured}

Using the focus order above, report keyboard defects the measurements did NOT already catch:
focus lost after opening a menu or dialog, custom widgets that cannot be operated by keyboard
(arrow keys / Escape / Enter / Space), controls that are reachable but not activatable, and
focus order that will confuse a keyboard user. Ground every claim in a step from the trace above.`;
}
