// A11y Lens — per-element visual evidence.
//
// A selector like `.Banner_image__u4W4w[loading="lazy"]` tells a developer where
// the problem is. It does not tell them WHICH image on the page is broken — and
// on a page with five near-identical banners, that is the difference between a
// two-minute fix and a twenty-minute hunt.
//
// So for each failing element we capture a cropped screenshot with the element
// outlined in its severity colour, plus enough surrounding context to recognise
// where it sits on the page.
//
// Cost control matters here: a page can fail 40 rules across 200 elements, and
// screenshotting all of them would be slow and produce a huge payload. We cap
// per-rule and overall, and say so in the output rather than silently truncating.

const SEVERITY_COLOR = {
  critical: "#FF5A5A",
  serious: "#FF9E3D",
  moderate: "#F2C230",
  minor: "#5CA8FF",
};

const PAD = 24; // px of context around the element

// Draw a highlight on the element and return its padded bounding box, all in one
// page call so the element can't move between measuring and drawing.
function highlightInPage(selector, color, pad) {
  const el = document.querySelector(selector);
  if (!el) return null;

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;

  const marker = document.createElement("div");
  marker.setAttribute("data-a11y-shot", "");
  marker.style.cssText = [
    "position:fixed",
    `left:${r.left - 3}px`,
    `top:${r.top - 3}px`,
    `width:${r.width + 6}px`,
    `height:${r.height + 6}px`,
    `border:3px solid ${color}`,
    "border-radius:3px",
    `box-shadow:0 0 0 3px ${color}44, 0 0 14px ${color}66`,
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";");
  document.body.appendChild(marker);

  // Clip region in *page* coordinates, clamped to the document.
  const x = Math.max(0, r.left + window.scrollX - pad);
  const y = Math.max(0, r.top + window.scrollY - pad);
  const width = Math.min(
    r.width + pad * 2,
    document.documentElement.scrollWidth - x
  );
  const height = Math.min(
    r.height + pad * 2,
    document.documentElement.scrollHeight - y
  );

  return {
    // Screenshot clip is relative to the viewport for a non-fullPage capture,
    // so hand back viewport coords too.
    clip: {
      x: Math.max(0, r.left - pad),
      y: Math.max(0, r.top - pad),
      width: Math.max(8, Math.min(r.width + pad * 2, window.innerWidth - Math.max(0, r.left - pad))),
      height: Math.max(8, Math.min(r.height + pad * 2, window.innerHeight - Math.max(0, r.top - pad))),
    },
    page: { x, y, width, height },
    tiny: r.width < 4 || r.height < 4,
  };
}

function clearHighlightsInPage() {
  document.querySelectorAll("[data-a11y-shot]").forEach((n) => n.remove());
}

/**
 * Attach a `screenshot` (base64 JPEG) to each violation node we can locate.
 * Mutates nothing — returns a new violations array.
 */
export async function captureElementScreenshots(page, violations, opts = {}) {
  const maxPerRule = opts.maxPerRule ?? 5;
  const maxTotal = opts.maxTotal ?? 40;

  let taken = 0;
  let skippedNotFound = 0;
  let skippedBudget = 0;

  const out = [];

  for (const v of violations) {
    const color = SEVERITY_COLOR[v.impact] ?? SEVERITY_COLOR.minor;
    const nodes = [];

    for (let i = 0; i < v.nodes.length; i++) {
      const node = v.nodes[i];

      if (taken >= maxTotal || i >= maxPerRule) {
        // Be explicit about what we didn't capture rather than pretending the
        // element simply had no visual.
        skippedBudget++;
        nodes.push({ ...node, screenshot: null, screenshotSkipped: "budget" });
        continue;
      }

      let box = null;
      try {
        box = await page.evaluate(
          ({ sel, c, pad }) => {
            const fn = window.__a11yHighlight;
            return fn ? fn(sel, c, pad) : null;
          },
          { sel: node.target, c: color, pad: PAD }
        );
      } catch {
        box = null;
      }

      if (!box) {
        skippedNotFound++;
        nodes.push({ ...node, screenshot: null, screenshotSkipped: "not-found" });
        continue;
      }

      let shot = null;
      try {
        const buf = await page.screenshot({
          type: "jpeg",
          quality: 65,
          clip: box.clip,
        });
        shot = buf.toString("base64");
        taken++;
      } catch {
        shot = null;
      } finally {
        await page.evaluate(() => {
          document.querySelectorAll("[data-a11y-shot]").forEach((n) => n.remove());
        }).catch(() => {});
      }

      nodes.push({
        ...node,
        screenshot: shot,
        screenshotSkipped: shot ? null : "capture-failed",
        // A 0x0 or 1x1 element is a real finding in itself — a screenshot of it
        // would be meaningless, so flag it rather than showing an empty crop.
        elementTiny: !!box.tiny,
      });
    }

    out.push({ ...v, nodes });
  }

  return {
    violations: out,
    stats: { taken, skippedNotFound, skippedBudget, maxPerRule, maxTotal },
  };
}

// Injected once per page so the per-element calls stay cheap.
export async function installHighlighter(page) {
  await page.evaluate(
    ({ fnSrc, clearSrc }) => {
      // eslint-disable-next-line no-new-func
      window.__a11yHighlight = new Function(`return (${fnSrc})`)();
      // eslint-disable-next-line no-new-func
      window.__a11yClearShots = new Function(`return (${clearSrc})`)();
    },
    { fnSrc: highlightInPage.toString(), clearSrc: clearHighlightsInPage.toString() }
  );
}

// Full-page visual evidence.
//
// The cropped shots above show a failing element up close but lose the page
// context — you can't tell WHERE on the page the issue sits. This captures ONE
// Prepare a page for a full-page screenshot.
//
// A full-page shot of a real portal is often half-blank without this: images with
// loading="lazy" below the fold never fetch until scrolled near, and SPA content
// can still be arriving. Management reads a blank hero as "the tool is broken", so
// the screenshot has to show the page a human would actually see.
//
// Everything here is BOUNDED. A hanging analytics beacon or an infinite-scroll
// feed must not stall the scan, so every wait has a ceiling and we always return.
export async function settleForCapture(page, opts = {}) {
  const settleMs = opts.settleMs ?? 600;      // quiet period after scrolling
  const idleMs = opts.networkIdleMs ?? 2500;  // max wait for network to go quiet
  const maxScrollMs = opts.maxScrollMs ?? 4000;

  // Move the virtual pointer out of the way first. If it is left sitting on a
  // control, that control screenshots in its :hover state — evidence showing a
  // highlight the real user never triggered, and in the worst case a tooltip or
  // hover menu covering the very element the callout points at. (Playwright's
  // pointer is internal to the browser; the OS cursor is never moved.)
  try { await page.mouse.move(0, 0); } catch { /* best-effort */ }

  try {
    // 1 · Walk the page top-to-bottom to bring lazy content into view, then back
    // to the top so the capture starts from a clean origin. Bounded by both a
    // step cap and wall-clock time — an infinite-scroll page would never "end".
    // maxScrollMs:0 skips the walk entirely (used for interaction states, where
    // scrolling could dismiss an open modal or drawer).
    if (maxScrollMs > 0) {
      await page.evaluate(async (maxMs) => {
      const started = Date.now();
      const step = Math.max(300, Math.floor(window.innerHeight * 0.9));
      const bottom = () =>
        Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      let y = 0;
      // scroll down
      while (y < bottom() && Date.now() - started < maxMs) {
        y += step;
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
      // give the top a moment to repaint after the jump back
      await new Promise((r) => setTimeout(r, 150));
    }, maxScrollMs);
    }

    // 2 · Wait for the network to go quiet, but never longer than idleMs. A page
    // that keeps a socket open forever should not block the shot.
    await Promise.race([
      page.waitForLoadState("networkidle").catch(() => {}),
      new Promise((r) => setTimeout(r, idleMs)),
    ]);

    // 3 · Decode any images that are now in the DOM but not yet painted. Without
    // this a just-fetched hero can still screenshot blank.
    await page.evaluate(async () => {
      const imgs = [...document.images].filter((im) => !im.complete);
      await Promise.race([
        Promise.all(imgs.map((im) => im.decode().catch(() => {}))),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      if (document.fonts?.ready) { try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 800))]); } catch { /* ignore */ } }
    });

    // 4 · A short final quiet period so late animations (accordions, skeletons)
    // land before the shutter.
    await page.waitForTimeout(settleMs);
  } catch {
    // Settling is best-effort. If anything throws, we still take the shot — a
    // slightly-early screenshot beats no evidence at all.
  }
}

// full-page screenshot per page (not per element, so a 200-issue page stays
// small) plus each failing element's bounding box in full-page CSS coordinates.
// The report draws the "issue square" as an HTML overlay on the shared image, so
// the bytes are stored once per page and every finding on that page reuses them.
//
// Boxes are captured as data (not baked into the pixels) because position:fixed
// markers render at the wrong place in a full-page screenshot — an overlay in the
// report is both accurate and lets us store the image once.
export async function captureFullPageAnnotated(page, violations, opts = {}) {
  const maxPerRule = opts.maxPerRule ?? 3;
  const maxTotal = opts.maxTotal ?? 30;
  const quality = opts.quality ?? 55;

  // Give the page time to finish loading before the shutter — lazy images,
  // in-flight requests, late animations. Skippable (settle:false) for callers
  // that have already settled the page (e.g. an interaction state we just opened
  // and must not disturb).
  if (opts.settle !== false) {
    await settleForCapture(page, opts.settleOpts || {});
  }

  let pageShot = null;
  let pageW = 0;
  let pageH = 0;
  let shotPath = null;
  try {
    const dims = await page.evaluate(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
      h: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
    }));
    pageW = dims.w;
    pageH = dims.h;
    // scale:'css' captures at CSS-pixel resolution (not 2x retina), so image
    // pixels line up 1:1 with the boxes below and the file stays ~4x smaller.
    const buf = await page.screenshot({ type: "jpeg", quality, fullPage: true, scale: "css" });

    // Save to disk when a directory is given: a 1000-page report with full-page
    // JPEGs embedded as base64 would be a huge, slow session blob. On disk the
    // session JSON stays small and the images survive a restart. Callers that
    // don't pass saveDir still get base64 (back-compatible).
    if (opts.saveDir && opts.shotName) {
      try {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        mkdirSync(opts.saveDir, { recursive: true });
        const file = join(opts.saveDir, `${opts.shotName}.jpg`);
        writeFileSync(file, buf);
        shotPath = file;
      } catch {
        shotPath = null;   // fall back to base64 below
      }
    }
    if (!shotPath) pageShot = buf.toString("base64");
  } catch {
    pageShot = null; // findings still returned, just without the visual
  }

  let taken = 0;
  let notFound = 0;
  let budget = 0;
  const out = [];

  for (const v of violations) {
    const nodes = [];
    for (let i = 0; i < v.nodes.length; i++) {
      const node = v.nodes[i];
      if (taken >= maxTotal || i >= maxPerRule) {
        budget++;
        nodes.push({ ...node, box: null, boxSkipped: "budget" });
        continue;
      }
      let box = null;
      try {
        box = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return {
            x: Math.round(r.left + window.scrollX),
            y: Math.round(r.top + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
            tiny: r.width < 4 || r.height < 4,
          };
        }, node.target);
      } catch {
        box = null;
      }
      if (!box) {
        notFound++;
        nodes.push({ ...node, box: null, boxSkipped: "not-found" });
        continue;
      }
      taken++;
      nodes.push({ ...node, box, elementTiny: !!box.tiny });
    }
    out.push({ ...v, nodes });
  }

  return {
    violations: out,
    pageShot,
    shotPath,
    pageW,
    pageH,
    stats: { taken, notFound, budget, maxPerRule, maxTotal },
  };
}
