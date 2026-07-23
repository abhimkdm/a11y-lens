// URL identity for scan dedup: nested paths, params and values.
// The rule: parameters that CHANGE CONTENT make a new page; parameters that only
// track the visitor do not.
import { canonicalKey } from "../sidecar/url-template.mjs";
import { createCrawler } from "../sidecar/crawler.mjs";
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };
const same = (a, b) => canonicalKey(a) === canonicalKey(b);

console.log("— params that change content are DIFFERENT pages —");
ck(!same("https://h/shop?page=2", "https://h/shop?page=3"), "pagination is not collapsed (page=2 vs page=3)");
ck(!same("https://h/shop?sort=name", "https://h/shop?sort=price"), "sort order is a different view");
ck(!same("https://h/ecare?tab=billing", "https://h/ecare?tab=usage"), "tab is a different view");
ck(!same("https://h/ecare/finance/1", "https://h/ecare/finance/2"), "nested path ids are different pages");
ck(!same("https://h/a/b/c", "https://h/a/b"), "nested depth is respected");

console.log("\n— params that only track the visitor are the SAME page —");
for (const [a, b, why] of [
  ["https://h/shop?utm_source=mail", "https://h/shop?utm_source=sms", "utm_source"],
  ["https://h/shop?sessionId=aaa", "https://h/shop?sessionId=bbb", "sessionId"],
  ["https://h/shop?timestamp=1", "https://h/shop?timestamp=2", "timestamp"],
  ["https://h/shop?gclid=x", "https://h/shop", "gclid vs none"],
]) ck(same(a, b), `${why} does not create a duplicate scan`);

console.log("\n— shape normalisation —");
ck(same("https://h/shop?a=1&b=2", "https://h/shop?b=2&a=1"), "parameter ORDER does not create a phantom page");
ck(same("https://h/ecare/", "https://h/ecare"), "trailing slash is the same page");
ck(same("https://H/ecare", "https://h/ecare"), "host case is normalised");
ck(same("https://h/x#section-2", "https://h/x"), "a plain fragment is the same document");
ck(!same("https://h/x#state-2", "https://h/x"), "our own #state marker DOES mark a distinct SPA state");
ck(same("https://h/shop?page=2&utm_source=x", "https://h/shop?page=2"),
   "a real param survives while the tracking param next to it is dropped");

console.log("\n— through the real crawler —");
function listPage() {
  let cur = "https://h/shop";
  return { url: () => cur, async title() { return "Shop"; }, async goto(u) { cur = u; },
    async evaluate(fn) { const s = String(fn); if (s.includes("axe.run")) return { violations: [] }; return []; },
    async waitForTimeout() {}, async waitForLoadState() {}, async goBack() {},
    async screenshot() { return Buffer.from("x"); },
    locator() { return { count: async () => 0, first() { return this; } }; },
    getByRole() { return { count: async () => 0, first() { return this; } }; },
    getByText() { return { first() { return { async click() {}, async waitFor() {} }; } }; },
    keyboard: { async press() {} }, context() { return {}; }, mainFrame() { return {}; }, on() {}, off() {} };
}
const base = { elementScreenshots: false, keyboardEvidence: false, interact: false, ai: { provider: null }, aiAudit: false, templateCoverage: false };
const settle = (ms) => new Promise(r => setTimeout(r, ms));

// same page reached via four tracking variants -> scanned ONCE
{
  const c = createCrawler();
  c.start(listPage(), { ...base, urlList: [
    "https://h/shop?utm_source=mail", "https://h/shop?utm_source=sms",
    "https://h/shop?sessionId=abc", "https://h/shop",
  ] });
  await settle(700); c.stop();
  ck(c.state.pagesScanned.length === 1,
     `4 tracking-param variants of one page -> scanned ONCE (got ${c.state.pagesScanned.length})`);
}

// genuinely paginated list -> each page scanned
{
  const c = createCrawler();
  c.start(listPage(), { ...base, urlList: [
    "https://h/shop?page=1", "https://h/shop?page=2", "https://h/shop?page=3",
  ] });
  await settle(700); c.stop();
  ck(c.state.pagesScanned.length === 3,
     `3 paginated pages -> all 3 scanned, none collapsed (got ${c.state.pagesScanned.length})`);
}

console.log(P ? "\nALL URL-IDENTITY TESTS PASSED" : "\nSOME FAILED");
process.exit(P ? 0 : 1);
