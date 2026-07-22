// Template-aware coverage + 1000 ceiling. The dedup DECISION is unit-tested
// directly (no browser mock), because that is the logic that matters; the crawl
// loop's link-following is exercised by test-crawler-regression and test-scope-crawl.
import { templatize } from "../sidecar/url-template.mjs";
import { createCrawler } from "../sidecar/crawler.mjs";
function stubPage() {
  let cur = "https://s.test/x";
  return { url: () => cur, async title() { return "P"; }, async goto(u) { cur = u; },
    async evaluate() { return { violations: [] }; }, async waitForTimeout() {}, async waitForLoadState() {},
    async screenshot() { return Buffer.from("x"); }, locator() { return { count: async () => 0, first() { return this; } }; },
    getByRole() { return { count: async () => 0, first() { return this; } }; },
    getByText() { return { first() { return { async click() {}, async waitFor() {} }; } }; },
    keyboard: { async press() {} }, context() { return {}; }, mainFrame() { return {}; }, on() {}, off() {} };
}
const noWork = { elementScreenshots: false, keyboardEvidence: false, interact: false, ai: { provider: null }, aiAudit: false };
function tick() { return new Promise(r => setTimeout(r, 40)); }


let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

// 1 · template budget: N representatives per distinct template
{
  const perTemplate = 3, counts = new Map();
  const left = (u) => (counts.get(templatize(u).pathTemplate) || 0) < perTemplate;
  const note = (u) => { const t = templatize(u).pathTemplate; counts.set(t, (counts.get(t) || 0) + 1); };
  let scanned = 0, skipped = 0;
  for (let i = 1; i <= 120; i++) { const u = `https://s/shop/tilbehoer/${i}`; if (left(u)) { scanned++; note(u); } else skipped++; }
  for (let i = 1; i <= 15; i++)  { const u = `https://s/ecare/products/uuid-${i}/x`; if (left(u)) { scanned++; note(u); } else skipped++; }
  ck(scanned === 6, `two templates x 3 reps -> 6 scanned (got ${scanned})`);
  ck(skipped === 129, `the other 129 near-identical pages skipped (got ${skipped})`);
  ck(counts.size === 2, "exactly 2 distinct templates recorded");
}

// 2 · ceiling / default (state is set synchronously at run start)
{
  const c = createCrawler(); c.stop();
  c.start(stubPage(), { ...noWork, templateCoverage: false });
  await tick();
  ck(c.state.unitsTotal === 50, `default page budget is 50, not 10 (${c.state.unitsTotal})`);
}
{
  const c = createCrawler(); c.stop();
  c.start(stubPage(), { ...noWork, maxPages: 5000, templateCoverage: false });
  await tick();
  ck(c.state.unitsTotal === 1000, `maxPages capped at 1000 (asked 5000, got ${c.state.unitsTotal})`);
}

console.log(P ? "\nALL COVERAGE TESTS PASSED" : "\nSOME COVERAGE TESTS FAILED");
process.exit(P ? 0 : 1);
