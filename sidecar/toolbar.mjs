// A11y Lens Inspect Toolbar — injected into the live page.
// Adds four Silktide-style manual inspection tools on top of the
// automated axe overlay: color contrast picker, vision simulation,
// screen reader simulator, and an alt-text visualizer.
export const TOOLBAR_SOURCE = `
(function () {
  var NS = "__a11yToolbar";
  if (window[NS]) { window[NS].destroy(); }

  var bar = document.createElement("div");
  bar.setAttribute("data-a11y-toolbar", "");
  bar.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;" +
    "background:#161C24;border:1px solid #3a4655;border-radius:12px;padding:10px;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.5);font-family:system-ui,sans-serif;" +
    "display:flex;flex-direction:column;gap:6px;width:216px";
  document.body.appendChild(bar);

  var style = document.createElement("style");
  style.textContent =
    "[data-a11y-toolbar] button{all:unset;display:flex;align-items:center;gap:8px;" +
    "color:#E9EEF5;font-size:12.5px;font-weight:600;padding:8px 10px;border-radius:8px;" +
    "cursor:pointer;box-sizing:border-box;width:100%}" +
    "[data-a11y-toolbar] button:hover{background:#22303f}" +
    "[data-a11y-toolbar] button:focus-visible{outline:2px solid #8AC7FF;outline-offset:1px}" +
    "[data-a11y-toolbar] button.on{background:#8AC7FF22;color:#8AC7FF}" +
    "[data-a11y-toolbar] .a11yt-title{color:#9AA7B4;font-size:10.5px;font-weight:700;" +
    "letter-spacing:1px;padding:4px 10px 0}" +
    "#a11yt-sim{position:fixed;inset:0;z-index:2147483000;pointer-events:none;mix-blend-mode:normal}" +
    "#a11yt-contrast{position:fixed;pointer-events:auto;background:#161C24;color:#E9EEF5;" +
    "border:1px solid #3a4655;border-radius:10px;padding:12px;font-size:12.5px;z-index:2147483647;width:230px}" +
    "#a11yt-sr{position:fixed;bottom:16px;left:16px;right:260px;background:#161C24;color:#E9EEF5;" +
    "border:1px solid #3a4655;border-radius:10px;padding:12px 16px;font-size:14px;z-index:2147483647;" +
    "max-height:120px;overflow:auto}" +
    "#a11yt-sr b{color:#8AC7FF}" +
    ".a11yt-alt-tag{position:absolute;font-size:11px;font-weight:700;padding:2px 6px;" +
    "border-radius:5px;pointer-events:none;z-index:2147483600;white-space:nowrap}";
  document.head.appendChild(style);

  bar.innerHTML =
    '<div class="a11yt-title">A11Y LENS INSPECT</div>' +
    '<button data-t="contrast">\\u25C9 Contrast picker</button>' +
    '<button data-t="alt">\\u1F5BC Alt-text visualizer</button>' +
    '<button data-t="sr">\\u1F50A Screen reader sim</button>' +
    '<div class="a11yt-title">VISION SIMULATION</div>' +
    '<button data-t="vis-none">\\u25CB None</button>' +
    '<button data-t="vis-protanopia">Protanopia (red-blind)</button>' +
    '<button data-t="vis-deuteranopia">Deuteranopia (green-blind)</button>' +
    '<button data-t="vis-tritanopia">Tritanopia (blue-blind)</button>' +
    '<button data-t="vis-achromatopsia">Achromatopsia (no color)</button>' +
    '<button data-t="vis-lowvision">Low vision (blur)</button>' +
    '<button data-t="close" style="color:#FF7B7B">\\u2715 Close toolbar</button>';

  // ---------- Vision simulation (SVG filters) ----------
  var svgFilters =
    '<svg style="position:absolute;width:0;height:0"><defs>' +
    '<filter id="a11yt-f-protanopia"><feColorMatrix type="matrix" values="0.567,0.433,0,0,0 0.558,0.442,0,0,0 0,0.242,0.758,0,0 0,0,0,1,0"/></filter>' +
    '<filter id="a11yt-f-deuteranopia"><feColorMatrix type="matrix" values="0.625,0.375,0,0,0 0.7,0.3,0,0,0 0,0.3,0.7,0,0 0,0,0,1,0"/></filter>' +
    '<filter id="a11yt-f-tritanopia"><feColorMatrix type="matrix" values="0.95,0.05,0,0,0 0,0.433,0.567,0,0 0,0.475,0.525,0,0 0,0,0,1,0"/></filter>' +
    '<filter id="a11yt-f-achromatopsia"><feColorMatrix type="matrix" values="0.299,0.587,0.114,0,0 0.299,0.587,0.114,0,0 0.299,0.587,0.114,0,0 0,0,0,1,0"/></filter>' +
    '</defs></svg>';
  var svgHolder = document.createElement("div");
  svgHolder.innerHTML = svgFilters;
  document.body.appendChild(svgHolder);

  function setVision(mode) {
    document.documentElement.style.filter = "";
    if (mode === "vis-lowvision") document.documentElement.style.filter = "blur(2.5px) contrast(0.9)";
    else if (mode && mode !== "vis-none") document.documentElement.style.filter = "url(#a11yt-f-" + mode.replace("vis-", "") + ")";
    bar.querySelectorAll('[data-t^="vis-"]').forEach(function (b) {
      b.classList.toggle("on", b.dataset.t === mode);
    });
  }

  // ---------- Contrast picker ----------
  var contrastState = { picking: false, first: null };
  var contrastBox = null;
  function luminance(rgb) {
    var a = rgb.map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function parseRgb(str) {
    var m = str.match(/\\d+/g);
    return m ? m.slice(0, 3).map(Number) : [255, 255, 255];
  }
  function contrastRatio(c1, c2) {
    var l1 = luminance(c1) + 0.05, l2 = luminance(c2) + 0.05;
    return l1 > l2 ? l1 / l2 : l2 / l1;
  }
  function pickHandler(e) {
    if (!contrastState.picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    var cs = getComputedStyle(el);
    var color = parseRgb(cs.color);
    var bg = parseRgb(cs.backgroundColor === "rgba(0, 0, 0, 0)" ? "rgb(255,255,255)" : cs.backgroundColor);
    if (!contrastState.first) {
      contrastState.first = { color: color, bg: bg, el: el };
      showContrastBox("First element picked. Now click a second element to compare, or wait to see this element's own text/background contrast.", el);
      var ratio = contrastRatio(color, bg);
      renderContrast(ratio, color, bg, cs.fontSize, cs.fontWeight);
    } else {
      var ratio2 = contrastRatio(contrastState.first.color, color);
      renderContrast(ratio2, contrastState.first.color, color, cs.fontSize, cs.fontWeight);
      contrastState.first = null;
    }
  }
  function renderContrast(ratio, c1, c2, fontSize, fontWeight) {
    var rounded = ratio.toFixed(2);
    var large = parseFloat(fontSize) >= 24 || (parseFloat(fontSize) >= 18.66 && parseFloat(fontWeight) >= 700);
    var aa = ratio >= (large ? 3 : 4.5);
    var aaa = ratio >= (large ? 4.5 : 7);
    if (!contrastBox) {
      contrastBox = document.createElement("div");
      contrastBox.id = "a11yt-contrast";
      document.body.appendChild(contrastBox);
    }
    contrastBox.style.left = "16px"; contrastBox.style.bottom = "16px"; contrastBox.style.top = "";
    contrastBox.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Contrast ratio: ' + rounded + ':1</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px">' +
      '<div style="width:36px;height:36px;border-radius:6px;border:1px solid #3a4655;background:rgb(' + c1.join(",") + ')"></div>' +
      '<div style="width:36px;height:36px;border-radius:6px;border:1px solid #3a4655;background:rgb(' + c2.join(",") + ')"></div>' +
      '</div>' +
      '<div style="color:' + (aa ? "#7BE8B0" : "#FF7B7B") + '">' + (aa ? "\\u2713" : "\\u2715") + ' WCAG AA' + (large ? " (large text)" : "") + '</div>' +
      '<div style="color:' + (aaa ? "#7BE8B0" : "#FFB35C") + '">' + (aaa ? "\\u2713" : "\\u2715") + ' WCAG AAA' + (large ? " (large text)" : "") + '</div>' +
      '<div style="margin-top:8px;color:#9AA7B4;font-size:11px">Click two elements to compare their colors, or one to see its own text/background pair.</div>';
  }
  function showContrastBox(msg) {
    if (!contrastBox) {
      contrastBox = document.createElement("div");
      contrastBox.id = "a11yt-contrast";
      document.body.appendChild(contrastBox);
    }
    contrastBox.style.left = "16px"; contrastBox.style.bottom = "16px";
    contrastBox.innerHTML = '<div>' + msg + '</div>';
  }
  function toggleContrastPicker(on) {
    contrastState.picking = on;
    contrastState.first = null;
    document.body.style.cursor = on ? "crosshair" : "";
    if (on) {
      showContrastBox("Click any element on the page to check its text/background contrast.");
      document.addEventListener("click", pickHandler, true);
    } else {
      document.removeEventListener("click", pickHandler, true);
      if (contrastBox) { contrastBox.remove(); contrastBox = null; }
    }
  }

  // ---------- Alt-text visualizer ----------
  var altTags = [];
  function toggleAlt(on) {
    altTags.forEach(function (t) { t.remove(); });
    altTags = [];
    if (!on) return;
    document.querySelectorAll("img").forEach(function (img) {
      var r = img.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var alt = img.getAttribute("alt");
      var decorative = alt === "";
      var missing = alt === null;
      var tag = document.createElement("div");
      tag.className = "a11yt-alt-tag";
      tag.style.left = (r.left + window.scrollX) + "px";
      tag.style.top = (r.top + window.scrollY - 20) + "px";
      if (missing) { tag.style.background = "#FF5A5A"; tag.style.color = "#111"; tag.textContent = "\\u26A0 missing alt"; }
      else if (decorative) { tag.style.background = "#5CA8FF"; tag.style.color = "#111"; tag.textContent = "decorative (empty alt)"; }
      else { tag.style.background = "#7BE8B0"; tag.style.color = "#111"; tag.textContent = "alt: " + alt.slice(0, 40); }
      document.body.appendChild(tag);
      altTags.push(tag);
    });
  }

  // ---------- Screen reader simulator ----------
  var srBox = null, srIndex = -1, srNodes = [];
  function collectSrNodes() {
    var sel = 'h1,h2,h3,h4,h5,h6,a[href],button,input,select,textarea,[role],img,p,li';
    return Array.from(document.querySelectorAll(sel)).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }
  function describe(el) {
    var role = el.getAttribute("role") || el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(el.tagName.toLowerCase())) return "Heading level " + el.tagName[1] + ": \\"" + el.innerText.trim().slice(0, 100) + "\\"";
    if (el.tagName === "IMG") return "Image: " + (el.getAttribute("alt") || "[no alt text \\u2014 announced as filename by many screen readers]");
    if (el.tagName === "A") return "Link: \\"" + (el.innerText.trim() || el.getAttribute("aria-label") || "[unlabeled link]") + "\\"";
    if (el.tagName === "BUTTON" || role === "button") return "Button: \\"" + (el.innerText.trim() || el.getAttribute("aria-label") || "[unlabeled button]") + "\\"";
    if (el.tagName === "INPUT") return (el.getAttribute("type") || "text") + " field: " + (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "[no accessible name]");
    if (el.tagName === "LI") return "List item: \\"" + el.innerText.trim().slice(0, 80) + "\\"";
    return role + ": \\"" + el.innerText.trim().slice(0, 100) + "\\"";
  }
  function srShow(el) {
    var r = el.getBoundingClientRect();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    document.querySelectorAll(".a11yt-sr-focus").forEach(function (n) { n.classList.remove("a11yt-sr-focus"); });
    var hl = document.getElementById("a11yt-sr-hl") || document.createElement("div");
    hl.id = "a11yt-sr-hl";
    hl.style.cssText = "position:absolute;border:3px solid #8AC7FF;border-radius:4px;pointer-events:none;z-index:2147483646;transition:all .15s";
    document.body.appendChild(hl);
    hl.style.left = (r.left + window.scrollX - 3) + "px";
    hl.style.top = (r.top + window.scrollY - 3) + "px";
    hl.style.width = r.width + "px";
    hl.style.height = r.height + "px";
    if (!srBox) {
      srBox = document.createElement("div");
      srBox.id = "a11yt-sr";
      document.body.appendChild(srBox);
    }
    var text = describe(el);
    srBox.innerHTML = '<b>\\u25B6 ' + (srIndex + 1) + ' / ' + srNodes.length + '</b><br>' + text +
      '<div style="margin-top:8px;color:#9AA7B4;font-size:11px">Tab / Shift+Tab to move \\u00B7 Esc to close. This simulates reading order, not exact screen reader output.</div>';
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text.replace(/[\\"\\u25B6]/g, ""));
        u.rate = 1.05;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }
  }
  function srKeyHandler(e) {
    if (!srBox) return;
    if (e.key === "Escape") { toggleSr(false); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      srIndex = e.shiftKey ? Math.max(0, srIndex - 1) : Math.min(srNodes.length - 1, srIndex + 1);
      srShow(srNodes[srIndex]);
    }
  }
  function toggleSr(on) {
    if (on) {
      srNodes = collectSrNodes();
      srIndex = 0;
      if (srNodes.length) srShow(srNodes[0]);
      document.addEventListener("keydown", srKeyHandler, true);
    } else {
      document.removeEventListener("keydown", srKeyHandler, true);
      if (srBox) { srBox.remove(); srBox = null; }
      var hl = document.getElementById("a11yt-sr-hl");
      if (hl) hl.remove();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    }
  }

  // ---------- wire buttons ----------
  bar.addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    var t = btn.dataset.t;
    if (t === "close") { window[NS].destroy(); return; }
    if (t === "contrast") {
      var on = !btn.classList.contains("on");
      toggleContrastPicker(on);
      btn.classList.toggle("on", on);
    } else if (t === "alt") {
      var on2 = !btn.classList.contains("on");
      toggleAlt(on2);
      btn.classList.toggle("on", on2);
    } else if (t === "sr") {
      var on3 = !btn.classList.contains("on");
      toggleSr(on3);
      btn.classList.toggle("on", on3);
    } else if (t && t.indexOf("vis-") === 0) {
      setVision(t);
    }
  });

  window[NS] = {
    destroy: function () {
      toggleContrastPicker(false);
      toggleAlt(false);
      toggleSr(false);
      document.documentElement.style.filter = "";
      bar.remove(); style.remove(); svgHolder.remove();
      delete window[NS];
    },
  };
  return true;
})
`;
