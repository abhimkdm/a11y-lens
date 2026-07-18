// Normalize any finding — axe (deterministic), measured interaction checks, or AI
// audit — to the flat reporting block the report/exports use:
//   { severity, wcag, description, evidence, recommendation, codeExample }
//
// AI-audit findings already carry these keys. Deterministic findings are mapped
// from their axe fields (impact→severity, help→recommendation, wcag[]→wcag), and
// a codeExample is synthesized from the small fix dictionary below so every block
// gives a developer something concrete to paste, not just a WCAG paraphrase.

const CODE = {
  // --- common axe rules ---
  "image-alt": `<img src="logo.png" alt="Acme Corp — home">`,
  "input-image-alt": `<input type="image" src="search.png" alt="Search">`,
  "area-alt": `<area shape="rect" coords="…" href="/eu" alt="Europe">`,
  "button-name": `<button aria-label="Close dialog">\u00d7</button>`,
  "link-name": `<a href="/pricing">See pricing</a>  <!-- not "click here" -->`,
  "label": `<label for="email">Email</label>\n<input id="email" type="email" autocomplete="email">`,
  "select-name": `<label for="country">Country</label>\n<select id="country">\u2026</select>`,
  "color-contrast": `/* text contrast \u2265 4.5:1 (large text \u2265 3:1) */\ncolor:#1a1a1a; background:#ffffff;`,
  "link-in-text-block": `a { text-decoration: underline; } /* don't rely on colour alone */`,
  "html-has-lang": `<html lang="en">`,
  "html-lang-valid": `<html lang="en">`,
  "valid-lang": `<span lang="fr">bonjour</span>`,
  "document-title": `<title>Checkout \u2014 Acme</title>`,
  "duplicate-id-active": `<input id="email-billing"> \u2026 <input id="email-shipping"> <!-- unique ids -->`,
  "aria-required-attr": `<div role="checkbox" aria-checked="false" tabindex="0">\u2026</div>`,
  "aria-required-children": `<ul role="list"><li role="listitem">\u2026</li></ul>`,
  "aria-valid-attr-value": `<button aria-expanded="false" aria-controls="menu">Menu</button>`,
  "aria-hidden-focus": `<div aria-hidden="true"><button tabindex="-1">\u2026</button></div>`,
  "aria-command-name": `<button aria-label="Add to cart">\u{1f6d2}</button>`,
  "aria-input-field-name": `<div role="textbox" aria-label="Search" contenteditable></div>`,
  "list": `<ul><li>One</li><li>Two</li></ul>`,
  "listitem": `<ul><li>Only &lt;li&gt; as direct children</li></ul>`,
  "heading-order": `<h1>Title</h1>\n  <h2>Section</h2>\n    <h3>Sub-section</h3>`,
  "landmark-one-main": `<main id="content">\u2026</main>`,
  "region": `<main>\u2026</main>\n<nav aria-label="Primary">\u2026</nav>`,
  "frame-title": `<iframe title="Payment form" src="\u2026"></iframe>`,
  "th-has-data-cells": `<th scope="col">Price</th>`,
  "td-headers-attr": `<td headers="col-price">\u2026</td>`,
  "tabindex": `<!-- avoid tabindex &gt; 0; rely on DOM order or tabindex="0" -->`,
  "scrollable-region-focusable": `<div tabindex="0" role="region" aria-label="Activity log">\u2026</div>`,
  "meta-viewport": `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  "nested-interactive": `<button>Save</button>  <!-- no <a>/<button> inside another -->`,
  // --- measured interaction rules (from interact.mjs) ---
  "focus-not-moved-to-dialog": `dialog.querySelector('[autofocus],button,[href],input,select,textarea')?.focus();`,
  "dialog-missing-aria-modal": `<div role="dialog" aria-modal="true" aria-labelledby="dlg-title">\u2026</div>`,
  "dialog-no-escape": `dialog.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });`,
  "dialog-focus-not-returned": `function close(){ dialog.hidden = true; opener.focus(); }`,
  "aria-expanded-not-updated": `btn.setAttribute('aria-expanded', String(isOpen));`,
  "replay-no-accessible-selector": `<button aria-label="Open filters" data-testid="filters-open">\u2026</button>`,
};

export function codeExampleFor(id = "", rule = "") {
  return CODE[id] || CODE[rule] || "";
}

// Map a raw finding to the flat block. Accepts findings from any source.
export function toBlock(f) {
  const wcag = f.wcagString || (Array.isArray(f.wcag) ? f.wcag[0] : f.wcag) || "";
  const evidence =
    f.evidence ||
    (Array.isArray(f.nodes) && f.nodes[0] && (f.nodes[0].html || f.nodes[0].target)) ||
    "";
  return {
    severity: f.severity || f.impact || "moderate",
    wcag: String(wcag),
    description: f.description || f.title || f.help || "",
    evidence: String(evidence).slice(0, 500),
    recommendation: f.recommendation || f.help || "",
    codeExample: f.codeExample || codeExampleFor(f.id || f.rule, f.rule) || "",
  };
}
