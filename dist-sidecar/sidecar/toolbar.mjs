// A11y Lens Inspect Toolbar — injected into the live page.
// Silktide-style manual inspection tools on top of the automated axe
// overlay: alt-text visualizer and screen reader simulator.
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
    "#a11yt-sr{position:fixed;bottom:16px;left:16px;right:260px;background:#161C24;color:#E9EEF5;" +
    "border:1px solid #3a4655;border-radius:10px;padding:12px 16px;font-size:14px;z-index:2147483647;" +
    "max-height:120px;overflow:auto}" +
    "#a11yt-sr b{color:#8AC7FF}" +
    ".a11yt-alt-tag{position:absolute;font-size:11px;font-weight:700;padding:2px 6px;" +
    "border-radius:5px;pointer-events:none;z-index:2147483600;white-space:nowrap}";
  document.head.appendChild(style);

  bar.innerHTML =
    '<div class="a11yt-title">A11Y LENS INSPECT</div>' +
    '<button data-t="alt">\\u{1F5BC} Alt-text visualizer</button>' +
    '<button data-t="sr">\\u{1F50A} Screen reader sim</button>' +
    '<button data-t="close" style="color:#FF7B7B">\\u2715 Close toolbar</button>';

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
    if (t === "alt") {
      var on2 = !btn.classList.contains("on");
      toggleAlt(on2);
      btn.classList.toggle("on", on2);
    } else if (t === "sr") {
      var on3 = !btn.classList.contains("on");
      toggleSr(on3);
      btn.classList.toggle("on", on3);
    }
  });

  window[NS] = {
    destroy: function () {
      toggleAlt(false);
      toggleSr(false);
      bar.remove(); style.remove();
      delete window[NS];
    },
  };
  return true;
})
`;
