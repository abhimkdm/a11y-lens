// Real keyboard navigation probe.
//
// The existing keyboard-evidence walk calls el.focus() in a loop — it reproduces
// the EXPECTED focus order but never presses a real key. That misses the defects
// that only appear when a human actually Tabs:
//
//   * a keydown handler that swallows Tab (focus never moves)
//   * a real focus TRAP — a dialog you can Tab into but not out of
//   * a control reachable by MOUSE but not by keyboard (never receives focus)
//   * focus that escapes to the browser chrome (Tab leaves the document)
//   * a dead zone where several Tabs move focus nowhere
//
// This drives Playwright's real Tab key and records where focus actually lands
// after each press. Everything is BOUNDED: a fixed maximum number of presses, and
// we stop early on a detected trap, so a hostile page cannot make the scan hang.
//
// It is additive evidence and MUST NOT throw — losing this can never lose the scan.

// Read the currently-focused element's identity from the page.
const READ_FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    return { none: true, tag: el ? el.tagName.toLowerCase() : null };
  }
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const name =
    el.getAttribute("aria-label") ||
    clean(el.innerText).slice(0, 60) ||
    el.getAttribute("title") || el.getAttribute("alt") ||
    el.getAttribute("placeholder") || clean(el.value).slice(0, 40) || "";
  let sel = el.id ? "#" + el.id : el.tagName.toLowerCase();
  if (!el.id && typeof el.className === "string" && el.className.trim())
    sel += "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".");
  return {
    none: false,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    name,
    selector: sel,
    html: el.outerHTML.slice(0, 160),
    inDialog: !!el.closest('[role="dialog"], [aria-modal="true"], dialog[open]'),
    // A stable fingerprint for "is focus still on the same element as last press".
    fp: (el.id || "") + "|" + el.tagName + "|" + name + "|" + Math.round(r.x) + "," + Math.round(r.y),
    visible: !(cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0 || r.width < 2 || r.height < 2),
    x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY),
  };
})()`;

// Count how many elements the page THINKS are keyboard-reachable, so we know how
// far to Tab and can detect controls that never receive focus.
const COUNT_FOCUSABLE = `(() => {
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"], summary, audio[controls], video[controls]';
  return [...document.querySelectorAll(sel)]
    .filter((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("disabled") && el.offsetParent !== null)
    .length;
})()`;

export async function captureRealKeyboardNav(page, opts = {}) {
  const result = {
    ran: false, presses: 0, distinctReached: 0, expectedFocusable: 0,
    findings: [], trace: [], stoppedReason: null,
  };

  try {
    // Start from a clean origin: focus the document body so Tab begins at the top.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement && document.activeElement !== document.body) {
        try { document.activeElement.blur(); } catch { /* ignore */ }
      }
      document.body?.focus?.();
    }).catch(() => {});

    const expected = await page.evaluate(COUNT_FOCUSABLE).catch(() => 0);
    result.expectedFocusable = expected;

    // Bound: never Tab more than a sensible multiple of the focusable count, with
    // a hard floor and ceiling so a page reporting 0 (or 100000) still terminates.
    const maxPresses = Math.min(Math.max((expected || 0) + 8, 15), opts.maxPresses ?? 120);

    const seenFp = new Set();
    let sameCount = 0;
    let lastFp = null;
    let leftDocument = 0;

    for (let i = 0; i < maxPresses; i++) {
      await page.keyboard.press("Tab").catch(() => {});
      // A micro-wait lets focus-moving handlers run without slowing the scan much.
      await page.waitForTimeout(15).catch(() => {});

      const f = await page.evaluate(READ_FOCUS).catch(() => null);
      result.presses++;
      if (!f) { result.stoppedReason = "focus-unreadable"; break; }

      if (f.none) {
        // Focus fell off every control — usually it escaped to the browser chrome
        // (address bar). Real keyboard users hit this when the page's last tab stop
        // does not wrap. One or two is normal at the end; many in a row is a dead zone.
        leftDocument++;
        result.trace.push({ step: i + 1, none: true });
        if (leftDocument >= 3) { result.stoppedReason = "focus-left-document"; break; }
        lastFp = null;
        continue;
      }
      leftDocument = 0;

      // Stuck? Focus did not move despite a Tab press.
      if (f.fp === lastFp) {
        sameCount++;
        // Several presses with no movement = a genuine trap (handler swallowing Tab
        // or a modal loop of size 1). Record it and stop; continuing is pointless.
        if (sameCount >= 3) {
          result.findings.push({
            rule: "keyboard-focus-trap",
            impact: "critical",
            title: "Keyboard focus is trapped",
            wcag: ["2.1.2 A"],
            explanation:
              `Pressing Tab three times in a row did not move focus away from "${f.name || f.tag}". ` +
              `A keyboard user reaching this control cannot continue past it — they are stuck, ` +
              `with no mouse to escape.` + (f.inDialog ? " The trapping element is inside a dialog." : ""),
            evidence: `Focus held on: ${f.html}`,
            selector: f.selector,
            source: "keyboard-nav",
          });
          result.stoppedReason = "focus-trap";
          break;
        }
      } else {
        sameCount = 0;
      }
      lastFp = f.fp;

      if (!seenFp.has(f.fp)) { seenFp.add(f.fp); result.trace.push({ step: i + 1, ...f }); }

      // A full cycle: focus returned to the first element we saw. The page tab
      // order is complete; no need to keep pressing.
      if (result.trace.length > 2 && f.fp === result.trace[0].fp && i > 2) {
        result.stoppedReason = "cycled";
        break;
      }

      // Focus landed on something invisible — a real keyboard user's focus ring
      // just vanished. This is stronger evidence than the simulated walk because
      // it happened under a real Tab.
      if (!f.visible) {
        result.findings.push({
          rule: "keyboard-focus-hidden",
          impact: "serious",
          title: "Real Tab navigation moves focus onto an element the user cannot see",
          wcag: ["2.4.7 AA", "2.4.3 A"],
          explanation:
            `Pressing Tab put focus on "${f.name || f.tag}", which is not visible. A sighted keyboard ` +
            `user sees the focus ring disappear and cannot tell where they are.`,
          evidence: f.html,
          selector: f.selector,
          source: "keyboard-nav",
        });
      }
    }

    result.distinctReached = seenFp.size;
    if (!result.stoppedReason) result.stoppedReason = "max-presses";

    // Reachability gap: the DOM has clearly more focusable controls than Tab could
    // actually reach. Something is intercepting Tab or using positive tabindex /
    // roving tabindex incorrectly, leaving controls keyboard-unreachable.
    if (expected >= 5 && result.distinctReached > 0 && result.distinctReached < Math.floor(expected * 0.6)) {
      result.findings.push({
        rule: "keyboard-unreachable-controls",
        impact: "serious",
        title: "Some controls cannot be reached by keyboard",
        wcag: ["2.1.1 A"],
        explanation:
          `The page has about ${expected} focusable controls, but pressing Tab reached only ` +
          `${result.distinctReached}. Controls that a mouse can use but the Tab key cannot reach are ` +
          `invisible to keyboard and screen-reader users.`,
        evidence: `Expected ~${expected} focusable, Tab reached ${result.distinctReached}.`,
        selector: "",
        source: "keyboard-nav",
      });
    }

    result.ran = true;
  } catch {
    // Additive evidence — never let a keyboard probe failure lose the scan.
  }
  return result;
}
