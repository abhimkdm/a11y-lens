// A11y Lens overlay — injected into the scanned page by Playwright.
// Renders severity markers over failing elements; each marker opens a
// tooltip card with rule, WCAG criterion, HTML, selector, and a suggested fix.
// Exported as a source string so the sidecar can page.evaluate() it with data.

export const OVERLAY_SOURCE = `
(function (violations) {
  var NS = "__a11yLens";
  if (window[NS]) window[NS].destroy();

  var COLORS = { critical: "#FF5A5A", serious: "#FF9E3D", moderate: "#F2C230", minor: "#5CA8FF" };
  var root = document.createElement("div");
  root.setAttribute("data-a11y-lens", "");
  root.style.cssText = "position:absolute;top:0;left:0;z-index:2147483646;pointer-events:none;";
  document.body.appendChild(root);

  var style = document.createElement("style");
  style.textContent =
    "[data-a11y-lens] *{box-sizing:border-box;font-family:system-ui,sans-serif}" +
    ".a11yl-dot{position:absolute;width:22px;height:22px;border-radius:50%;pointer-events:auto;" +
    "cursor:pointer;border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);display:grid;" +
    "place-items:center;color:#111;font-size:12px;font-weight:800;transition:transform .12s}" +
    ".a11yl-dot:hover,.a11yl-dot:focus-visible{transform:scale(1.25);outline:2px solid #fff;outline-offset:1px}" +
    ".a11yl-hl{position:absolute;pointer-events:none;border:2px dashed;border-radius:4px}" +
    ".a11yl-card{position:absolute;pointer-events:auto;width:380px;max-width:92vw;background:#161C24;" +
    "color:#E9EEF5;border:1px solid #3a4655;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.55);" +
    "padding:14px 16px;font-size:13px;line-height:1.5;z-index:2147483647}" +
    ".a11yl-card h4{margin:0 0 2px;font-size:14px}.a11yl-card .m{color:#9AA7B4;font-size:12px}" +
    ".a11yl-card pre{background:#0E1116;border:1px solid #2b3340;border-radius:6px;padding:8px;" +
    "font:12px/1.5 monospace;white-space:pre-wrap;word-break:break-all;margin:6px 0;max-height:110px;overflow:auto}" +
    ".a11yl-pill{display:inline-block;font-size:11px;font-weight:700;text-transform:capitalize;" +
    "border-radius:999px;padding:1px 9px;margin-right:6px}" +
    ".a11yl-card button{background:#22303f;color:#E9EEF5;border:1px solid #3a4655;border-radius:7px;" +
    "padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;margin-right:6px}" +
    ".a11yl-card button:hover{background:#2c3c4e}" +
    ".a11yl-card button:focus-visible{outline:2px solid #8AC7FF;outline-offset:1px}";
  document.head.appendChild(style);

  var card = null;
  function closeCard() { if (card) { card.remove(); card = null; } }

  function suggestFix(v, node) {
    var h = node.html || "";
    switch (v.id) {
      case "button-name": return h.replace(/<button/i, '<button aria-label="Describe the action"');
      case "image-alt": return h.replace(/<img/i, '<img alt="Describe the image"');
      case "link-name": return h.replace(/<a /i, '<a aria-label="Describe the destination" ');
      case "label": return '<label for="field-id">Field name</label>\\n' + h;
      case "html-has-lang": return '<html lang="en">';
      case "color-contrast": return "/* Increase contrast to \\u2265 4.5:1, e.g. */\\ncolor:#111; background:#fff;";
      case "select-name": return h.replace(/<select/i, '<select aria-label="Choose an option"');
      case "aria-required-attr": return "Add the required ARIA attributes listed in the failure summary.";
      default: return "See failure summary — " + (node.failureSummary || v.help);
    }
  }

  function openCard(v, node, x, y) {
    closeCard();
    var fix = suggestFix(v, node);
    card = document.createElement("div");
    card.className = "a11yl-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", v.help);
    var c = COLORS[v.impact] || "#5CA8FF";
    card.innerHTML =
      '<span class="a11yl-pill" style="background:' + c + '22;color:' + c + ';border:1px solid ' + c + '66">' + v.impact + "</span>" +
      '<span class="m">' + (v.wcag && v.wcag.length ? "WCAG " + v.wcag.join(", ") : "best practice") + "</span>" +
      "<h4 style='margin-top:8px'>" + esc(v.help) + "</h4>" +
      '<div class="m">Rule: ' + v.id + "</div>" +
      "<p style='margin:8px 0 4px'>" + esc(v.description) + "</p>" +
      '<div class="m">Selector</div><pre>' + esc(node.target) + "</pre>" +
      '<div class="m">Element</div><pre>' + esc(node.html) + "</pre>" +
      '<div class="m">Suggested fix</div><pre>' + esc(fix) + "</pre>" +
      '<div style="margin-top:8px"><button data-a="fix">Copy fix</button>' +
      '<button data-a="sel">Copy selector</button><button data-a="x">Close</button></div>';
    root.appendChild(card);
    card.style.left = Math.min(x, window.scrollX + window.innerWidth - 400) + "px";
    card.style.top = (y + 26) + "px";
    card.querySelector('[data-a="fix"]').onclick = function () { copy(fix); };
    card.querySelector('[data-a="sel"]').onclick = function () { copy(node.target); };
    card.querySelector('[data-a="x"]').onclick = closeCard;
  }

  function copy(t) { try { navigator.clipboard.writeText(t); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (m) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]; }); }

  var placed = 0;
  violations.forEach(function (v) {
    (v.nodes || []).forEach(function (node) {
      var el;
      try { el = document.querySelector(node.target); } catch (e) { el = null; }
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      var x = r.left + window.scrollX, y = r.top + window.scrollY;
      var c = COLORS[v.impact] || "#5CA8FF";

      var hl = document.createElement("div");
      hl.className = "a11yl-hl";
      hl.style.cssText += "left:" + x + "px;top:" + y + "px;width:" + r.width + "px;height:" +
        r.height + "px;border-color:" + c;
      root.appendChild(hl);

      var dot = document.createElement("button");
      dot.className = "a11yl-dot";
      dot.style.background = c;
      dot.style.left = Math.max(0, x - 11) + "px";
      dot.style.top = Math.max(0, y - 11) + "px";
      dot.style.position = "absolute";
      dot.textContent = "!";
      dot.setAttribute("aria-label", v.impact + " issue: " + v.help);
      dot.onclick = function (e) { e.stopPropagation(); openCard(v, node, x, y); };
      root.appendChild(dot);
      placed++;
    });
  });

  document.addEventListener("click", closeCard, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCard(); }, true);

  window[NS] = { destroy: function () { root.remove(); style.remove(); delete window[NS]; } };
  return placed;
})
`;
