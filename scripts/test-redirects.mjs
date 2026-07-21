// The redirect decisions a URL-list scan has to make, using the real shapes from
// the ECom/ECare list (login-gated pages, canonical redirects, dead routes).
const AUTH_RE = /(^|\/)(login|signin|sign-in|log-in|auth|sso|oauth|account\/login|logon|identity|adfs|saml)(\/|$|\?)/i;
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

console.log("— auth detection —");
for (const p of ["/login", "/ecare/login", "/auth/signin", "/sso/redirect", "/identity/logon", "/saml/acs"])
  ck(AUTH_RE.test(p), `"${p}" recognised as an auth redirect`);
for (const p of ["/ecare/finance/5070001077/invoices", "/shop/kurv", "/ecare/products/abc/settings", "/authors"])
  ck(!AUTH_RE.test(p), `"${p}" NOT mistaken for auth`);

console.log("\n— decision table —");
function decide(requested, landed, visited = new Set()) {
  const r = new URL(requested), l = new URL(landed);
  if (r.origin === l.origin && r.pathname === l.pathname) return "scan";
  if (AUTH_RE.test(l.pathname)) return "skip-auth";
  if (visited.has(l.origin + l.pathname)) return "skip-duplicate";
  return "scan-destination";
}
const B = "https://portal.test";
ck(decide(`${B}/shop/kurv`, `${B}/shop/kurv`) === "scan", "arrived where asked -> scan");
ck(decide(`${B}/ecare/finance/123/invoices`, `${B}/login?returnUrl=%2Fecare`) === "skip-auth",
   "session gone -> skip, do NOT record the login page as that route");
ck(decide(`${B}/shop/tv`, `${B}/shop/tv-pakker`) === "scan-destination",
   "canonical redirect -> scan the destination and record it under the real URL");
ck(decide(`${B}/shop/internet`, `${B}/shop/tv-pakker`, new Set([`${B}/shop/tv-pakker`])) === "skip-duplicate",
   "two URLs collapsing to one destination -> scanned once, not twice");

console.log("\n— the failure this prevents —");
const urls = Array.from({ length: 37 }, (_, i) => `${B}/ecare/page-${i}`);
let scanned = 0, skipped = 0, authHits = 0, stopped = false;
for (const u of urls) {
  const d = decide(u, `${B}/login`);            // every page bounces: session expired
  if (d === "skip-auth") { skipped++; authHits++; if (authHits >= 3) { stopped = true; break; } }
  else scanned++;
}
ck(scanned === 0, "with an expired session, ZERO login pages are recorded as real pages");
ck(stopped, "the run stops after 3 auth redirects instead of grinding through all 37");
console.log(`      (old behaviour would have reported 37 pages scanned — all of them the login screen)`);

console.log(P ? "\nALL REDIRECT TESTS PASSED" : "\nFAILED");
process.exit(P ? 0 : 1);
