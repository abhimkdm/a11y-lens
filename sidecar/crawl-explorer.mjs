// A11y Lens — Crawl Explorer engine.
//
// Discovers the pages of a site and organises them into a parent-child tree, so
// a person can choose exactly what gets scanned instead of trusting an AI to
// wander somewhere useful.
//
// THREE SOURCES:
//   sitemap  — parse sitemap.xml (including a sitemapindex of nested sitemaps)
//   crawl    — breadth-first link discovery from a root URL
//   list     — a plain list of URLs the user already has
//
// TWO THINGS THAT MATTER MORE THAN THEY LOOK:
//
// 1. Crawling runs INSIDE the authenticated browser session. An enterprise app
//    behind a login returns a redirect to any anonymous fetch, so a Node-side
//    HTTP crawler would faithfully map the login page and nothing else. We fetch
//    from within the page context, which carries the session cookies.
//
// 2. Discovery is read-only, by construction. It fetches HTML and reads <a href>;
//    it never clicks, submits, or activates anything. The DENY list is a second
//    layer: even a link whose TEXT or URL looks destructive (logout, delete,
//    /signout) is never followed, because following a logout link mid-crawl would
//    destroy the session the whole scan depends on.
const DENY_URL = /\/(logout|signout|sign-out|log-out|delete|remove|destroy|cancel|unsubscribe|deactivate)(\/|$|\?)/i;
const DENY_TEXT = /\b(log ?out|sign ?out|delete|remove|deactivate|unsubscribe|cancel subscription)\b/i;

const SKIP_EXT = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|svg|webp|ico|mp4|mp3|avi|woff2?|ttf|eot|js|css|json|xml)(\?|$)/i;

/** Normalise a URL for identity: no hash, no trailing slash (except root). */
export function normalizeUrl(raw, base) {
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = "";
  // Strip common tracking params so ?utm_source=x isn't treated as a new page.
  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|mc_cid|mc_eid|_ga)/i.test(p)) u.searchParams.delete(p);
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

// Runs in the page, so it inherits the logged-in session's cookies.
function fetchInPage(url) {
  return fetch(url, { credentials: "include", redirect: "follow" })
    .then(async (r) => ({
      status: r.status,
      contentType: r.headers.get("content-type") || "",
      finalUrl: r.url,
      body: (r.headers.get("content-type") || "").includes("html") || (r.headers.get("content-type") || "").includes("xml")
        ? await r.text()
        : "",
    }))
    .catch((e) => ({ status: 0, contentType: "", finalUrl: url, body: "", error: String(e) }));
}

// Read links + title from the LIVE rendered DOM (used for SPA support). Runs
// inside the page via page.evaluate, so `document` is the fully-rendered app.
// Resolves hrefs to absolute via the element's .href property (the browser does
// the base resolution for us, including SPA client-side routes).
function extractLinksLive() {
  const CHROME_HINT = /(^|[-_ ])(masthead|topbar|top-bar|global[-_]?nav|site[-_]?header|site[-_]?footer|main[-_]?nav|primary[-_]?nav|mega[-_]?menu|navbar|header|footer|utility[-_]?nav|breadcrumbs?)([-_ ]|$)/i;
  const inMain = (el) => !!el.closest('main, [role="main"], #main, #content, .app-content, .page-content, [class*="content"]');
  const regionOf = (el) => {
    if (inMain(el)) return "content";
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName ? node.tagName.toLowerCase() : "";
      const role = (node.getAttribute && node.getAttribute("role")) || "";
      if (tag === "header" || tag === "footer" || role === "banner" || role === "contentinfo") return "chrome";
      if (tag === "nav" || role === "navigation") return "chrome";
      const idc = `${node.id || ""} ${(node.className && node.className.toString && node.className.toString()) || ""}`;
      if (CHROME_HINT.test(idc)) return "chrome";
      node = node.parentElement;
    }
    return "content";
  };

  const title = (document.title || "").trim().slice(0, 200);
  const links = [];
  const seen = new Set();
  // Real anchors — .href is already absolute and correct for the current route.
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;                                  // absolute, browser-resolved
    if (!href || seen.has(href)) continue;
    if (/^(javascript:|mailto:|tel:|#)/i.test(a.getAttribute("href") || "")) continue;
    seen.add(href);
    links.push({ href, text: (a.textContent || "").trim().slice(0, 80), region: regionOf(a) });
  }
  return { title, links };
}

// Parse links + title out of an HTML string, inside the page (DOMParser is free there).
function parseHtmlInPage({ html, base }) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = (doc.querySelector("title")?.textContent || "").trim().slice(0, 200);
  const links = [];

  // Is this link part of the global site chrome (the top header / primary nav /
  // footer) rather than the in-app content? Those chrome links lead OUT of the
  // app area (e.g. the marketing site's Mobil / Internet / TV sections) even
  // when they share the same domain, so the crawl should not follow them.
  //
  // Heuristic, in priority order:
  //   - inside <header>, <footer>, or a <nav>/[role=banner|navigation|
  //     contentinfo] that is NOT itself inside the main content region, OR
  //   - carries a class/id that looks like site chrome (masthead, topbar,
  //     global-nav, mega-menu, site-header, etc.)
  // A link inside <main> / [role=main] / an app-shell content region is treated
  // as in-app even if it's technically within some <nav>, because in-app side
  // menus (the "Mit YouSee" rail) live there and we DO want those.
  const CHROME_HINT = /(^|[-_ ])(masthead|topbar|top-bar|global[-_]?nav|site[-_]?header|site[-_]?footer|main[-_]?nav|primary[-_]?nav|mega[-_]?menu|navbar|header|footer|utility[-_]?nav|breadcrumbs?)([-_ ]|$)/i;

  const inMain = (el) => !!el.closest('main, [role="main"], #main, #content, .app-content, .page-content, [class*="content"]');
  const regionOf = (el) => {
    // A link that lives in the app's main content is in-app, period.
    if (inMain(el)) return "content";
    let node = el;
    while (node && node !== doc.body) {
      const tag = node.tagName ? node.tagName.toLowerCase() : "";
      const role = (node.getAttribute && node.getAttribute("role")) || "";
      if (tag === "header" || tag === "footer" || role === "banner" || role === "contentinfo") return "chrome";
      if (tag === "nav" || role === "navigation") return "chrome";
      const idc = `${(node.id || "")} ${(node.className && node.className.toString && node.className.toString()) || ""}`;
      if (CHROME_HINT.test(idc)) return "chrome";
      node = node.parentElement;
    }
    return "content";
  };

  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    links.push({ href, text: (a.textContent || "").trim().slice(0, 80), region: regionOf(a) });
  }
  return { title, links, base };
}

function parseSitemapXml(xml) {
  const urls = [];
  const nested = [];
  // Deliberately regex rather than a DOM parse: sitemaps are machine-generated
  // and frequently 10-50MB, and we only need two tag types.
  const isIndex = /<sitemapindex/i.test(xml);
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    (isIndex ? nested : urls).push(m[1].trim());
  }
  return { urls, nested };
}

export function createCrawlExplorer() {
  const state = {
    running: false,
    crawlId: null,
    source: null,
    discovered: 0,
    queued: 0,
    currentUrl: null,
    log: [],
    error: null,
    done: false,
  };

  const log = (msg) => {
    state.log.push({ t: new Date().toISOString(), msg });
    if (state.log.length > 300) state.log.shift();
  };

  const stop = () => {
    state.running = false;
  };

  /** Fetch through the browser session when we have one; fall back to Node fetch. */
  async function fetchUrl(page, url) {
    if (page) {
      return page.evaluate(fetchInPage, url);
    }
    try {
      const r = await fetch(url, { redirect: "follow" });
      const contentType = r.headers.get("content-type") || "";
      const body = contentType.includes("html") || contentType.includes("xml") ? await r.text() : "";
      return { status: r.status, contentType, finalUrl: r.url, body };
    } catch (e) {
      return { status: 0, contentType: "", finalUrl: url, body: "", error: String(e) };
    }
  }

  // Navigate the REAL browser to the URL, let the app render, then read links
  // and title from the LIVE DOM. This is what makes discovery work on
  // single-page apps (Angular/React/Vue): a raw fetch of a SPA returns an empty
  // shell with no links because the nav is built by JavaScript after load. Only
  // by actually rendering the page in the session do those links exist to find.
  // Region tagging (chrome vs content) runs here too, against the live DOM.
  async function renderAndExtract(page, url) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const status = resp ? resp.status() : 0;
      // Give client-side routing/rendering a moment to paint the nav. networkidle
      // is ideal but can hang on apps that poll, so cap it.
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(400);

      const finalUrl = page.url();
      const data = await page.evaluate(extractLinksLive);
      return { status, contentType: "text/html", finalUrl, title: data.title, links: data.links };
    } catch (e) {
      return { status: 0, contentType: "", finalUrl: url, title: "", links: [], error: String(e) };
    }
  }

  async function parseHtml(page, html, base) {
    if (page) return page.evaluate(parseHtmlInPage, { html, base });
    // Node has no DOMParser; a light regex fallback is enough for link discovery.
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim().slice(0, 200);
    const links = [];
    for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
      // The regex fallback can't see DOM structure, so it can't tell chrome from
      // content — treat everything as content (the path filter still applies).
      links.push({ href: m[1], text: m[2].replace(/<[^>]+>/g, "").trim(), region: "content" });
    }
    return { title, links, base };
  }

  /**
   * SITEMAP import. Follows a sitemapindex one level down, which is how most
   * large sites actually publish (a small index pointing at many child sitemaps).
   */
  async function fromSitemap(page, sitemapUrl, { maxPages = 500, store, crawlId }) {
    const seen = new Set();
    const queue = [sitemapUrl];
    let level = 0;

    while (queue.length && level < 2 && state.running) {
      const batch = queue.splice(0, queue.length);
      level++;
      for (const sm of batch) {
        if (!state.running) break;
        state.currentUrl = sm;
        log(`Reading sitemap: ${sm}`);
        const res = await fetchUrl(page, sm);
        if (!res.body) {
          log(`  no content (status ${res.status})`);
          continue;
        }
        const { urls, nested } = parseSitemapXml(res.body);
        if (nested.length) {
          log(`  sitemap index: ${nested.length} nested sitemap(s)`);
          queue.push(...nested);
        }
        for (const raw of urls) {
          if (seen.size >= maxPages) break;
          const url = normalizeUrl(raw, sm);
          if (!url || seen.has(url) || DENY_URL.test(url) || SKIP_EXT.test(url)) continue;
          seen.add(url);
        }
        log(`  ${urls.length} URL(s) listed`);
      }
    }

    // A sitemap is a flat list. Rebuild a tree from the URL paths so the user
    // still gets structure to navigate — that's the whole point of the module.
    const sorted = [...seen].sort();
    for (const url of sorted) {
      const parent = findPathParent(url, seen);
      const depth = parent ? countSegments(url) : 0;
      store.upsertUrl(crawlId, { url, parentUrl: parent, depth, statusCode: null });
      state.discovered++;
    }
    log(`Imported ${sorted.length} URL(s) from sitemap.`);
  }

  /** BFS link discovery from a root URL. */
  async function fromCrawl(page, rootUrl, { maxPages = 100, maxDepth = 3, store, crawlId, confinePath = true, skipChrome = true, seedUrls = [] }) {
    const rootParsed = new URL(rootUrl);
    const origin = rootParsed.origin;

    // Confinement prefix: when confinePath is on, only follow links whose path
    // starts UNDER the root's directory. For a root of /ecare/products we confine
    // to /ecare/ (the containing section), so /ecare/orders and /ecare/profile
    // are in but /mobil, /internet, /tv (the marketing site) are out — even
    // though they're the same origin.
    const rawPath = rootParsed.pathname.replace(/\/+$/, "");           // strip trailing slash
    const segs = rawPath.split("/").filter(Boolean);
    // If root is a deep page (/ecare/products), confine to its parent section
    // (/ecare/). If root is already a section (/ecare), confine to that.
    const confineSegs = segs.length > 1 ? segs.slice(0, 1) : segs;      // top section
    const confinePrefix = confineSegs.length ? `/${confineSegs.join("/")}/` : "/";
    const underPrefix = (p) => {
      const path = p.endsWith("/") ? p : p + "/";
      return path.startsWith(confinePrefix) || p === confinePrefix.replace(/\/$/, "");
    };

    log(`Confinement: ${confinePath ? `path "${confinePrefix}"` : "whole domain"}${skipChrome ? ", skipping header/nav/footer links" : ""}.`);

    const seen = new Set([rootUrl]);
    const queue = [{ url: rootUrl, parent: null, depth: 0 }];

    store.upsertUrl(crawlId, { url: rootUrl, parentUrl: null, depth: 0 });
    state.discovered = 1;

    // Explicit seed URLs: guaranteed starting points. Even if a section is never
    // linked from a crawled page (only reachable via a button or JS action that
    // link-following can't see), listing it here crawls it directly and lets its
    // own subpages be discovered from there. Normalized and de-duplicated; each
    // still passes the same origin/confinement/deny checks as any other URL.
    for (const raw of Array.isArray(seedUrls) ? seedUrls : []) {
      const s = normalizeUrl(raw, rootUrl);
      if (!s || seen.has(s)) continue;
      if (new URL(s).origin !== origin) { log(`Seed skipped (off-site): ${raw}`); continue; }
      if (confinePath && !underPrefix(new URL(s).pathname)) { log(`Seed skipped (outside ${confinePrefix}): ${raw}`); continue; }
      seen.add(s);
      store.upsertUrl(crawlId, { url: s, parentUrl: rootUrl, depth: 1 });
      state.discovered++;
      queue.push({ url: s, parent: rootUrl, depth: 1 });
      log(`Seed added: ${s}`);
    }

    while (queue.length && state.running && state.discovered < maxPages) {
      const { url, depth } = queue.shift();
      state.queued = queue.length;
      state.currentUrl = url;

      // With a browser session, render the page and read the LIVE DOM — the only
      // way to discover links in a single-page app. Without one, fall back to the
      // raw fetch + HTML parse (fine for classic server-rendered sites).
      let title, links, status, contentType;
      if (page) {
        const r = await renderAndExtract(page, url);
        status = r.status; contentType = "text/html";
        title = r.title; links = r.links;
        store.upsertUrl(crawlId, { url, depth, title, statusCode: status, contentType });
        if (r.error) { log(`${url} — render failed: ${r.error.slice(0, 100)}`); continue; }
        log(`${url} — ${status} — ${links.length} link(s) [rendered]`);
      } else {
        const res = await fetchUrl(page, url);
        const isHtml = (res.contentType || "").includes("html");
        store.upsertUrl(crawlId, { url, depth, statusCode: res.status, contentType: res.contentType });
        if (!isHtml || !res.body) {
          log(`${url} — ${res.status || "no response"}${isHtml ? "" : " (not HTML, not expanded)"}`);
          continue;
        }
        const parsed = await parseHtml(page, res.body, url);
        title = parsed.title; links = parsed.links; status = res.status;
        store.upsertUrl(crawlId, { url, depth, title, statusCode: res.status, contentType: res.contentType });
        log(`${url} — ${res.status} — ${links.length} link(s)`);
      }

      if (depth >= maxDepth) continue;

      for (const { href, text, region } of links) {
        if (state.discovered >= maxPages) break;

        // Skip global site chrome (top header / primary nav / footer). Those
        // links lead out of the app area into the marketing site even when they
        // share the origin. In-app side menus live in the content region and are
        // tagged "content", so they still get followed.
        if (skipChrome && region === "chrome") continue;

        const child = normalizeUrl(href, url);
        if (!child) continue;
        if (new URL(child).origin !== origin) continue;          // stay on-site
        // Path confinement: stay under the root's section (e.g. /ecare/).
        if (confinePath && !underPrefix(new URL(child).pathname)) continue;
        if (SKIP_EXT.test(child)) continue;                       // assets, not pages
        if (DENY_URL.test(child) || DENY_TEXT.test(text)) {
          // Following a logout link mid-crawl would end the session the entire
          // scan depends on. Never do it, however it is labelled.
          continue;
        }
        if (seen.has(child)) continue;

        seen.add(child);
        store.upsertUrl(crawlId, { url: child, parentUrl: url, depth: depth + 1 });
        state.discovered++;
        queue.push({ url: child, parent: url, depth: depth + 1 });
      }
    }

    log(`Crawl finished: ${state.discovered} URL(s) discovered.`);
  }

  /** Plain URL list. Structure is inferred from the paths. */
  async function fromList(urls, { store, crawlId }) {
    const seen = new Set();
    for (const raw of urls) {
      const url = normalizeUrl(raw, urls[0]);
      if (url && !DENY_URL.test(url)) seen.add(url);
    }
    for (const url of [...seen].sort()) {
      const parent = findPathParent(url, seen);
      store.upsertUrl(crawlId, { url, parentUrl: parent, depth: parent ? countSegments(url) : 0 });
      state.discovered++;
    }
    log(`Imported ${seen.size} URL(s) from list.`);
  }

  async function start(page, opts) {
    if (state.running) throw new Error("A crawl is already running.");

    state.running = true;
    state.done = false;
    state.error = null;
    state.discovered = 0;
    state.queued = 0;
    state.log = [];
    state.crawlId = opts.crawlId;
    state.source = opts.source;

    try {
      if (opts.source === "sitemap") {
        await fromSitemap(page, opts.sitemapUrl, opts);
      } else if (opts.source === "list") {
        await fromList(opts.urls ?? [], opts);
      } else {
        await fromCrawl(page, opts.rootUrl, opts);
      }
      state.done = true;
    } catch (e) {
      state.error = String(e.message ?? e);
      log(`Crawl error: ${state.error}`);
    } finally {
      state.running = false;
      state.currentUrl = null;
    }
  }

  return { state, start, stop };
}

// --- path-based tree inference (for sitemap/list sources) --------------------
// A sitemap is flat. Users still need structure to navigate, so we derive the
// parent from the URL path: /shop/mobil/galaxy hangs under /shop/mobil if that
// exists, otherwise under /shop, otherwise at the root.
function countSegments(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function findPathParent(url, all) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = `${u.origin}/${parts.slice(0, i).join("/")}`;
    if (all.has(candidate)) return candidate;
  }
  const root = `${u.origin}/`;
  const rootNoSlash = u.origin;
  if (all.has(root) && root !== url) return root;
  if (all.has(rootNoSlash) && rootNoSlash !== url) return rootNoSlash;
  return null;
}
