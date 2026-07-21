// Browser registry.
//
// Adding an engine should be data, not code. Each entry says which Playwright
// engine to drive, which installed channel to prefer, and how it is obtained:
//
//   install: "channel"  -> uses the browser ALREADY on the machine (Chrome, Edge).
//                          Right for enterprise QA: you test what users actually run,
//                          at the version they actually have.
//   install: "download" -> Playwright ships its own build (Chromium, Firefox, WebKit).
//
// A deliberate honesty note lives in the registry itself: `webkit` is the WebKit
// ENGINE, not Safari. Same renderer and DOM semantics, but it is not Safari the
// browser and it cannot exercise VoiceOver. Anyone reading a report needs to know
// which of those two claims they are entitled to make.

export const BROWSERS = {
  chrome: {
    id: "chrome", engine: "chromium", channel: "chrome",
    label: "Chrome", family: "Chromium", install: "channel", default: true,
  },
  edge: {
    id: "edge", engine: "chromium", channel: "msedge",
    label: "Edge", family: "Chromium", install: "channel",
    note: "Same engine as Chrome — expect near-identical rule findings. Useful for validating the browser your organisation actually deploys.",
  },
  chromium: {
    id: "chromium", engine: "chromium", channel: null,
    label: "Chromium", family: "Chromium", install: "download",
    note: "Playwright's bundled build. Use when Chrome is not installed.",
  },
  firefox: {
    id: "firefox", engine: "firefox", channel: null,
    label: "Firefox", family: "Gecko", install: "download",
    note: "Different accessibility tree and accessible-name computation — genuinely different findings, not a duplicate run.",
  },
  webkit: {
    id: "webkit", engine: "webkit", channel: null,
    label: "Safari (WebKit)", family: "WebKit", install: "download",
    note: "The WebKit engine, NOT Safari itself, and no VoiceOver. Also note WebKit does not Tab to links or radio buttons unless Full Keyboard Access is on — differing keyboard results here are a real finding about Safari users, not a tool bug.",
  },
};

export const DEFAULT_BROWSER = "chrome";

export function getBrowser(id) {
  return BROWSERS[String(id || "").toLowerCase()] || BROWSERS[DEFAULT_BROWSER];
}

export function listBrowsers() {
  return Object.values(BROWSERS);
}

// Launch options for a registry entry. Channel entries fall back to the bundled
// engine when the channel is missing, so a machine without Edge still works
// instead of failing at launch with a Playwright stack trace.
export function launchPlan(id) {
  const b = getBrowser(id);
  const plan = [];
  if (b.channel) plan.push({ engine: b.engine, options: { headless: false, channel: b.channel }, describe: `${b.label} (installed channel)` });
  plan.push({ engine: b.engine, options: { headless: false }, describe: `${b.label} (bundled ${b.engine})` });
  return { browser: b, plan };
}

// Context options per engine. `viewport: null` (use the real window size) is a
// Chromium behaviour; on Gecko and WebKit it is unreliable, so those get an
// explicit desktop viewport instead of a surprise.
export function contextOptions(id) {
  const b = getBrowser(id);
  return b.engine === "chromium"
    ? { viewport: null }
    : { viewport: { width: 1440, height: 900 } };
}

// Which Playwright engines must be downloaded for a given set of browser ids.
export function requiredDownloads(ids) {
  const out = new Set();
  for (const id of ids) {
    const b = getBrowser(id);
    if (b.install === "download") out.add(b.engine);
    else out.add("chromium"); // channel entries still need chromium as the fallback
  }
  return [...out];
}
