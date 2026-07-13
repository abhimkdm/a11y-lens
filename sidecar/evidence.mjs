// A11y Lens — evidence capture for the AI Expert Audit.
//
// Scanners see markup. An expert reviewer sees the page *and* the markup and
// notices when they disagree. To let the model do that, we capture four things
// per page state and hand them over together:
//
//   1. Screenshot        — ground truth for what a sighted user sees
//   2. Sanitized DOM     — ground truth for markup (scripts/styles stripped,
//                          ARIA + classes + text kept)
//   3. Accessibility tree — ground truth for what a screen reader announces
//   4. Keyboard walk     — bounded Tab trace: what focus actually does
//
// Nothing here is app-specific and no paths are hardcoded; it operates purely
// on whatever page the existing browser session already has open.

const DOM_LIMIT = 60000;   // keep the prompt affordable; truncation is flagged
const WALK_STEPS = 40;

// Runs in the page. Kept as a plain function (no closures over module scope)
// so it serializes cleanly into page.evaluate across Playwright versions.
function sanitizeDomInPage(limit) {
  const clone = document.documentElement.cloneNode(true);

  // Strip anything that's pure noise for an accessibility review.
  clone.querySelectorAll("script, style, noscript, template, link, meta").forEach((n) => n.remove());
  // Keep the <svg> element (role/aria-label matter) but drop its innards.
  clone.querySelectorAll("svg").forEach((n) => { n.innerHTML = ""; });

  // Drop inline handlers and heavy data-* payloads, but deliberately KEEP
  // `class` — it carries sr-only / skip-link / utility-class signal that the
  // model uses to reason about visually-hidden content.
  const all = clone.querySelectorAll("*");
  for (const el of all) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if (name.startsWith("data-") && attr.value.length > 40) el.setAttribute(attr.name, "…");
      else if (name === "src" && attr.value.length > 120) el.setAttribute(attr.name, "…");
      else if (name === "srcset" || name === "style") el.removeAttribute(attr.name);
    }
  }

  let html = clone.outerHTML.replace(/\n\s*\n/g, "\n");
  const truncated = html.length > limit;
  if (truncated) html = html.slice(0, limit);
  return { html, truncated };
}

// Bounded Tab trace. Activates a skip link first when one exists, so the walk
// reflects what a real keyboard user experiences rather than starting cold.
function walkKeyboardInPage(steps) {
  return new Promise((resolve) => {
    const trace = [];
    const describe = (el) => {
      if (!el || el === document.body) return { tag: "body", name: "", note: "focus left the page / reset to body" };
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const name =
        el.getAttribute("aria-label") ||
        (el.innerText || "").trim().slice(0, 60) ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.getAttribute("placeholder") ||
        "";
      const invisible =
        r.width === 0 || r.height === 0 ||
        style.visibility === "hidden" || style.display === "none";
      const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth || "0") > 0;
      const ring = outline || (style.boxShadow && style.boxShadow !== "none");
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        name,
        selector: el.id ? `#${el.id}` : el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : el.tagName.toLowerCase(),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        offscreen: r.bottom < 0 || r.top > window.innerHeight,
        invisible,
        focusIndicator: ring ? "present" : "MISSING",
      };
    };

    // Activate a skip link if the first focusable looks like one.
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();

    let i = 0;
    const step = () => {
      if (i >= steps) {
        document.body.removeAttribute("tabindex");
        resolve(trace);
        return;
      }
      i++;
      // We can't synthesize a real Tab keypress from inside the page, so we
      // reproduce the browser's sequential-focus order ourselves. This is an
      // approximation of Tab, and the prompt tells the model to treat it as such.
      const focusables = [...document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
      )].filter((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("disabled"));
      const current = document.activeElement;
      const idx = focusables.indexOf(current);
      const next = focusables[idx + 1] ?? focusables[0];
      if (!next) { resolve(trace); return; }
      next.focus();
      trace.push({ step: i, ...describe(document.activeElement) });
      step();
    };
    step();
  });
}

export async function captureEvidence(page, opts = {}) {
  const url = page.url();
  const title = await page.title().catch(() => "");

  const screenshot = await page
    .screenshot({ fullPage: true, type: "jpeg", quality: 70 })
    .then((b) => b.toString("base64"))
    .catch(() => null);

  const dom = await page.evaluate(sanitizeDomInPage, DOM_LIMIT).catch(() => ({ html: "", truncated: false }));

  // Playwright's ariaSnapshot is the accessibility tree as YAML. Guard it —
  // it isn't available on every Playwright version, and it's not fatal if absent.
  let ariaTree = "";
  try {
    ariaTree = await page.locator("body").ariaSnapshot();
  } catch {
    ariaTree = "";
  }

  let keyboardWalk = [];
  if (opts.keyboardWalk !== false) {
    keyboardWalk = await page.evaluate(walkKeyboardInPage, WALK_STEPS).catch(() => []);
  }

  return { url, title, screenshot, dom, ariaTree, keyboardWalk, capturedAt: new Date().toISOString() };
}

// Turns captured evidence into the user-message text the model reads.
// `suppress` is the list of axe rule IDs already caught by the scanner pass —
// built from the live scan, so the model is told exactly what NOT to re-report.
export function buildEvidenceText(evidence, suppress = []) {
  const walk = evidence.keyboardWalk?.length
    ? evidence.keyboardWalk
        .map((s) =>
          `  ${s.step}. <${s.tag}${s.role ? ` role="${s.role}"` : ""}> "${s.name || "(no accessible name)"}" ` +
          `[${s.selector}] size=${s.size}${s.invisible ? " INVISIBLE" : ""}${s.offscreen ? " OFFSCREEN" : ""} ` +
          `focus-indicator=${s.focusIndicator}`
        )
        .join("\n")
    : "  (not captured)";

  return [
    `PAGE: ${evidence.title || "(untitled)"} — ${evidence.url}`,
    "",
    "SCANNER SUPPRESSION LIST — these rule IDs were already caught by the automated",
    "scanner on THIS page and are being reported separately. Do not re-report them:",
    suppress.length ? `  ${suppress.join(", ")}` : "  (scanner found no violations on this page)",
    "",
    "ACCESSIBILITY TREE (what a screen reader announces):",
    evidence.ariaTree ? evidence.ariaTree.slice(0, 15000) : "  (unavailable)",
    "",
    `KEYBOARD WALK (sequential focus order, ${evidence.keyboardWalk?.length ?? 0} steps).`,
    "NOTE: this is a reproduction of sequential focus order, not literal Tab keypresses.",
    "Treat focus-indicator=MISSING as direct evidence for WCAG 2.4.7.",
    walk,
    "",
    `SANITIZED DOM${evidence.dom?.truncated ? " (TRUNCATED — do not infer anything from the cutoff)" : ""}:`,
    evidence.dom?.html || "  (unavailable)",
  ].join("\n");
}
