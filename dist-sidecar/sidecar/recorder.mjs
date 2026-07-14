// A11y Lens path recorder.
//
// Records the sequence of pages a QA person visits during a normal manual
// browsing session (login, navigate to checkout, etc.) by listening to
// Playwright's `framenavigated` event on the page's main frame. The result
// is an ordered list of URLs — the exact same shape the crawler's custom
// URL-list mode already consumes — so "scan the recorded path" is just
// "run a full scan with urlList = recordedEntries.map(e => e.url)".
//
// This intentionally does NOT record clicks, form input, or timing — only
// which pages were visited, in order. That's enough to reproduce a
// navigation journey deterministically without the fragility of replaying
// exact selectors/coordinates against a page that may render differently
// on a later run.
export function createRecorder() {
  const state = {
    active: false,
    startedAt: null,
    entries: [], // { url, title, timestamp }
  };

  let listener = null;
  let boundPage = null;

  function pushEntry(url, title) {
    const last = state.entries[state.entries.length - 1];
    if (last && last.url === url) return; // dedupe consecutive repeats (hash-only changes, re-renders)
    state.entries.push({ url, title: title ?? "", timestamp: new Date().toISOString() });
    if (state.entries.length > 200) state.entries.shift(); // hard cap so a forgotten recording can't grow unbounded
  }

  async function start(page) {
    if (!page) throw new Error("No browser session. Open one first.");
    if (state.active) throw new Error("Already recording.");

    state.active = true;
    state.startedAt = new Date().toISOString();
    state.entries = [];
    boundPage = page;

    // Record the page already open when recording starts — framenavigated
    // only fires on subsequent navigations, not the current URL.
    const initialUrl = page.url();
    if (/^https?:/.test(initialUrl)) {
      const title = await page.title().catch(() => "");
      pushEntry(initialUrl, title);
    }

    listener = async (frame) => {
      try {
        if (frame !== boundPage.mainFrame()) return; // ignore iframe navigations
        const url = frame.url();
        if (!/^https?:/.test(url)) return;
        const title = await boundPage.title().catch(() => "");
        pushEntry(url, title);
      } catch {
        // page may be closing/navigating away mid-event; ignore
      }
    };
    page.on("framenavigated", listener);
  }

  function stop() {
    if (boundPage && listener) boundPage.off("framenavigated", listener);
    state.active = false;
    listener = null;
    boundPage = null;
    return state.entries;
  }

  return { state, start, stop };
}
