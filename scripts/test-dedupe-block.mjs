// Verify (1) the scan-wide interaction cache skips identical controls across
// pages, and (2) toBlock() normalizes any finding to the 6-key report block.
import { exploreInteractions, discoverInteractive, readInteractionState } from "../sidecar/interact.mjs";
import { toBlock, codeExampleFor } from "../sidecar/finding-block.mjs";

let PASS = true;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) PASS = false; };

// ---- 1. interaction cache across "pages" ----
let opened = 0;
function fakePage(candidateLabel) {
  let reads = 0;
  return {
    url: () => "https://shop.test/product",
    async evaluate(fn) {
      const n = fn?.name || "";
      if (n === "discoverInteractive") return [{ label: candidateLabel, role: "button", kind: "dialog", selector: "#f" }];
      if (n === "readInteractionState") { reads++; return reads === 1
        ? { dialogPresent: false, invalid: [], liveRegions: [], activeInDialog: false, activeTag: "body" }
        : { dialogPresent: true, invalid: [], liveRegions: [], activeInDialog: true, activeTag: "button", dialogRole: "dialog", dialogAriaModal: "true" }; }
      return null;
    },
    locator() { return { first: () => ({ click: async () => { opened++; }, count: async () => 0 }), count: async () => 0 }; },
    getByText() { return { first: () => ({ click: async () => { opened++; } }) }; },
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
}
const cache = new Set();
const deps = () => ({
  scanPage: async () => [],
  captureKeyboard: async () => null,
  log: () => {},
  dedupe: { seen: (s) => cache.has(s), add: (s) => cache.add(s) },
});

// Same "Filter" control on three pages — should open once, skip twice.
for (let i = 0; i < 3; i++) {
  await exploreInteractions(fakePage("Filter"), { keyboardEvidence: false }, deps());
}
check(opened === 1, `identical control opened once across 3 pages (opened=${opened})`);

// A different control name is NOT skipped.
opened = 0;
await exploreInteractions(fakePage("Kontantpris"), { keyboardEvidence: false }, deps());
check(opened === 1, "a differently-named control is still audited");

// digit-collapsing: "Item 1" and "Item 2" hash to the same control.
cache.clear(); opened = 0;
await exploreInteractions(fakePage("Item 1"), { keyboardEvidence: false }, deps());
await exploreInteractions(fakePage("Item 2"), { keyboardEvidence: false }, deps());
check(opened === 1, "numbered variants (Item 1 / Item 2) de-duplicate to one");

// ---- 2. toBlock normalization ----
const axeFinding = { id: "image-alt", impact: "critical", help: "Images must have alt text",
  description: "Image has no text alternative", wcag: ["1.1.1"], nodes: [{ html: '<img src="x.png">', target: "img.hero" }] };
const b1 = toBlock(axeFinding);
check(b1.severity === "critical" && b1.wcag === "1.1.1", "axe finding → severity + single wcag");
check(b1.evidence.includes("<img"), "axe finding → evidence pulled from node html");
check(b1.recommendation === "Images must have alt text", "axe finding → recommendation from help");
check(b1.codeExample.includes("alt="), "axe finding → codeExample synthesized from dictionary");

const aiFinding = { id: "ai-audit:focus", impact: "serious", severity: "serious", wcagString: "2.4.3",
  description: "Focus not trapped in dialog", evidence: "Tab reaches page behind modal",
  recommendation: "Trap focus within the dialog", codeExample: "trapFocus(dialog);", wcag: ["2.4.3"] };
const b2 = toBlock(aiFinding);
check(b2.codeExample === "trapFocus(dialog);", "AI finding → keeps its own codeExample");
check(Object.keys(b2).join(",") === "severity,wcag,description,evidence,recommendation,codeExample", "block has exactly the 6 keys in order");

check(codeExampleFor("dialog-no-escape").includes("Escape"), "measured rule → dictionary code example");
check(codeExampleFor("unknown-rule") === "", "unknown rule → empty codeExample (no fabrication)");

console.log(PASS ? "\nALL DEDUPE+BLOCK TESTS PASSED" : "\nSOME TESTS FAILED");
process.exit(PASS ? 0 : 1);
