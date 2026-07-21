// Drive the REAL crawler with a fake Playwright page, to prove the redirect work
// did not change how a normal URL-list scan behaves.
import { createCrawler } from "/home/claude/a11y-lens-new/sidecar/crawler.mjs";
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

function makePage(redirects = {}) {
  let cur = "https://portal.test/";
  return {
    url: () => cur,
    async title() { return "T " + new URL(cur).pathname; },
    async goto(u) { cur = redirects[new URL(u).pathname] ? `https://portal.test${redirects[new URL(u).pathname]}` : u; },
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("axe.run")) return { violations: [] };     // axe: clean page
      return null;
    },
    async waitForTimeout() {}, async waitForLoadState() {},
    async screenshot() { return Buffer.from("x"); },
    locator() { return { count: async () => 0, first() { return this; } }; },
    getByRole() { return { count: async () => 0, first() { return this; } }; },
    keyboard: { async press() {} },
    context() { return { async newPage() { return this; } }; },
    mainFrame() { return {}; }, on() {}, off() {},
  };
}

const opts = { urlList: [], elementScreenshots: false, keyboardEvidence: false, interact: false, ai: null, aiAudit: false };

// 1 · normal list, no redirects — the pre-existing behaviour
{
  const c = createCrawler();
  const urls = ["/a", "/b", "/c"].map(p => "https://portal.test" + p);
  c.start(makePage(), { ...opts, urlList: urls });
  await new Promise(r => setTimeout(r, 350));
  const s = c.state;
  ck(s.pagesScanned.length === 3, `3 clean URLs -> 3 pages scanned (got ${s.pagesScanned.length})`);
  ck(s.redirects.list.length === 0, "no redirects recorded when nothing redirects");
  ck(s.pagesScanned.every(p => p.requestedUrl === p.url), "requestedUrl equals url when no redirect");
  ck(s.pagesScanned.every(p => p.redirected === false), "redirected=false on every normal row");
  ck(!!s.result && s.result.pages.length === 3, "result assembled as before");
}

// 2 · expired session — every page bounces to /login
{
  const c = createCrawler();
  const urls = Array.from({length:8},(_,i)=>`https://portal.test/p${i}`);
  const red = {}; urls.forEach(u => red[new URL(u).pathname] = "/login");
  c.start(makePage(red), { ...opts, urlList: urls });
  await new Promise(r => setTimeout(r, 400));
  const s = c.state;
  ck(s.pagesScanned.length === 0, `login page never recorded as a scanned page (got ${s.pagesScanned.length})`);
  ck(s.redirects.auth >= 3, `auth redirects counted (${s.redirects.auth})`);
  ck(/not authenticated/i.test(s.error || ""), "run stopped with an actionable error");
}

// 3 · canonical redirect — scan the destination once
{
  const c = createCrawler();
  const urls = ["/shop/tv", "/shop/tv-old", "/shop/kurv"].map(p=>"https://portal.test"+p);
  c.start(makePage({ "/shop/tv": "/shop/tv-pakker", "/shop/tv-old": "/shop/tv-pakker" }), { ...opts, urlList: urls });
  await new Promise(r => setTimeout(r, 350));
  const s = c.state;
  ck(s.pagesScanned.length === 2, `two URLs collapsing to one destination -> 2 pages, not 3 (got ${s.pagesScanned.length})`);
  const row = s.pagesScanned.find(p => p.redirected);
  ck(!!row && /tv-pakker/.test(row.url) && /\/shop\/tv$/.test(row.requestedUrl),
     "redirected row records the destination as url and keeps the requested URL");
}

console.log(P ? "\nNO REGRESSION — existing paths behave as before" : "\nREGRESSION DETECTED");
process.exit(P ? 0 : 1);
