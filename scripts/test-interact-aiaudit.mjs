// Mock-based verification of the AI-audit-on-revealed-state wiring.
// No Chromium: we fake the Playwright `page` and the injected deps, then assert
// the interaction engine calls deps.auditState on the OPEN modal, BEFORE the
// Escape probe closes it, with the measured + axe rule ids as suppression, and
// folds the returned AI findings into the scenario.
import { exploreInteractions, discoverInteractive, readInteractionState } from "../sidecar/interact.mjs";

let escapePressed = false;
const auditCalls = [];

// One dialog-opening trigger; readInteractionState flips to an open, focus-broken,
// non-aria-modal dialog after the click.
let stateReads = 0;
const page = {
  url: () => "https://example.test/orders",
  async evaluate(fn, arg) {
    const name = fn?.name || "";
    if (name === "discoverInteractive") {
      return [{ label: "Open details", role: "button", kind: "dialog", selector: "#open", ariaExpanded: null }];
    }
    if (name === "readInteractionState") {
      stateReads++;
      // 1st read = before (closed); subsequent reads = after (open dialog).
      if (stateReads === 1) {
        return { dialogPresent: false, invalid: [], liveRegions: [], activeInDialog: false, activeTag: "body" };
      }
      return {
        dialogPresent: true, invalid: [], liveRegions: [],
        activeInDialog: false, activeTag: "body",
        dialogRole: "dialog", dialogAriaModal: null,
      };
    }
    // aria-expanded re-read / checkEscapeAndReturn's inline evals / reverse
    if (typeof arg === "string" || fn.length >= 1) return null;
    return null;
  },
  locator() { return { first: () => ({ click: async () => {}, count: async () => 0 }), count: async () => 0 }; },
  getByText() { return { first: () => ({ click: async () => {} }) }; },
  keyboard: { press: async (k) => { if (k === "Escape") escapePressed = true; } },
  waitForTimeout: async () => {},
};

const deps = {
  scanPage: async () => ([{ id: "color-contrast", impact: "serious", nodes: [{ target: "x" }] }]),
  captureKeyboard: async () => null,
  log: () => {},
  auditState: async (p, ctx) => {
    auditCalls.push({ ctx, escapeAlreadyPressed: escapePressed });
    return [{
      id: "ai-audit:focus-trap-missing", source: "ai-audit", impact: "serious",
      description: "Focus is not trapped inside the dialog", evidence: "Tab reaches page behind",
      nodes: [{ target: ctx.url }], wcag: ["2.4.3"],
    }];
  },
};

const { scenarios } = await exploreInteractions(page, { keyboardEvidence: false, maxInteractions: 5 }, deps);

const dialogScenario = scenarios.find((s) => s.meta?.kind === "dialog");
let pass = true;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) pass = false; };

check(auditCalls.length === 1, `auditState called exactly once (got ${auditCalls.length})`);
check(auditCalls[0]?.escapeAlreadyPressed === false, "AI audit ran BEFORE the Escape probe (state still open)");
check(escapePressed === true, "Escape probe still ran afterwards (destructive check intact)");
const sup = auditCalls[0]?.ctx?.suppressRuleIds || [];
check(sup.includes("color-contrast"), "axe rule id passed as suppression");
check(sup.includes("focus-not-moved-to-dialog") && sup.includes("dialog-missing-aria-modal"), "measured rule ids passed as suppression");
check(auditCalls[0]?.ctx?.kind === "dialog", "stateContext.kind forwarded");
check(!!dialogScenario, "dialog scenario recorded");
check(dialogScenario?.violations?.some((v) => v.source === "ai-audit"), "AI finding folded into the scenario");
check(dialogScenario?.violations?.some((v) => v.id === "focus-not-moved-to-dialog"), "measured finding still present");
check(dialogScenario?.violations?.some((v) => v.id === "color-contrast"), "axe finding still present");
check(dialogScenario?.meta?.aiAudited === true, "scenario meta flags aiAudited");

// Negative control: with no auditState injected, no AI call, scenario still forms.
auditCalls.length = 0; escapePressed = false; stateReads = 0;
const { scenarios: noAi } = await exploreInteractions(page, { keyboardEvidence: false }, { ...deps, auditState: null });
check(noAi.find((s) => s.meta?.kind === "dialog") != null, "without auditState, dialog scenario still produced");
check(noAi.find((s) => s.meta?.kind === "dialog")?.violations?.every((v) => v.source !== "ai-audit"), "without auditState, no AI findings appear");

console.log(pass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(pass ? 0 : 1);
