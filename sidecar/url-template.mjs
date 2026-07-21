// Dynamic URL handling.
//
// Enterprise SPAs route on entity ids: /customer/12345, /orders/ABC-123,
// /products/987/details. A recording that stores the literal URL replays once and
// then fails forever, because the id it captured belonged to that session's data.
//
// This module turns a concrete URL into an abstraction that survives:
//
//   /customer/12345?tab=billing&utm_source=mail
//     -> template  /customer/{id}
//        regex     ^/customer/[^/]+$
//        params    { id: "12345" }
//        query     { tab: "billing" }        (tracking noise dropped)
//
// Replay then validates by template rather than by string equality, and healing
// can recognise /customers/12345 as the same route renamed.

// Query keys that change every request and mean nothing on replay. Matching on
// them would make every navigation look like a different page.
const UNSTABLE_QUERY = [
  /^utm_/i, /^ga_/i, /^_ga/i,
  /^(timestamp|ts|time|_)$/i,
  /^(sessionid|session|sid|jsessionid)$/i,
  /^(token|access_token|id_token|auth|authorization|jwt)$/i,
  /^(nonce|state|csrf|xsrf)$/i,
  /^(cachebuster|cb|v|version|rand|r)$/i,
  /^(gclid|fbclid|msclkid|mc_cid|mc_eid|igshid)$/i,
  /^(tracking|trk|ref|referrer|source)$/i,
  /^correlationid$/i,
];

export function isUnstableParam(key) {
  return UNSTABLE_QUERY.some((re) => re.test(key));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEXID_RE = /^[0-9a-f]{16,}$/i;

// Is this path segment an identifier rather than a route word?
// Deliberately conservative: a wrong guess here turns a real route segment into a
// wildcard and makes every page look like the same page.
export function classifySegment(seg, prevSeg = "") {
  if (!seg) return null;
  if (UUID_RE.test(seg)) return { kind: "uuid", name: nameFor(prevSeg, "uuid") };
  if (DATE_RE.test(seg)) return { kind: "date", name: "date" };
  if (/^\d+$/.test(seg)) return { kind: "id", name: nameFor(prevSeg, "id") };
  if (HEXID_RE.test(seg)) return { kind: "entityId", name: nameFor(prevSeg, "entityId") };
  // Mixed alphanumeric with digits and no vowel-ish word shape: ABC-123, X7K9P2
  if (/\d/.test(seg) && /^[A-Za-z0-9._-]+$/.test(seg) && seg.length >= 4) {
    const letters = seg.replace(/[^A-Za-z]/g, "");
    const digits = seg.replace(/\D/g, "");
    if (digits.length >= 2 && (letters.length === 0 || digits.length >= letters.length / 2)) {
      return { kind: "entityId", name: nameFor(prevSeg, "entityId") };
    }
  }

  // Short codes under a collection: /orders/A-7, /items/x9. On their own these are
  // too weak to call an id — but the preceding segment being a plural collection
  // is strong context, and a digit is still required so route words like
  // /orders/summary are never mistaken for ids.
  if (/\d/.test(seg) && /^[A-Za-z0-9._-]{1,24}$/.test(seg) && isCollection(prevSeg)) {
    return { kind: "entityId", name: nameFor(prevSeg, "entityId") };
  }
  return null;
}

// A path segment that reads like a collection ("orders", "customers", "items"),
// which makes the segment after it very likely an identifier.
function isCollection(seg) {
  if (!seg || !/^[A-Za-z][A-Za-z-]{2,}$/.test(seg)) return false;
  return /(s|list|search|index)$/i.test(seg) && !/(details|status|address|settings|preferences|analytics)$/i.test(seg);
}

// Name the parameter after the collection that precedes it: /customer/123 -> customerId.
function nameFor(prevSeg, fallback) {
  if (!prevSeg || !/^[A-Za-z][A-Za-z-]*$/.test(prevSeg)) return fallback;
  let base = prevSeg.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  base = base.replace(/(ies)$/i, "y").replace(/(ses|xes|zes|ches|shes)$/i, "").replace(/s$/i, "");
  if (!base) return fallback;
  return base + (fallback === "uuid" ? "Uuid" : "Id");
}

// Turn a URL into { actualUrl, pathTemplate, regexPattern, params, query, origin }.
export function templatize(rawUrl, opts = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return { actualUrl: String(rawUrl || ""), pathTemplate: null, regexPattern: null, params: {}, query: {} }; }

  const segs = u.pathname.split("/").filter((s) => s !== "");
  const params = {};
  const used = new Map();
  const outSegs = segs.map((seg, i) => {
    const decoded = safeDecode(seg);
    const cls = classifySegment(decoded, segs[i - 1] ? safeDecode(segs[i - 1]) : "");
    if (!cls) return seg;
    // Disambiguate repeats: /a/1/b/2 -> /a/{aId}/b/{bId}; same name twice -> id2
    let name = cls.name;
    const n = (used.get(name) || 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}${n}`;
    params[name] = decoded;
    return `{${name}}`;
  });

  const pathTemplate = "/" + outSegs.join("/");
  const query = {};
  for (const [k, v] of u.searchParams.entries()) {
    if (isUnstableParam(k)) continue;
    if (opts.ignoreQuery) continue;
    query[k] = v;
  }

  return {
    actualUrl: u.href,
    origin: u.origin,
    pathTemplate: Object.keys(params).length ? pathTemplate : u.pathname || "/",
    regexPattern: toRegexSource(outSegs),
    params,
    query,
    hasParams: Object.keys(params).length > 0,
  };
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

function toRegexSource(outSegs) {
  const body = outSegs
    .map((s) => (s.startsWith("{") && s.endsWith("}") ? "[^/]+" : escapeRe(s)))
    .join("/");
  return `^/${body}/?$`;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Fill a template from a variable store: /customer/{customerId} -> /customer/9911
export function expandTemplate(template, vars = {}) {
  if (!template) return null;
  let missing = false;
  const out = template.replace(/\{([^}]+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === "") { missing = true; return `{${k}}`; }
    return encodeURIComponent(String(v));
  });
  return missing ? null : out;
}

export function matchesTemplate(url, meta) {
  if (!meta) return false;
  let path;
  try { path = new URL(url).pathname; } catch { return false; }
  if (meta.regexPattern) {
    try { if (new RegExp(meta.regexPattern).test(path)) return true; } catch { /* fall through */ }
  }
  return meta.pathTemplate ? path === meta.pathTemplate : false;
}

// 0..1 similarity between two paths, segment-aware. Used for URL healing when a
// route is renamed (/customer/{id} -> /customers/{id}).
export function pathSimilarity(a, b) {
  const A = String(a || "").split("/").filter(Boolean);
  const B = String(b || "").split("/").filter(Boolean);
  if (!A.length && !B.length) return 1;
  const len = Math.max(A.length, B.length);
  let score = 0;
  for (let i = 0; i < len; i++) {
    const x = A[i], y = B[i];
    if (x === undefined || y === undefined) continue;
    const xp = x.startsWith("{"), yp = y.startsWith("{");
    if (xp && yp) { score += 1; continue; }        // both parameters
    if (x === y) { score += 1; continue; }
    score += wordSimilarity(x, y) * 0.9;           // renamed segment, still close
  }
  return score / len;
}

function wordSimilarity(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  if (a === b) return 1;
  // singular/plural and simple renames
  const sa = a.replace(/(ies)$/, "y").replace(/s$/, "");
  const sb = b.replace(/(ies)$/, "y").replace(/s$/, "");
  if (sa === sb) return 0.95;
  if (a.startsWith(b) || b.startsWith(a)) return 0.8;
  const bg = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = bg(a), gb = bg(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size);
}

// Confidence that `candidate` is the recorded route, on the review's weights:
// route name 40, path template 25, URL similarity 15, heading 10, fingerprint 10.
export function scoreUrlMatch(recorded, candidate) {
  let score = 0, max = 0;
  const add = (w, v) => { max += w; score += w * v; };

  const rn = recorded?.routeName, cn = candidate?.routeName;
  if (rn || cn) add(40, rn && cn ? (String(rn) === String(cn) ? 1 : wordSimilarity(rn, cn)) : 0);

  const rt = recorded?.pathTemplate, ct = candidate?.pathTemplate;
  if (rt || ct) add(25, rt && ct ? (rt === ct ? 1 : pathSimilarity(rt, ct)) : 0);

  add(15, pathSimilarity(pathOf(recorded?.actualUrl) || rt, pathOf(candidate?.actualUrl) || ct));

  const rh = recorded?.heading, ch = candidate?.heading;
  if (rh || ch) add(10, rh && ch ? wordSimilarity(rh, ch) : 0);

  const rf = recorded?.fingerprintHits, cf = candidate?.fingerprintHits;
  if (typeof rf === "number" || typeof cf === "number") {
    add(10, typeof cf === "number" && rf ? Math.min(1, cf / Math.max(1, rf)) : 0);
  }

  return max ? Math.round((score / max) * 100) : 0;
}

function pathOf(url) { try { return new URL(url).pathname; } catch { return url || ""; } }

// Swap the origin so a journey recorded on dev replays on qa or prod unchanged.
export function rebaseUrl(url, newOrigin) {
  if (!newOrigin) return url;
  try {
    const u = new URL(url);
    const o = new URL(newOrigin);
    u.protocol = o.protocol; u.host = o.host;
    return u.href;
  } catch { return url; }
}

// The navigation target for a recorded step, in the review's priority order:
// route name -> template (+ variables) -> regex -> base -> exact.
export function resolveNavigationTarget(meta, { vars = {}, origin = "" } = {}) {
  if (!meta) return { url: null, strategy: "none" };

  if (meta.pathTemplate && meta.hasParams) {
    const filled = expandTemplate(meta.pathTemplate, { ...meta.params, ...vars });
    if (filled) {
      const qs = buildQuery(meta.query);
      const base = origin || meta.origin || "";
      return { url: `${base}${filled}${qs}`, strategy: vars && Object.keys(vars).length ? "template+variables" : "template" };
    }
  }
  const base = origin || meta.origin || "";
  if (meta.pathTemplate && !meta.hasParams) {
    return { url: `${base}${meta.pathTemplate}${buildQuery(meta.query)}`, strategy: "path" };
  }
  return { url: origin ? rebaseUrl(meta.actualUrl, origin) : meta.actualUrl, strategy: "exact" };
}

function buildQuery(query) {
  const q = Object.entries(query || {});
  if (!q.length) return "";
  return "?" + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

// Journey variable store: ids captured during a run, reused by later steps.
export function createVariableStore(initial = {}) {
  const vars = { ...initial };
  return {
    get all() { return { ...vars }; },
    get(name) { return vars[name]; },
    set(name, value) { if (name && value !== undefined && value !== null && value !== "") vars[name] = String(value); },
    // Learn from a URL the app actually navigated to: /customer/9911 after a
    // create flow means customerId is now 9911 for every later step.
    learnFrom(url) {
      const meta = templatize(url);
      const learned = {};
      for (const [k, v] of Object.entries(meta.params || {})) {
        if (vars[k] !== v) learned[k] = v;
        vars[k] = v;
      }
      return learned;
    },
    clear() { for (const k of Object.keys(vars)) delete vars[k]; },
  };
}
