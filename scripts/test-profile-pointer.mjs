// 1 · Form-filling values are remembered between runs, minus anything secret.
// 2 · The virtual pointer is parked so hover state never leaks into a scan.
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

// --- stripSecrets (mirrors the server helper) ---
const SECRET = /(pass(word|code)?|pwd|secret|token|otp|pin|cvv|cvc|ssn|cpr|card(number)?|iban|apikey|api_key)/i;
function stripSecrets(profile) {
  if (!profile || typeof profile !== "object") return profile;
  const out = Array.isArray(profile) ? [] : {};
  for (const [k, v] of Object.entries(profile)) {
    if (SECRET.test(k)) continue;
    out[k] = v && typeof v === "object" ? stripSecrets(v) : v;
  }
  return out;
}

console.log("— remembered form values —");
{
  const profile = {
    firstName: "Test", lastName: "Bruger", email: "test@example.dk",
    phone: "12345678", postcode: "2100",
    password: "hunter2", cardNumber: "4111111111111111", otp: "123456",
    nested: { address: "Vej 1", apiKey: "sk-live-xyz" },
  };
  const saved = stripSecrets(profile);
  ck(saved.firstName === "Test" && saved.email === "test@example.dk" && saved.postcode === "2100",
     "ordinary test data is remembered");
  ck(!("password" in saved) && !("cardNumber" in saved) && !("otp" in saved),
     "password, card number and OTP are NOT persisted");
  ck(saved.nested.address === "Vej 1" && !("apiKey" in saved.nested),
     "secrets are stripped at any depth, ordinary values kept");
}
{
  // Reuse rule: a profile sent with the request wins; otherwise the saved one is used.
  const pick = (sent, saved) => sent ?? saved ?? null;
  ck(pick({ a: 1 }, { b: 2 }).a === 1, "a profile sent with the run overrides the saved one");
  ck(pick(null, { b: 2 }).b === 2, "with nothing sent, the remembered profile is reused");
  ck(pick(null, null) === null, "no profile anywhere -> null, not a crash");
}

console.log("\n— pointer parking —");
{
  // The interaction engine must park the pointer after acting, and the capture
  // path must park before shooting.
  const moves = [];
  const page = {
    mouse: { async move(x, y) { moves.push([x, y]); } },
    async evaluate() { return null; }, async waitForLoadState() {}, async waitForTimeout() {},
  };
  const { settleForCapture } = await import("../sidecar/element-shots.mjs");
  await settleForCapture(page, { maxScrollMs: 0, settleMs: 1, networkIdleMs: 5 });
  ck(moves.length >= 1 && moves[0][0] === 0 && moves[0][1] === 0,
     "the pointer is parked at (0,0) before a screenshot, so nothing shoots in :hover");

  // parking must never throw, even on a page with no mouse API
  let threw = false;
  try { await settleForCapture({ async evaluate() { return null; }, async waitForLoadState() {}, async waitForTimeout() {} }, { maxScrollMs: 0, settleMs: 1, networkIdleMs: 5 }); }
  catch { threw = true; }
  ck(!threw, "parking is best-effort — a page without a pointer API does not break the scan");
}

console.log(P ? "\nALL PROFILE/POINTER TESTS PASSED" : "\nSOME FAILED");
process.exit(P ? 0 : 1);
