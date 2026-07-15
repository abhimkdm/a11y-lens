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
