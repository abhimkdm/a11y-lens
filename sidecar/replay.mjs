// A11y Lens replay engine.
//
// Turns a v2 recording (see recorder.mjs) back into browser actions. Three
// concerns, kept separate:
//
//   resolve()      — take a captured selector CHAIN and return a Playwright
//                    locator, walking the ranked tiers until exactly one element
//                    matches. Reports which tier won (xpath = accessibility smell).
//   replayStep()   — execute one action with the edge cases that actually bite:
//                    caused-vs-manual navigation, masked secrets, scroll-into-view,
//                    actionability timeouts, ambiguous matches, custom selects.
//   createReplayer — a stateful cursor exposing navigator(i) that drives the page
//                    to the i-th checkpoint, so the crawler can scan each state
//                    WITHOUT page.goto (the whole point on a SPA).
//
// Nothing here persists secrets. Masked steps carry no value and are skipped on
// replay because the QA's manual login already authenticated the shared context.

function escAttr(v) { return String(v).replace(/(["\\])/g, "\\$1"); }

// Build a Playwright locator for a single ranked selector entry.
function locatorFor(page, sel) {
  switch (sel.by) {
    case "testid":      return page.locator(`[${sel.attr || "data-testid"}="${escAttr(sel.value)}"]`);
    case "role":        return sel.name ? page.getByRole(sel.role, { name: sel.name }) : page.getByRole(sel.role);
    case "label":       return page.getByLabel(sel.value);
    case "placeholder": return page.getByPlaceholder(sel.value);
    case "text":        return page.getByText(sel.value);
    case "xpath":       return page.locator(`xpath=${sel.value}`);
    case "css":
    default:            return page.locator(sel.value);
  }
}

// Walk the chain: prefer the first tier that resolves to EXACTLY one element.
// Fall back to the first tier that resolves to >=1 (taking .first(), flagged
// ambiguous), and finally briefly wait for a specific (css/xpath) selector to
// attach in case the state is still rendering.
export async function resolve(page, target, { waitTimeout = 4000 } = {}) {
  const sels = (target && target.selectors) || [];
  let ambiguous = null;
  for (const sel of sels) {
    let loc;
    try { loc = locatorFor(page, sel); } catch { continue; }
    let count;
    try { count = await loc.count(); } catch { continue; }
    if (count === 1) return { loc, tier: sel.by, sel, ambiguous: false };
    if (count > 1 && !ambiguous) ambiguous = { loc: loc.first(), tier: sel.by, sel, ambiguous: true, count };
  }
  if (ambiguous) return ambiguous;
  for (const sel of sels.filter((s) => s.by === "css" || s.by === "xpath")) {
    try {
      const loc = locatorFor(page, sel).first();
      await loc.waitFor({ state: "attached", timeout: waitTimeout });
      return { loc, tier: sel.by, sel, ambiguous: false, waited: true };
    } catch { /* try next */ }
  }
  return null;
}

// Let a SPA settle after an action/navigation without hanging on a chatty page.
export async function settle(page, { timeout = 8000 } = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 2500) }).catch(() => {});
}

// Execute a single step. Returns { ok, tier, skipped?, smell? } or throws with
// { step, tier } attached so callers can report exactly where a journey broke.
export async function replayStep(page, step, { onLog = () => {}, onMasked = null, stepTimeout = 15000 } = {}) {
  const t = step.type;

  if (t === "navigate") {
    if (step.manual && /^https?:/.test(step.url || "")) {
      onLog(`navigate → ${step.url}`);
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: stepTimeout });
      await settle(page);
    } else {
      onLog("navigate (caused by prior action) → settling");
      await settle(page);
    }
    return { ok: true, tier: "navigate" };
  }

  if (step.masked && (t === "fill" || t === "upload")) {
    if (onMasked) { onLog("masked field — pausing for manual entry"); await onMasked(step); }
    else onLog("masked field — skipped (session already authenticated)");
    return { ok: true, skipped: true, tier: "masked" };
  }

  if (t === "press" && !step.target) {
    onLog(`press ${step.key} (no target — sending to focused element)`);
    await page.keyboard.press(step.key || "Enter");
    await settle(page, { timeout: 4000 });
    return { ok: true, tier: "keyboard" };
  }

  const found = await resolve(page, step.target);
  if (!found) {
    const desc = (step.target && (step.target.name || step.target.tag)) || t;
    throw Object.assign(new Error(`Could not locate element for ${t} ("${desc}")`), { step });
  }
  const { loc, tier, ambiguous } = found;
  const smell = tier === "xpath"; // fell through every stable/accessible tier
  if (ambiguous) onLog(`⚠ ${t}: selector "${tier}" matched multiple elements — using the first`);

  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    switch (t) {
      case "click":   await loc.click({ timeout: stepTimeout }); break;
      case "fill":    await loc.fill(step.value ?? "", { timeout: stepTimeout }); break;
      case "check":   await loc.check({ timeout: stepTimeout }).catch(() => loc.click({ timeout: stepTimeout })); break;
      case "uncheck": await loc.uncheck({ timeout: stepTimeout }).catch(() => loc.click({ timeout: stepTimeout })); break;
      case "press":   await loc.press(step.key || "Enter", { timeout: stepTimeout }); break;
      case "select": {
        const values = Array.isArray(step.values) ? step.values : [];
        const labels = Array.isArray(step.labels) ? step.labels : [];
        try {
          if (values.length) await loc.selectOption(values.map((v) => ({ value: v })), { timeout: stepTimeout });
          else if (labels.length) await loc.selectOption({ label: labels[0] }, { timeout: stepTimeout });
        } catch (e) {
          // Custom (non-native) combobox: open it and click the option by text.
          onLog(`select fell back to click-by-label ("${labels[0] ?? values[0] ?? ""}")`);
          await loc.click({ timeout: stepTimeout }).catch(() => {});
          const opt = page.getByRole("option", { name: labels[0] ?? values[0] ?? "" });
          await opt.first().click({ timeout: 4000 }).catch(() => {});
        }
        break;
      }
      case "upload":  onLog("upload step skipped (file inputs are not replayable)"); return { ok: true, skipped: true, tier };
      default:        onLog(`unknown step type: ${t} — skipped`); return { ok: true, skipped: true, tier };
    }
  } catch (e) {
    throw Object.assign(new Error(`${t} failed via ${tier}: ${String(e.message ?? e).slice(0, 140)}`), { step, tier });
  }
  await settle(page, { timeout: 4000 });
  return { ok: true, tier, smell };
}

// Reject anything that is not one of our recordings, and DEFENSIVELY strip any
// value from masked steps — an imported file must never re-introduce a secret,
// no matter what it claims to contain.
export function validateRecording(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Not a recording object.");
  if (obj.kind !== "a11y-lens-recording") throw new Error("Unrecognized file — missing the a11y-lens-recording marker.");
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) throw new Error("Recording has no steps.");
  for (const s of obj.steps) { if (s && s.masked) delete s.value; }
  return obj;
}

// Stateful replayer. navigator(i, page) advances from wherever the cursor is up
// to (and including) the i-th checkpoint step, then returns the resulting state
// for the crawler to scan. Smells encountered on the way are attached so the
// crawler can promote them to WCAG 4.1.2 findings at that checkpoint.
export function createReplayer(recording, { onLog = () => {}, onMasked = null } = {}) {
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  let checkpoints = (Array.isArray(recording.checkpoints) && recording.checkpoints.length)
    ? recording.checkpoints.slice()
    : steps.filter((s) => s.checkpoint).map((s) => s.i);
  // Guarantee the final state is scanned even if it was not marked.
  if (steps.length) {
    const lastIdx = steps[steps.length - 1].i;
    if (!checkpoints.includes(lastIdx)) checkpoints.push(lastIdx);
  }
  checkpoints = Array.from(new Set(checkpoints)).sort((a, b) => a - b);

  let cursor = 0; // index into steps[]
  const state = { checkpointCount: checkpoints.length, done: false, allSmells: [] };

  async function advanceTo(page, targetStepIndex) {
    const smells = [];
    while (cursor < steps.length && steps[cursor].i <= targetStepIndex) {
      const step = steps[cursor];
      cursor++;
      const res = await replayStep(page, step, { onLog, onMasked });
      if (res && res.smell) { smells.push(step); state.allSmells.push(step); }
    }
    return smells;
  }

  async function navigator(i, page) {
    const ci = checkpoints[i];
    if (ci == null) { state.done = true; return null; }
    const smells = await advanceTo(page, ci);
    const url = page.url();
    const title = await page.title().catch(() => "");
    if (i === checkpoints.length - 1) state.done = true;
    return { url, title, checkpointStep: ci, smells };
  }

  return { navigator, state, checkpointCount: checkpoints.length };
}

// Reproduce-only mode: drive every step start to finish, no scanning. Returns a
// summary QA can use to see whether the path still works and where it's fragile.
export async function replayAll(page, recording, { onLog = () => {}, onMasked = null } = {}) {
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  const summary = { executed: 0, skipped: 0, smells: [], failedAt: null, tiers: {} };
  for (const step of steps) {
    try {
      const res = await replayStep(page, step, { onLog, onMasked });
      if (res.skipped) summary.skipped++; else summary.executed++;
      if (res.tier) summary.tiers[res.tier] = (summary.tiers[res.tier] || 0) + 1;
      if (res.smell) summary.smells.push({ i: step.i, type: step.type, name: step.target?.name || "" });
    } catch (e) {
      summary.failedAt = { i: step.i, type: step.type, error: String(e.message ?? e) };
      onLog(`✗ replay stopped at step ${step.i} (${step.type}): ${String(e.message ?? e)}`);
      break;
    }
  }
  return summary;
}

// Synthetic finding for a step that could only be replayed via XPath — i.e. the
// control has no test id, role, accessible name or text. Brittle to automate AND
// invisible to assistive tech, so it is a genuine WCAG 4.1.2 (Name, Role, Value)
// concern, reported at the checkpoint where it occurred.
export function smellToFinding(step) {
  const xp = step.target?.selectors?.find((s) => s.by === "xpath")?.value || "";
  return {
    id: "replay-no-accessible-selector",
    source: "replay",
    impact: "moderate",
    description: "Interactive control has no stable or accessible identifier",
    help: "Replay could only find this element by brittle XPath because it exposes no role + accessible name, no label, and no test id. Assistive technology has the same problem. Give it a proper role and accessible name (or at minimum a stable data-testid).",
    evidence: `${step.type} on <${step.target?.tag || "?"}>${step.target?.name ? ` "${step.target.name}"` : " (no accessible name)"}`,
    wcag: ["4.1.2"],
    nodes: [{ target: xp, html: "" }],
  };
}
