// The AI estimate, isolated so no other crawler shares the event loop.
import { createCrawler } from "../sidecar/crawler.mjs";
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };
function pg() { let cur = "https://s.test/shop/p/1"; return {
  url: () => cur, async title() { return "P"; }, async goto(u) { cur = u; },
  async evaluate(fn) { if (String(fn).includes("axe.run")) return { violations: [] }; return []; },
  async waitForTimeout() {}, async waitForLoadState() {}, async goBack() {}, async screenshot() { return Buffer.from("x"); },
  locator() { return { count: async () => 0, first() { return this; } }; }, getByRole() { return { count: async () => 0, first() { return this; } }; },
  getByText() { return { first() { return { async click() {}, async waitFor() {} }; } }; },
  keyboard: { async press() {} }, context() { return {}; }, mainFrame() { return {}; }, on() {}, off() {} }; }
const c = createCrawler();
c.stop();  // keep the loop from running; we only want the pre-flight estimate
c.start(pg(), { elementScreenshots: false, keyboardEvidence: false, interact: true,
  ai: { provider: "openrouter", model: "x" }, aiAudit: true, maxPages: 80, templateCoverage: true });
await new Promise(r => setTimeout(r, 150));
ck(!!c.state.aiEstimate && c.state.aiEstimate.estimatedRequests > c.state.aiEstimate.pages,
   `estimate accounts for states (${c.state.aiEstimate?.pages}->${c.state.aiEstimate?.estimatedRequests})`);
ck(c.state.log.some(l => /AI Full Scan estimate/.test(l.msg || "")), "estimate logged before spending");
ck(c.state.log.some(l => /large number of AI requests/.test(l.msg || "")), "large run warned");
console.log(P ? "\nESTIMATE TEST PASSED" : "\nFAILED");
process.exit(P ? 0 : 1);
