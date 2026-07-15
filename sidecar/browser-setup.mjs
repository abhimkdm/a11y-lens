// A11y Lens — browser engine bootstrap.
//
// The last gap in a clean install. Playwright's Chromium (~150MB) genuinely
// cannot be packed into an installer, so on a fresh machine the app installs
// fine, starts fine, and then fails the moment someone clicks Scan:
//
//   browserType.launch: Executable doesn't exist at ...\chrome.exe
//
// The usual advice is "run npx playwright install chromium" — which is useless
// to the person this tool is FOR. A QA tester with an MSI has no terminal, no
// Node, and no npx.
//
// But we already ship two things that solve it: Playwright's own CLI (in the
// bundled node_modules) and a Node runtime (a11y-node, which IS process.execPath
// in the packaged app). So the app can install its own browser, with a progress
// bar, from a button. No terminal, ever.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);

/** Where Playwright expects Chromium, and whether it's actually there. */
export function browserStatus() {
  try {
    const { chromium } = require_("playwright");
    const path = chromium.executablePath();
    return { installed: existsSync(path), path };
  } catch (e) {
    return { installed: false, path: null, error: String(e.message ?? e) };
  }
}

// Locate Playwright's CLI.
//
// `require.resolve("playwright/cli.js")` LOOKS right and fails: modern Playwright
// declares an `exports` map in its package.json, and deep imports that aren't
// listed there are blocked by the resolver even though the file is sitting right
// on disk. So resolve the package entry point and walk to its sibling instead.
function resolvePlaywrightCli() {
  const candidates = [];
  try {
    const entry = require_.resolve("playwright"); // .../playwright/index.js
    candidates.push(join(dirname(entry), "cli.js"));
  } catch { /* not installed */ }
  try {
    const core = require_.resolve("playwright-core");
    candidates.push(join(dirname(core), "cli.js"));
  } catch { /* ignore */ }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function createBrowserInstaller() {
  const state = {
    running: false,
    done: false,
    error: null,
    progress: "",     // last meaningful line from the installer
    log: [],
  };

  const log = (line) => {
    const t = String(line).trim();
    if (!t) return;
    state.log.push(t);
    if (state.log.length > 200) state.log.shift();
    // Playwright prints "Downloading Chromium 141.0 - 158 MiB [====>  ] 34% 12.1s"
    if (/download|install|chromium|%/i.test(t)) state.progress = t.slice(0, 160);
  };

  function install() {
    if (state.running) return;

    const cli = resolvePlaywrightCli();
    if (!cli) {
      state.error = "Playwright's installer is missing from this build. Reinstall A11y Lens.";
      return;
    }

    state.running = true;
    state.done = false;
    state.error = null;
    state.log = [];
    state.progress = "Starting download…";

    // process.execPath is the bundled Node runtime in the packaged app, and the
    // developer's own Node in dev. Either way it can run Playwright's CLI —
    // so the user never needs Node or npx installed.
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
    });

    child.stdout.on("data", (d) => String(d).split(/\r?\n|\r/).forEach(log));
    child.stderr.on("data", (d) => String(d).split(/\r?\n|\r/).forEach(log));

    child.on("error", (e) => {
      state.running = false;
      state.error = `Could not start the browser installer: ${e.message}`;
    });

    child.on("close", (code) => {
      state.running = false;
      const status = browserStatus();
      if (code === 0 && status.installed) {
        state.done = true;
        state.progress = "Browser engine installed.";
      } else {
        // Don't claim success just because the process exited 0 — check the file
        // is actually on disk. A corporate proxy can fail the download silently.
        state.error =
          code === 0
            ? "The installer finished but Chromium is still missing. A proxy or firewall may have blocked the download."
            : `The browser installer exited with code ${code}. See the log below.`;
      }
    });
  }

  return { state, install };
}
