// A11y Lens — deterministic probes.
//
// These produce findings with NO AI involvement. That matters: a probe result
// is a measurement, not an opinion, so it can never hallucinate and needs no
// evidence verification. Anything measurable should be measured, and the model
// should only be asked to judge what genuinely requires judgement.
//
//   focusVisibleProbe  — WCAG 2.4.7. Focuses each control the way a keyboard
//                        user would and measures computed outline/box-shadow.
//                        A screenshot cannot show focus rings; this is the only
//                        reliable way to evidence 2.4.7.
//   zoomReflowProbe    — WCAG 1.4.4 (resize text) / 1.4.10 (reflow). Detects
//                        horizontal overflow and clipped content at 200% text
//                        and at a 320px-equivalent viewport.

const CHROME_HINT = /header|footer|nav|cookie|consent|chat|widget|banner|skip/i;

function probeFocusInPage(excludeChrome) {
  const results = [];
  const isChrome = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const id = `${n.id || ""} ${typeof n.className === "string" ? n.className : ""} ${n.tagName}`;
      if (/HEADER|FOOTER|NAV/.test(n.tagName)) return true;
      if (/header|footer|nav|cookie|consent|chat|widget|skip/i.test(id)) return true;
      n = n.parentElement;
    }
    return false;
  };

  const candidates = [...document.querySelectorAll(
    'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="tab"]'
  )].filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (excludeChrome && isChrome(el)) return false;
    return true;
  }).slice(0, 60);

  const baseline = new Map();
  for (const el of candidates) {
    const s = getComputedStyle(el);
    baseline.set(el, {
      outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
      boxShadow: s.boxShadow,
      border: `${s.borderStyle} ${s.borderWidth} ${s.borderColor}`,
    });
  }

  for (const el of candidates) {
    try {
      el.focus({ preventScroll: true });
    } catch { continue; }
    if (document.activeElement !== el) continue;

    const s = getComputedStyle(el);
    const b = baseline.get(el);
    const outlineNow = `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
    const shadowNow = s.boxShadow;
    const borderNow = `${s.borderStyle} ${s.borderWidth} ${s.borderColor}`;

    const hasOutline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth || "0") > 0;
    const changed =
      outlineNow !== b.outline || shadowNow !== b.boxShadow || borderNow !== b.border;

    // A focus indicator exists if a real outline is drawn, OR if anything
    // visually changed on focus (some designs use box-shadow or border).
    const indicator = hasOutline || changed;

    const label =
      el.getAttribute("aria-label") ||
      (el.innerText || "").trim().slice(0, 50) ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      "";

    results.push({
      selector: el.id
        ? `#${el.id}`
        : `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
            : ""}`,
      tag: el.tagName.toLowerCase(),
      label,
      html: el.outerHTML.slice(0, 180),
      indicator: indicator ? "present" : "MISSING",
      outline: outlineNow,
    });
  }
  document.activeElement?.blur?.();
  return results;
}

function probeOverflowInPage() {
  const doc = document.documentElement;
  const horizontal = doc.scrollWidth > doc.clientWidth + 2;
  const clipped = [];
  const els = [...document.querySelectorAll("body *")].slice(0, 3000);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Element extends beyond the viewport's right edge
    if (r.right > window.innerWidth + 2 && r.width < window.innerWidth * 2) {
      const text = (el.innerText || "").trim().slice(0, 60);
      if (!text) continue;
      clipped.push({
        selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
        overflowPx: Math.round(r.right - window.innerWidth),
        text,
      });
      if (clipped.length >= 12) break;
    }
  }
  return {
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    horizontalScroll: horizontal,
    clipped,
  };
}

export async function runFocusVisibleProbe(page, { excludeChrome = true } = {}) {
  const results = await page.evaluate(probeFocusInPage, excludeChrome).catch(() => []);
  const missing = results.filter((r) => r.indicator === "MISSING");
  if (!missing.length) return { findings: [], checked: results.length, missing: 0 };

  // One finding per distinct control type keeps the report readable rather than
  // emitting 40 near-identical rows.
  const byTag = new Map();
  for (const m of missing) {
    if (!byTag.has(m.tag)) byTag.set(m.tag, []);
    byTag.get(m.tag).push(m);
  }

  const findings = [...byTag.entries()].map(([tag, items]) => ({
    zone: "Keyboard focus",
    title: `No visible focus indicator on ${items.length} <${tag}> control${items.length === 1 ? "" : "s"}`,
    severity: "serious",
    description:
      `Focusing these controls with the keyboard produces no measurable change in outline, box-shadow, or border. ` +
      `Keyboard users cannot tell which control is focused.`,
    userImpact:
      "Sighted keyboard users lose track of their position on the page and cannot tell what pressing Enter will activate.",
    fix:
      `Add a visible focus style, e.g. \`${tag}:focus-visible { outline: 2px solid #005FCC; outline-offset: 2px; }\`. ` +
      `Never remove the default outline without replacing it.`,
    evidence: items.slice(0, 3).map((i) => i.html).join("\n"),
    wcag: ["2.4.7 AA"],
    evidenceStatus: "verified",   // measured, not asserted
    source: "probe",
  }));

  return { findings, checked: results.length, missing: missing.length };
}

export async function runZoomReflowProbe(page) {
  const findings = [];
  const original = page.viewportSize?.() ?? { width: 1440, height: 900 };

  // --- WCAG 1.4.10 Reflow: 320 CSS px equivalent, no horizontal scrolling ---
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(400);
    const narrow = await page.evaluate(probeOverflowInPage);
    if (narrow.horizontalScroll) {
      findings.push({
        zone: "Responsive layout",
        title: "Content requires horizontal scrolling at 320px width",
        severity: "serious",
        description:
          `At a 320 CSS px viewport the page scrolls horizontally (scrollWidth ${narrow.scrollWidth}px vs ` +
          `viewport ${narrow.clientWidth}px). WCAG 1.4.10 requires content to reflow without two-dimensional scrolling.`,
        userImpact:
          "Users who zoom to 400% or use a small screen must scroll both directions to read every line — for low-vision users this makes the content effectively unusable.",
        fix:
          "Remove fixed widths / min-widths on the offending containers and let them wrap. Check for tables, code blocks, and absolutely-positioned elements that don't shrink.",
        evidence:
          narrow.clipped.length
            ? narrow.clipped.slice(0, 3).map((c) => `${c.selector} overflows by ${c.overflowPx}px: "${c.text}"`).join("\n")
            : `document.scrollWidth = ${narrow.scrollWidth}px at clientWidth ${narrow.clientWidth}px`,
        wcag: ["1.4.10 AA"],
        evidenceStatus: "verified",
        source: "probe",
      });
    }
  } catch { /* probe is best-effort; never fail the audit */ }

  // --- WCAG 1.4.4 Resize Text: 200% text size, no loss of content ---
  try {
    await page.setViewportSize({ width: original.width, height: original.height });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(400);
    const zoomed = await page.evaluate(probeOverflowInPage);
    if (zoomed.clipped.length) {
      findings.push({
        zone: "Text resize",
        title: `Content is clipped or overflows at 200% text size (${zoomed.clipped.length} element${zoomed.clipped.length === 1 ? "" : "s"})`,
        severity: "serious",
        description:
          "With text scaled to 200%, content extends beyond the viewport. WCAG 1.4.4 requires text to be resizable to 200% without loss of content or functionality.",
        userImpact:
          "Low-vision users who enlarge text lose access to the overflowing content entirely — it is cut off, not merely awkward.",
        fix:
          "Avoid fixed px heights and widths on text containers; use relative units (rem/em) and allow containers to grow. Check `overflow: hidden` on ancestors.",
        evidence: zoomed.clipped.slice(0, 3).map((c) => `${c.selector} overflows by ${c.overflowPx}px: "${c.text}"`).join("\n"),
        wcag: ["1.4.4 AA"],
        evidenceStatus: "verified",
        source: "probe",
      });
    }
  } catch { /* best-effort */ }

  // Always restore the page to how we found it.
  try {
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.setViewportSize({ width: original.width, height: original.height });
    await page.waitForTimeout(200);
  } catch { /* ignore */ }

  return { findings };
}
