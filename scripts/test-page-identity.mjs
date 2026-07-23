// Page URL + title in report rows. The bug: title was read immediately after
// navigation, before the page settled — so on an SPA it was frequently the
// PREVIOUS route's title, or the app-shell title repeated on every row.
import { createCrawler } from "../sidecar/crawler.mjs";
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

// An SPA whose document.title lags: it reports the OLD title for the first two
// reads after a navigation, then the correct one — exactly the real-world race.
function spaPage({ titles, h1 = "", finalUrl = null }) {
  let cur = "https://portal.test/ecare";
  let navCount = 0, settled = false;
  return {
    url: () => (finalUrl && navCount > 0 ? finalUrl : cur),
    // A real SPA updates document.title after it renders — i.e. after the page
    // settles. Until then the previous route's title is still showing.
    async title() { return settled ? titles.real : titles.stale; },
    async goto(u) { cur = u; navCount++; settled = false; },
    __settle() { settled = true; },
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes("scrollTo") || s.includes("networkidle")) { this.__settle(); return null; }
      if (s.includes("axe.run")) return { violations: [] };
      if (s.includes("aria-level")) return h1;                    // H1 fallback
      if (s.includes('role="tab"') || s.includes("nav button")) return [];
      return null;
    },
    async waitForTimeout() {}, async waitForLoadState() {}, async goBack() {},
    async screenshot() { return Buffer.from("x"); },
    locator() { return { count: async () => 0, first() { return this; } }; },
    getByRole() { return { count: async () => 0, first() { return this; } }; },
    getByText() { return { first() { return { async click() {}, async waitFor() {} }; } }; },
    keyboard: { async press() {} }, context() { return {}; }, mainFrame() { return {}; }, on() {}, off() {},
  };
}
const base = { elementScreenshots: false, keyboardEvidence: false, interact: false, ai: { provider: null }, aiAudit: false, templateCoverage: false };
const settle = (ms) => new Promise(r => setTimeout(r, ms));

// 1 · a lagging SPA title is retried until it is correct
{
  const c = createCrawler();
  c.start(spaPage({ titles: { stale: "Mit YouSee", real: "Invoices — Mit YouSee" }, lag: 2 }),
          { ...base, urlList: ["https://portal.test/ecare/finance/1/invoices"] });
  await settle(900); c.stop();
  const row = c.state.pagesScanned[0];
  ck(!!row, "a page row was recorded");
  ck(row?.title === "Invoices — Mit YouSee",
     `report row shows the SETTLED title, not the stale one (got "${row?.title}")`);
}

// 2 · a useless title falls back to the page's H1
{
  const c = createCrawler();
  c.start(spaPage({ titles: { stale: "Loading…", real: "Loading…" }, h1: "Payment overview" }),
          { ...base, urlList: ["https://portal.test/ecare/pay"] });
  await settle(1400); c.stop();
  ck(c.state.pagesScanned[0]?.title === "Payment overview",
     `a placeholder title falls back to the H1 (got "${c.state.pagesScanned[0]?.title}")`);
}

// 3 · no title and no H1 -> the path, never a blank row
{
  const c = createCrawler();
  c.start(spaPage({ titles: { stale: "", real: "" }, h1: "" }),
          { ...base, urlList: ["https://portal.test/ecare/settings/profile"] });
  await settle(1400); c.stop();
  const t = c.state.pagesScanned[0]?.title;
  ck(!!t && t !== "", `a row is never left unnamed (got "${t}")`);
  ck(/profile/.test(t || ""), "falls back to something identifiable from the URL");
}

// 4 · the URL recorded is the one actually scanned
{
  const c = createCrawler();
  c.start(spaPage({ titles: { stale: "x", real: "Profile" }, finalUrl: "https://portal.test/ecare/settings/profile?tab=general" }),
          { ...base, urlList: ["https://portal.test/ecare/settings/profile"] });
  await settle(900); c.stop();
  const row = c.state.pagesScanned[0];
  ck(/\/ecare\/settings\/profile/.test(row?.url || ""), `row URL names the scanned page (got "${row?.url}")`);
  ck(!!row?.requestedUrl, "the originally requested URL is still recorded alongside it");
}

console.log(P ? "\nALL PAGE-IDENTITY TESTS PASSED" : "\nSOME FAILED");
process.exit(P ? 0 : 1);
