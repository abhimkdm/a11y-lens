// A11y Lens — Interaction scanning engine.
//
// WHY THIS EXISTS
// A static scan sees the page as it loads. The most severe accessibility
// defects are not there — they appear only after a human interacts: a modal
// that traps focus and never returns it, a custom dropdown whose options a
// screen reader never announces, a form whose validation errors are shown in
// red but never surfaced to assistive tech. This module drives those
// interactions so the scan can see the states behind them.
//
// WHY IT IS A SEPARATE MODULE (not folded into the crawler's loop)
// The crawler is navigation-only by construction, and that property is the
// backbone of its safety story — it can be pointed at a logged-in production
// app because it never activates anything that mutates state. Interaction
// breaks that invariant on purpose, so ALL of the state-changing, form-filling,
// submit-clicking logic lives HERE, in one auditable place, behind explicit
// gates — rather than being smeared through the crawler where the safety
// reasoning would be hard to follow.
//
// TWO GEARS, BOUND TO THE ENVIRONMENT
//   EXPLORE (default, safe on production):
//     Autonomously opens state-revealing UI — dropdowns, modals, accordions,
//     tabs, tooltips, comboboxes — focuses fields, and triggers validation by
//     submitting EMPTY forms and by focus-then-blur. Scans each revealed state,
//     then REVERSES it (Escape / close / collapse) and moves on. It never types
//     real data and never fires a mutating submit, so it cannot change server
//     state. This is genuinely autonomous; it simply treats "submit real data"
//     as out of scope rather than something to guess at.
//
//   OPERATE (staging only, opt-in):
//     Unlocked ONLY when the caller passes allowMutations:true — which the
//     server sets solely from a per-run, non-sticky "this is staging, allow
//     mutations" flag. Fills fields from the caller's value profile; for fields
//     the profile doesn't cover, it generates a SAFE SYNTHETIC value typed to
//     the input and logs exactly what it used. Then it clicks through submits.
//
// The DENY list below is a floor, not the ceiling of safety: in Explore gear
// nothing destructive can fire because submits are empty and reversed. In
// Operate gear the human-set flag is the primary gate and DENY is a second
// layer that still refuses the classic destructive labels even on staging
// (delete/pay/purchase), because "disposable data" rarely means "fine to
// delete the account we're testing with".

const DENY = /\b(delete|remove|destroy|pay|payment|purchase|buy|checkout|order now|place order|approve|reject|deny|logout|log out|sign out|signout|deactivate|unsubscribe|transfer|withdraw|wire|refund|charge)\b/i;

// Fields we never fill or focus in a way that could submit them, even in
// Operate gear — typing into these has real-world consequences a staging flag
// doesn't cover (an OTP box wired to send an SMS, a real card field).
const SENSITIVE_FIELD = /\b(card|cc-number|cardnumber|cvv|cvc|ssn|social|otp|2fa|mfa|passcode|routing|account.?number|iban)\b/i;

// ---------------------------------------------------------------------------
// Synthetic values (Operate gear, for fields not in the caller's profile).
// Typed to the input so validation passes rather than tripping a format error —
// the point is to REACH the next state, not to test the validator.
// ---------------------------------------------------------------------------
export function syntheticValue(field) {
  const type = (field.type || "").toLowerCase();
  const name = `${field.name || ""} ${field.id || ""} ${field.placeholder || ""} ${field.ariaLabel || ""}`.toLowerCase();

  if (type === "email" || /e-?mail/.test(name)) return "test@staging.example.com";
  if (type === "tel" || /phone|mobile|tel\b/.test(name)) return "5555550100";
  if (type === "url" || /website|url\b/.test(name)) return "https://staging.example.com";
  if (type === "number" || /qty|quantity|amount|count|age/.test(name)) return "1";
  if (type === "date") return "2026-01-01";
  if (type === "password") return "Test-Passw0rd!";  // a value that satisfies common strength rules
  if (/zip|postal/.test(name)) return "94103";
  if (/first.?name/.test(name)) return "Test";
  if (/last.?name|surname/.test(name)) return "User";
  if (/\bname\b/.test(name)) return "Test User";
  if (/city/.test(name)) return "Springfield";
  if (/search|query|q\b/.test(name)) return "test query";
  if (/message|comment|note|description|bio/.test(name)) return "Lorem ipsum test content.";
  return "Lorem";
}

// ---------------------------------------------------------------------------
// Discover candidate interactive elements IN the page. Read-only: reports what
// is there and its current ARIA state; changes nothing.
// ---------------------------------------------------------------------------
export function discoverInteractive() {
  const out = [];
  const seen = new Set();
  const push = (el, kind) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;               // not visible
    const label = (el.getAttribute("aria-label") || el.innerText || el.textContent || el.value || el.getAttribute("title") || "").trim().slice(0, 80);
    const key = kind + "|" + label + "|" + (el.id || "") + "|" + Math.round(rect.x) + "," + Math.round(rect.y);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind,
      label,
      id: el.id || "",
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      ariaExpanded: el.getAttribute("aria-expanded"),
      ariaControls: el.getAttribute("aria-controls") || "",
      ariaHaspopup: el.getAttribute("aria-haspopup") || "",
      selector: el.id ? `#${CSS.escape(el.id)}` : null,
    });
  };

  // Buttons / triggers that plausibly reveal state.
  for (const el of document.querySelectorAll(
    'button, [role="button"], [aria-haspopup], [aria-expanded], summary, [role="tab"], [data-toggle], [data-bs-toggle]'
  )) push(el, "trigger");

  // Comboboxes / custom selects.
  for (const el of document.querySelectorAll('[role="combobox"], select, [aria-autocomplete]')) push(el, "combobox");

  return out.slice(0, 40);
}

// Snapshot of the things our checks care about, read from the live DOM.
export function readInteractionState() {
  const active = document.activeElement;
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]');
  const liveRegions = [...document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')]
    .map((r) => (r.innerText || r.textContent || "").trim())
    .filter(Boolean);
  const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].map((e) => ({
    tag: e.tagName.toLowerCase(),
    id: e.id || "",
    describedby: e.getAttribute("aria-describedby") || "",
    name: e.getAttribute("name") || "",
  }));
  return {
    activeTag: active ? active.tagName.toLowerCase() : null,
    activeInDialog: !!(dialog && active && dialog.contains(active)),
    dialogPresent: !!dialog,
    dialogRole: dialog ? (dialog.getAttribute("role") || "dialog") : null,
    dialogAriaModal: dialog ? dialog.getAttribute("aria-modal") : null,
    liveRegions,
    invalid,
  };
}

// ---------------------------------------------------------------------------
// The engine. `deps` are injected by the crawler so axe setup and keyboard
// evidence stay defined in exactly one place (no circular import, no second
// copy of the axe config to drift out of sync).
//   deps.scanPage(page)            -> violations[]   (same axe run the crawler uses)
//   deps.captureKeyboard(page)     -> keyboard evidence | null
//   deps.keyboardNav(page)         -> real-Tab navigation probe | null (optional)
//   deps.log(msg)                  -> progress line
// ---------------------------------------------------------------------------

// Run the real-Tab-key navigation probe on the CURRENT state and return its
// findings already shaped like measured findings, so they merge straight into a
// scenario's violations. A modal/drawer is exactly where a real focus trap lives,
// and only a real keypress finds it — the simulated focus walk cannot. Never
// throws; if the probe is not injected or fails, returns [].
async function realKeyboardFindings(page, deps, enabled) {
  if (!enabled || !deps.keyboardNav) return [];
  const nav = await deps.keyboardNav(page).catch(() => null);
  if (!nav || !nav.findings?.length) return [];
  return nav.findings.map((f) => ({
    id: f.rule,
    source: "keyboard-nav",
    impact: f.impact,
    description: f.title,
    help: f.explanation,
    wcag: f.wcag,
    recommendation: f.explanation,
    evidence: f.evidence,
    nodes: f.selector ? [{ target: f.selector, html: f.evidence?.slice(0, 200) ?? "" }] : [],
  }));
}

// Park the virtual pointer out of the way.
//
// Clicking through Playwright moves the browser's virtual mouse onto the target
// and LEAVES it there. That has two side effects we do not want during an audit:
//
//   * the element (and its ancestors) stay in :hover, so a hover-reveal menu can
//     remain open and bleed into the NEXT state we scan — findings then get
//     attributed to the wrong screen;
//   * hover-driven analytics and tooltip timers keep firing on a control the tool
//     touched, which is activity the user never performed.
//
// Moving the pointer to the top-left corner clears :hover without clicking
// anything. Note this is the BROWSER's virtual pointer only — Playwright never
// moves the operating system cursor, so the user's real mouse is untouched.
async function parkMouse(page) {
  try { await page.mouse.move(0, 0); } catch { /* pointer parking is best-effort */ }
}

// Stable signature for a candidate control, used to de-duplicate identical
// controls across pages within one scan. Digits are collapsed (Item 1 / Item 2
// → same component) and the name is normalized so the header "Filter" on 158
// shop pages hashes to a single key.
function interactionSig(c) {
  const name = String(c.label || c.role || "")
    .toLowerCase().replace(/\s+/g, " ").trim().replace(/\d+/g, "#").slice(0, 60);
  return `${c.kind || "?"}|${c.role || "?"}|${name}`;
}

export async function exploreInteractions(page, opts, deps) {
  const {
    allowMutations = false,
    valueProfile = null,
    maxInteractions = 12,
    keyboardEvidence = true,
  } = opts || {};
  const log = deps.log || (() => {});
  const scenarios = [];         // { label, violations, keyboard, meta }
  const valueLog = [];          // Operate gear: what got typed where

  const gear = allowMutations ? "Operate" : "Explore";
  log(`Interaction pass (${gear} gear) starting on ${page.url()}`);

  let candidates;
  try {
    candidates = await page.evaluate(discoverInteractive);
  } catch (e) {
    log(`Could not read interactive elements: ${String(e).slice(0, 100)}`);
    return { scenarios, valueLog };
  }
  log(`Found ${candidates.length} candidate interactive element(s).`);

  let done = 0;
  let skipped = 0;
  for (const c of candidates) {
    if (done >= maxInteractions) { log(`Reached interaction cap (${maxInteractions}).`); break; }

    // DENY is enforced in BOTH gears. In Explore it's belt-and-braces (submits
    // are empty anyway); in Operate it's a real second gate.
    if (DENY.test(c.label)) { log(`Skipping "${c.label}" (matches destructive DENY list).`); continue; }

    // Scan-wide de-duplication: a site-global control (Filter, "Log ind", a nav
    // drawer) is structurally the SAME element on every one of hundreds of pages.
    // Opening + AI-auditing it per page is wasted time and tokens and floods the
    // report with the identical 0-finding state. If an identical control (same
    // kind + role + accessible name) was already handled earlier this scan, skip
    // it — its finding, if any, is already recorded once. Does not count toward
    // the per-page cap, so the budget goes to genuinely new controls.
    const sig = interactionSig(c);
    if (deps.dedupe?.seen?.(sig)) { skipped++; continue; }

    const revealed = await openAndCheck(page, c, { gear, deps, keyboardEvidence, log });
    if (revealed) { scenarios.push(revealed); done++; deps.dedupe?.add?.(sig); }
  }
  if (skipped) log(`Skipped ${skipped} control(s) already audited earlier this scan (de-duplicated).`);

  // Validation states: focus-then-blur to surface field-level errors, and an
  // empty submit to surface form-level error announcement. Both are safe in
  // Explore gear because an EMPTY submit sends no data.
  const validationScenario = await probeValidation(page, { gear, deps, keyboardEvidence, log });
  if (validationScenario) scenarios.push(validationScenario);

  // Operate gear only: fill from profile + synthesize, then submit for real.
  if (allowMutations) {
    const filled = await fillAndSubmit(page, { valueProfile, deps, log, valueLog, keyboardEvidence });
    if (filled) scenarios.push(filled);
  }

  log(`Interaction pass done: ${scenarios.length} state(s) scanned.`);
  return { scenarios, valueLog };
}

// Open one trigger, scan the revealed state, run the family-specific checks,
// then reverse it. Returns a scenario or null.
async function openAndCheck(page, candidate, { gear, deps, keyboardEvidence, log }) {
  const before = await page.evaluate(readInteractionState).catch(() => null);
  const triggerLabel = candidate.label || candidate.role;

  // Click by selector if we have a stable id, else by accessible name.
  let clicked = false;
  try {
    if (candidate.selector) {
      await page.locator(candidate.selector).first().click({ timeout: 5000 });
    } else if (triggerLabel) {
      await page.getByText(triggerLabel, { exact: false }).first().click({ timeout: 5000 });
    }
    clicked = true;
    // Move the pointer off the trigger before we look at the result, so the state
    // we scan is the one the CLICK produced — not that state plus a hover effect
    // the tool is still holding open on the button it pressed.
    await parkMouse(page);
  } catch (e) {
    log(`Could not activate "${triggerLabel}": ${String(e).slice(0, 80)}`);
    await parkMouse(page);
    return null;
  }
  if (!clicked) return null;

  await page.waitForTimeout(400);
  const after = await page.evaluate(readInteractionState).catch(() => null);

  // Did anything actually change? If not, this wasn't a state-revealing control.
  const changed =
    after && before &&
    (after.dialogPresent !== before.dialogPresent ||
      after.invalid.length !== before.invalid.length ||
      after.liveRegions.join("|") !== before.liveRegions.join("|") ||
      candidate.ariaExpanded !== null);
  if (!changed && !after?.dialogPresent) {
    // Nothing revealed — reverse any accidental effect and skip.
    await reverse(page);
    return null;
  }

  const violations = await deps.scanPage(page).catch(() => []);
  const keyboard = keyboardEvidence ? await deps.captureKeyboard(page).catch(() => null) : null;
  // Real Tab-key navigation on the OPEN state, before the Escape probe below can
  // dismiss the dialog. This is where a focus trap actually shows up.
  const realNavFindings = await realKeyboardFindings(page, deps, keyboardEvidence);

  // Family-specific checks become synthetic, PRE-VERIFIED findings (measured
  // facts, not model opinions) — same treatment as the keyboard probe.
  const measured = [];
  const st = after || {};

  // Modal / dialog checks (NON-DESTRUCTIVE — safe to run while the state is open).
  if (st.dialogPresent) {
    if (!st.activeInDialog) {
      measured.push(mkFinding("focus-not-moved-to-dialog", "serious",
        "Focus did not move into the dialog when it opened",
        `A dialog opened but keyboard focus stayed outside it (active element: ${st.activeTag ?? "none"}). A screen-reader or keyboard user is left behind the dialog with no way to know it appeared.`,
        `Move focus to the dialog (or its first focusable control) when it opens; set role="dialog" with aria-modal="true".`,
        `dialog role="${st.dialogRole}" aria-modal="${st.dialogAriaModal ?? "unset"}", activeElement=${st.activeTag ?? "none"}`,
        ["2.4.3", "4.1.2"], triggerLabel));
    }
    if (st.dialogAriaModal !== "true") {
      measured.push(mkFinding("dialog-missing-aria-modal", "moderate",
        "Dialog is missing aria-modal",
        "Without aria-modal=\"true\", assistive tech may not confine the user to the dialog, so they can wander into the inert page behind it.",
        `Add aria-modal="true" to the dialog container (role="dialog" or role="alertdialog").`,
        `dialog role="${st.dialogRole}" aria-modal="${st.dialogAriaModal ?? "unset"}"`,
        ["4.1.2"], triggerLabel));
    }
  }

  // Expandable trigger: aria-expanded correctness (non-destructive).
  if (candidate.ariaExpanded !== null) {
    const nowExpanded = await page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : null;
      return el ? el.getAttribute("aria-expanded") : null;
    }, candidate.selector).catch(() => null);
    if (nowExpanded === candidate.ariaExpanded) {
      measured.push(mkFinding("aria-expanded-not-updated", "serious",
        "aria-expanded does not update when the control is toggled",
        `The control exposes aria-expanded="${candidate.ariaExpanded}" and it did not change after activation, so assistive tech announces the wrong state (collapsed when open, or vice-versa).`,
        "Update aria-expanded to reflect the real open/closed state whenever the control is toggled.",
        `aria-expanded stayed "${candidate.ariaExpanded}" after toggle`,
        ["4.1.2"], triggerLabel));
    }
  }

  // AI expert audit of the OPEN state — this is the whole point of following the
  // interaction: focus trapping, aria-modal, option announcement, and other
  // things a snapshot of the CLOSED page can never show. Runs BEFORE the Escape
  // probe below, because that probe may dismiss the dialog. deps.auditState is
  // injected by the crawler only when AI Full Scan is on; absent otherwise, so
  // this module keeps no hard dependency on the AI client. The measured + axe
  // rule ids are suppressed so the model doesn't re-report facts already found.
  const aiFindings = deps.auditState
    ? await deps.auditState(page, {
        url: page.url(),
        label: `Interaction: ${triggerLabel}`,
        trigger: triggerLabel,
        kind: candidate.kind,
        suppressRuleIds: [...measured.map((m) => m.id), ...violations.map((v) => v.id)],
        keyboard,
      }).catch(() => [])
    : [];

  // Escape handling + focus return (DESTRUCTIVE — may close the dialog, so it
  // runs only after the AI audit has captured the open state).
  if (st.dialogPresent) {
    const escBehaviour = await checkEscapeAndReturn(page, candidate).catch(() => null);
    if (escBehaviour && !escBehaviour.escapeClosed) {
      measured.push(mkFinding("dialog-no-escape", "moderate",
        "Dialog does not close on Escape",
        "Keyboard users expect Escape to dismiss a dialog. Without it, a keyboard user who opened it may be unable to leave.",
        "Handle the Escape key on the dialog to close it and return focus to the trigger.",
        `Pressed Escape; dialog still present = ${escBehaviour.stillOpen}`,
        ["2.1.1", "2.1.2"], triggerLabel));
    }
    if (escBehaviour && escBehaviour.escapeClosed && !escBehaviour.focusReturned) {
      measured.push(mkFinding("dialog-focus-not-returned", "serious",
        "Focus is not returned to the trigger after the dialog closes",
        "When a dialog closes, focus should return to the control that opened it. Here it was dropped, so a keyboard user lands at the top of the page or nowhere.",
        "On close, return focus to the element that opened the dialog.",
        `After close, activeElement=${escBehaviour.activeAfter ?? "none"} (expected the trigger "${triggerLabel}")`,
        ["2.4.3"], triggerLabel));
    }
  }

  await reverse(page);

  return {
    label: `Interaction: ${triggerLabel}`,
    violations: [...measured, ...realNavFindings, ...violations, ...aiFindings],
    keyboard,
    shot: violations.__shot ?? null,   // screenshot of THIS revealed state
    meta: { kind: candidate.kind, trigger: triggerLabel, gear, aiAudited: !!deps.auditState },
  };
}

// Press Escape, see if the dialog closed and whether focus came back.
async function checkEscapeAndReturn(page, candidate) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  const st = await page.evaluate(readInteractionState).catch(() => ({ dialogPresent: true }));
  const escapeClosed = !st.dialogPresent;
  let focusReturned = false;
  let activeAfter = st.activeTag ?? null;
  if (escapeClosed && candidate.selector) {
    focusReturned = await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      candidate.selector
    ).catch(() => false);
  }
  return { escapeClosed, stillOpen: st.dialogPresent, focusReturned, activeAfter };
}

// Best-effort reversal: Escape closes most overlays; if a dialog is still up,
// try a close/dismiss control; finally, don't fail the whole pass over it.
async function reverse(page) {
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const still = await page.evaluate(() => !!document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')).catch(() => false);
    if (still) {
      const closer = page.locator('[aria-label*="close" i], [title*="close" i], button:has-text("Close"), button:has-text("Cancel")').first();
      if (await closer.count()) await closer.click({ timeout: 2000 }).catch(() => {});
    }
    // Leave the pointer parked, so the next candidate is evaluated on a page with
    // no lingering hover state from the control we just used to close this one.
    await parkMouse(page);
  } catch { /* leave it; next state read will still be honest */ }
}

// Validation: focus-then-blur each of the first few fields, then submit empty.
// EMPTY submit is safe in Explore gear — it sends no user data and its purpose
// is precisely to surface the error states.
async function probeValidation(page, { gear, deps, keyboardEvidence, log }) {
  const hasForm = await page.evaluate(() => !!document.querySelector("form input, form textarea, form select")).catch(() => false);
  if (!hasForm) return null;

  log("Probing validation (focus-then-blur, empty submit)...");
  const before = await page.evaluate(readInteractionState).catch(() => null);

  // Focus then blur the first few fields to trip inline validation.
  await page.evaluate(() => {
    const fields = [...document.querySelectorAll("form input, form textarea, form select")].slice(0, 6);
    for (const f of fields) { try { f.focus(); f.blur(); } catch { /* ignore */ } }
  }).catch(() => {});
  await page.waitForTimeout(200);

  // Empty submit: click the submit control but send nothing.
  await page.evaluate(() => {
    const btn = document.querySelector('form [type="submit"], form button:not([type="button"])');
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(500);

  const after = await page.evaluate(readInteractionState).catch(() => null);
  if (!after) return null;

  const measured = [];
  const gotErrors = after.invalid.length > 0 || after.liveRegions.length > (before?.liveRegions.length ?? 0);

  if (after.invalid.length === 0) {
    measured.push(mkFinding("validation-no-aria-invalid", "serious",
      "Invalid fields are not marked with aria-invalid",
      "After an empty/invalid submit, no field carried aria-invalid=\"true\". Screen-reader users get no programmatic signal that a field is in error.",
      "Set aria-invalid=\"true\" on each field that fails validation, and remove it once corrected.",
      `After empty submit: 0 fields with aria-invalid="true"`,
      ["3.3.1", "4.1.2"], "form validation"));
  }
  if (after.liveRegions.length === 0 && !after.dialogPresent) {
    measured.push(mkFinding("validation-not-announced", "serious",
      "Validation errors are not announced",
      "The error messages shown after submit are not in a live region or focused, so assistive tech never speaks them. A screen-reader user sees the form 'do nothing'.",
      "Put the error summary in an aria-live region (or move focus to it), and associate each field message via aria-describedby.",
      `After empty submit: no aria-live / role=alert content detected`,
      ["3.3.1", "3.3.3", "4.1.3"], "form validation"));
  }
  // aria-invalid present but not described-by → message not associated.
  for (const f of after.invalid) {
    if (!f.describedby) {
      measured.push(mkFinding("error-not-associated", "moderate",
        "Error message is not programmatically associated with its field",
        `Field ${f.id ? "#" + f.id : f.name || f.tag} is marked invalid but has no aria-describedby, so its error text is visually near it but not connected for assistive tech.`,
        "Reference the error message element's id from the field's aria-describedby.",
        `${f.tag}${f.id ? "#" + f.id : ""} aria-invalid=true, aria-describedby=unset`,
        ["3.3.1", "1.3.1"], "form validation"));
      break; // one example is enough to make the point
    }
  }

  const violations = await deps.scanPage(page).catch(() => []);
  const keyboard = keyboardEvidence ? await deps.captureKeyboard(page).catch(() => null) : null;
  const realNavFindings = await realKeyboardFindings(page, deps, keyboardEvidence);
  log(`Validation probe: ${gotErrors ? "errors surfaced" : "no error state detected"}, ${measured.length} finding(s).`);

  // AI expert audit of the surfaced error state — error announcement quality,
  // aria-describedby wiring, focus-to-first-error — while the errors are visible.
  const aiFindings = deps.auditState
    ? await deps.auditState(page, {
        url: page.url(),
        label: "Interaction: form validation (empty submit)",
        trigger: "form validation",
        kind: "validation",
        suppressRuleIds: [...measured.map((m) => m.id), ...violations.map((v) => v.id)],
        keyboard,
      }).catch(() => [])
    : [];

  // Reset the form state we disturbed.
  await reverse(page);

  return {
    label: "Interaction: form validation (empty submit)",
    violations: [...measured, ...realNavFindings, ...violations, ...aiFindings],
    keyboard,
    shot: violations.__shot ?? null,
    meta: { kind: "validation", gear, aiAudited: !!deps.auditState },
  };
}

// Operate gear: fill from profile, synthesize the rest, submit for real.
async function fillAndSubmit(page, { valueProfile, deps, log, valueLog, keyboardEvidence }) {
  log("Operate gear: filling form from profile + synthetic values...");

  const fields = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("form input, form textarea, form select")) {
      const t = (el.getAttribute("type") || el.tagName).toLowerCase();
      if (["hidden", "submit", "button", "image", "file"].includes(t)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        id: el.id || "",
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        selector: el.id ? `#${el.id}` : (el.getAttribute("name") ? `[name="${el.getAttribute("name")}"]` : null),
      });
    }
    return out.slice(0, 25);
  }).catch(() => []);

  const profileFields = (valueProfile && valueProfile.fields) || {};
  const profileVars = (valueProfile && valueProfile.profile) || {};
  const resolveVars = (v) => String(v).replace(/\{\{(\w+)\}\}/g, (_, k) => profileVars[k] ?? "");

  for (const f of fields) {
    if (SENSITIVE_FIELD.test(`${f.name} ${f.id} ${f.placeholder} ${f.ariaLabel}`)) {
      log(`Skipping sensitive field ${f.selector ?? f.name} (never auto-filled).`);
      valueLog.push({ field: f.selector ?? f.name, value: null, source: "skipped-sensitive" });
      continue;
    }
    // Profile match by selector, then by name.
    let value = null, source = "";
    if (f.selector && profileFields[f.selector] != null) { value = resolveVars(profileFields[f.selector]); source = "profile"; }
    else if (f.name && profileFields[f.name] != null) { value = resolveVars(profileFields[f.name]); source = "profile"; }
    else { value = syntheticValue(f); source = "synthetic"; }

    if (!f.selector) { valueLog.push({ field: f.name || "(unnamed)", value, source: source + " (unreachable, skipped)" }); continue; }
    try {
      if (f.tag === "select") {
        await page.selectOption(f.selector, { label: value }).catch(async () => {
          // fall back to first non-placeholder option
          await page.evaluate((sel) => {
            const s = document.querySelector(sel);
            if (s && s.options.length > 1) s.selectedIndex = 1;
          }, f.selector);
        });
      } else {
        await page.fill(f.selector, value, { timeout: 3000 });
      }
      valueLog.push({ field: f.selector, value, source });
    } catch (e) {
      valueLog.push({ field: f.selector, value, source: source + " (fill failed)" });
      log(`Could not fill ${f.selector}: ${String(e).slice(0, 60)}`);
    }
  }

  // Submit for real — but DENY still blocks a destructive submit label.
  const submitLabel = await page.evaluate(() => {
    const b = document.querySelector('form [type="submit"], form button:not([type="button"])');
    return b ? (b.innerText || b.value || "submit").trim().slice(0, 60) : null;
  }).catch(() => null);

  if (!submitLabel) { log("No submit control found; filled without submitting."); }
  else if (DENY.test(submitLabel)) {
    log(`Refusing to click submit "${submitLabel}" — matches destructive DENY list even in Operate gear.`);
  } else {
    log(`Submitting form via "${submitLabel}"...`);
    await page.evaluate(() => {
      const b = document.querySelector('form [type="submit"], form button:not([type="button"])');
      if (b) b.click();
    }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(700);
  }

  const violations = await deps.scanPage(page).catch(() => []);
  const keyboard = keyboardEvidence ? await deps.captureKeyboard(page).catch(() => null) : null;
  const realNavFindings = await realKeyboardFindings(page, deps, keyboardEvidence);

  // AI expert audit of the post-submit state (success confirmation, error
  // summary, or the page the submit navigated to) — announcement + focus.
  const aiFindings = deps.auditState
    ? await deps.auditState(page, {
        url: page.url(),
        label: "Interaction: form filled & submitted (Operate)",
        trigger: submitLabel || "form submit",
        kind: "operate-submit",
        suppressRuleIds: violations.map((v) => v.id),
        keyboard,
      }).catch(() => [])
    : [];

  return {
    label: "Interaction: form filled & submitted (Operate)",
    violations: [...realNavFindings, ...violations, ...aiFindings],
    keyboard,
    shot: violations.__shot ?? null,
    meta: { kind: "operate-submit", gear: "Operate", submitLabel, fieldsFilled: valueLog.filter((v) => v.value != null).length, aiAudited: !!deps.auditState },
  };
}

// Shape a measured finding to match what report.mjs expects from the keyboard
// probe: verified by construction, carries wcag + a real evidence string.
export function mkFinding(rule, impact, title, explanation, fix, evidence, wcag, scenario) {
  return {
    id: rule,
    impact,
    help: title,
    description: explanation,
    wcag,
    // node shape mirrors an axe violation node so downstream code is uniform
    nodes: [{
      target: scenario,
      html: "",
      failureSummary: fix,
    }],
    // extra fields the AI report's measured-merge path reads
    measured: true,
    title,
    explanation,
    fix,
    evidence,
    evidenceStatus: "verified",
    scenario,
  };
}
