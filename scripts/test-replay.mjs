// Mock-based tests for the recorder/replay engine. No Chromium: we fake the
// Playwright page + locator surface and assert the resolver tiering, edge-case
// handling, checkpoint navigation, secret hygiene, and smell detection.
import { resolve, replayStep, createReplayer, replayAll, validateRecording, smellToFinding } from "../sidecar/replay.mjs";

let PASS = true;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) PASS = false; };

// ---- fake Playwright surface ---------------------------------------------
// keyFor mirrors how replay.mjs's locatorFor turns a selector into a locator.
function keyFor(sel) {
  switch (sel.by) {
    case "testid": return `[${sel.attr || "data-testid"}="${sel.value}"]`;
    case "role": return `role:${sel.role}:${sel.name || ""}`;
    case "label": return `label:${sel.value}`;
    case "placeholder": return `placeholder:${sel.value}`;
    case "text": return `text:${sel.value}`;
    case "xpath": return `xpath=${sel.value}`;
    default: return sel.value; // css
  }
}
function makePage(counts, attachable = new Set(), calls = null) {
  const loc = (key) => ({
    _key: key,
    async count() { return counts[key] ?? 0; },
    first() { return loc(key); },
    async waitFor() { if (attachable.has(key)) return; throw new Error("not attached"); },
    async scrollIntoViewIfNeeded() {},
    async click() { calls && calls.push(["click", key]); },
    async fill(v) { calls && calls.push(["fill", key, v]); },
    async check() { calls && calls.push(["check", key]); },
    async uncheck() { calls && calls.push(["uncheck", key]); },
    async press(k) { calls && calls.push(["press", key, k]); },
    async selectOption(o) { calls && calls.push(["select", key, JSON.stringify(o)]); },
  });
  return {
    _url: "https://app.test/start",
    url() { return this._url; },
    async title() { return "T"; },
    locator: (s) => loc(s.startsWith("xpath=") ? s : s),
    getByRole: (r, o = {}) => loc(`role:${r}:${o.name || ""}`),
    getByLabel: (v) => loc(`label:${v}`),
    getByPlaceholder: (v) => loc(`placeholder:${v}`),
    getByText: (v) => loc(`text:${v}`),
    async goto(u) { calls && calls.push(["goto", u]); this._url = u; },
    async waitForLoadState() {},
    keyboard: { async press(k) { calls && calls.push(["kb", k]); } },
  };
}

// ---- 1. resolver tiering --------------------------------------------------
{
  const target = { selectors: [
    { by: "testid", attr: "data-testid", value: "missing" }, // 0
    { by: "role", role: "button", name: "Checkout" },        // 1  <-- should win
    { by: "xpath", value: "/html/body/button[1]" },          // 1
  ]};
  const page = makePage({ [keyFor(target.selectors[0])]: 0, [keyFor(target.selectors[1])]: 1, [keyFor(target.selectors[2])]: 1 });
  const r = await resolve(page, target);
  check(r && r.tier === "role", `resolver prefers role over xpath (got ${r && r.tier})`);
}
{
  const target = { selectors: [
    { by: "role", role: "button", name: "Save" }, // 2 (ambiguous)
    { by: "css", value: "#save-btn" },             // 1  <-- should win
  ]};
  const page = makePage({ "role:button:Save": 2, "#save-btn": 1 });
  const r = await resolve(page, target);
  check(r && r.tier === "css" && !r.ambiguous, `resolver skips ambiguous role for unique css (got ${r && r.tier})`);
}
{
  const target = { selectors: [{ by: "role", role: "link", name: "Home" }] }; // 3 everywhere
  const page = makePage({ "role:link:Home": 3 });
  const r = await resolve(page, target);
  check(r && r.ambiguous && r.tier === "role", "resolver returns ambiguous .first() when nothing is unique");
}
{
  const target = { selectors: [{ by: "css", value: ".late" }] }; // count 0 but attaches after wait
  const page = makePage({ ".late": 0 }, new Set([".late"]));
  const r = await resolve(page, target);
  check(r && r.waited && r.tier === "css", "resolver waits for a slow-rendering element (SPA)");
}
{
  const target = { selectors: [{ by: "css", value: ".nope" }] };
  const page = makePage({ ".nope": 0 });
  const r = await resolve(page, target);
  check(r === null, "resolver returns null when nothing resolves");
}

// ---- 2. replayStep edge cases --------------------------------------------
{
  const calls = [];
  const page = makePage({}, new Set(), calls);
  await replayStep(page, { type: "navigate", url: "https://app.test/login", manual: true });
  check(calls.some(c => c[0] === "goto"), "manual navigate performs goto");
}
{
  const calls = [];
  const page = makePage({}, new Set(), calls);
  await replayStep(page, { type: "navigate", url: "https://app.test/cart", manual: false, caused: true });
  check(!calls.some(c => c[0] === "goto"), "caused navigate does NOT goto (avoids double-nav on SPA)");
}
{
  const calls = [];
  const page = makePage({}, new Set(), calls);
  const res = await replayStep(page, { type: "fill", masked: true, target: { selectors: [{ by: "css", value: "#pw" }] } });
  check(res.skipped && !calls.some(c => c[0] === "fill"), "masked fill is skipped and never typed");
}
{
  const calls = [];
  const t = { selectors: [{ by: "xpath", value: "/html/body/div[3]/span[2]" }] };
  const page = makePage({ "xpath=/html/body/div[3]/span[2]": 1 }, new Set(), calls);
  const res = await replayStep(page, { type: "click", target: t });
  check(res.smell === true, "click that only resolves via XPath is flagged as an a11y smell");
  check(calls.some(c => c[0] === "click"), "…and the click still executes");
}
{
  const calls = [];
  const page = makePage({}, new Set(), calls);
  const res = await replayStep(page, { type: "press", key: "Enter", target: null });
  check(calls.some(c => c[0] === "kb" && c[1] === "Enter"), "press with no target goes to keyboard");
}
{
  let threw = false;
  const page = makePage({ "#gone": 0 });
  try { await replayStep(page, { type: "click", target: { selectors: [{ by: "css", value: "#gone" }] } }); }
  catch (e) { threw = !!e.step; }
  check(threw, "unresolvable step throws with the step attached for diagnostics");
}

// ---- 3. checkpoint navigator ---------------------------------------------
{
  const recording = { steps: [
    { i: 0, type: "navigate", url: "https://app.test/", manual: true, checkpoint: true },
    { i: 1, type: "click", target: { selectors: [{ by: "role", role: "button", name: "Menu" }] } },
    { i: 2, type: "click", target: { selectors: [{ by: "xpath", value: "/html/body/a[1]" }] }, checkpoint: true },
  ], checkpoints: [0, 2] };
  const calls = [];
  const page = makePage({ "role:button:Menu": 1, "xpath=/html/body/a[1]": 1 }, new Set(), calls);
  const rp = createReplayer(recording);
  check(rp.checkpointCount === 2, "replayer sees 2 checkpoints");
  const n0 = await rp.navigator(0, page);
  check(calls.filter(c => c[0] === "goto").length === 1 && calls.filter(c => c[0] === "click").length === 0, "checkpoint 0 runs the navigate only");
  const n1 = await rp.navigator(1, page);
  check(calls.filter(c => c[0] === "click").length === 2, "checkpoint 1 drives both clicks to reach the state");
  check(n1.smells.length === 1, "the XPath-only click is reported as a smell at its checkpoint");
  check(rp.state.done === true, "replayer marks done after the last checkpoint");
}

// ---- 4. import validation + secret hygiene --------------------------------
{
  let rejected = false;
  try { validateRecording({ kind: "something-else", steps: [{}] }); } catch { rejected = true; }
  check(rejected, "validateRecording rejects a file without our marker");

  const dirty = { kind: "a11y-lens-recording", steps: [
    { i: 0, type: "fill", masked: true, value: "hunter2-should-be-stripped" },
    { i: 1, type: "fill", value: "public@example.com" },
  ]};
  const cleaned = validateRecording(dirty);
  check(cleaned.steps[0].value === undefined, "import strips any value from masked steps (secret hygiene)");
  check(cleaned.steps[1].value === "public@example.com", "…but keeps non-masked values");
}

// ---- 5. reproduce-mode summary + smell finding ----------------------------
{
  const recording = { steps: [
    { i: 0, type: "navigate", url: "https://app.test/", manual: true },
    { i: 1, type: "fill", target: { selectors: [{ by: "label", value: "Email" }] }, value: "a@b.c" },
    { i: 2, type: "fill", masked: true, target: { selectors: [{ by: "css", value: "#pw" }] } },
    { i: 3, type: "click", target: { selectors: [{ by: "xpath", value: "/html/body/button[1]" }] } },
  ]};
  const page = makePage({ "label:Email": 1, "xpath=/html/body/button[1]": 1 }, new Set());
  const s = await replayAll(page, recording, {});
  check(s.failedAt === null, "reproduce mode completes a clean path");
  check(s.skipped === 1, "reproduce mode counts the masked field as skipped");
  check(s.smells.length === 1, "reproduce mode surfaces the XPath-only control as a smell");

  const f = smellToFinding(recording.steps[3]);
  check(f.wcag.includes("4.1.2") && f.source === "replay", "smellToFinding maps to WCAG 4.1.2 with source=replay");
}

console.log(PASS ? "\nALL REPLAY TESTS PASSED" : "\nSOME REPLAY TESTS FAILED");
process.exit(PASS ? 0 : 1);
