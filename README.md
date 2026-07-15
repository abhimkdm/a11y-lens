# A11y Lens v2 — Phases 0–2 (+ interactive reports)

AI accessibility testing desktop platform: Tauri v2 · React 19 · MUI · Zustand · Playwright · axe-core.

## What's implemented
- **Phase 0** — Tauri v2 + React + TS + Vite + MUI foundation, `src/` structure
- **Phase 1** — Dashboard, Scan Center, Reports, Settings screens (dark WCAG-AA UI, keyboard-focus visible)
- **Phase 2 + 5 (core)** — Node sidecar with Playwright: open headed browser → manual login → axe-core Quick Scan (WCAG 2.1 AA) → score, severity counts, per-element findings
- **Phase 6** — AI autonomous crawler: on-origin navigation-only exploration, DENY-list safety filter (delete/submit/payment/approve/logout...), AI action picker (OpenAI-compatible / Claude / Gemini / Ollama) with heuristic fallback, per-page axe scans merged into one report with per-page score breakdown, live progress log, stop button
- **Phase 8** — AI report generator: executive summary, business impact, quick wins, per-rule developer fixes in HTML/React/Angular tabs; shared provider layer (`sidecar/ai.mjs`) for OpenAI-compatible / Claude / Gemini / Ollama; AI report embeds into the interactive HTML export
- **Phase 7 (starter)** — Keyboard audit (hidden focusables, positive tabindex, missing focus indicators)
- **Phase 9 (partial)** — Interactive standalone HTML report (filter by severity, live search, expandable issue cards) + JSON export
- **Phase 10** — SQLite session store (`~/.a11y-lens/sessions.db`): every scan auto-saves; list/load/delete via sidecar API
- **Phase 11** — Import/export: `.a11ysession.json` files round-trip full scans (violations, pages, AI report, screenshot) between machines
- **Phase 13** — Comparison engine: element-level diff (rule + selector) of any two sessions — fixed issues, new issues, regressions (rules that were clean before), score delta — with a comparison view in Reports
- **Inspect Toolbar** (Silktide-inspired manual tools, `sidecar/toolbar.mjs`) — a floating in-page panel with:
  - **Contrast picker** — click any one or two elements, get the exact ratio plus live AA/AAA pass/fail (verified against WCAG's reference values: black/white = 21:1)
  - **Alt-text visualizer** — tags every image on the page as has-alt / decorative / missing, color-coded
  - **Screen reader simulator** — Tab/Shift+Tab walks the reading order (headings, links, buttons, fields, images), announces each in plain language, and speaks it aloud via the Web Speech API where available
  - **Vision simulation** — protanopia/deuteranopia/tritanopia/achromatopsia via SVG color-matrix filters, plus a low-vision blur mode, applied live to the whole page
  - Toggle from Scan Center once a session is open; fully removable, doesn't interfere with the automated overlay
- **Phase 15** — Enterprise security: API keys encrypted at rest (AES-256-GCM, key file 0600 in `~/.a11y-lens`, keychain-upgradeable), keys never returned to the UI; local-processing-only mode (blocks all cloud providers, Ollama only); sensitive-data masking (emails, card numbers, SSNs, tokens, password values scrubbed before persistence); append-only audit log with viewer in Settings
- **Phase 12 (starter)** — Ignore-rule action in the violation list

## PowerShell scripts (Windows & macOS)
```powershell
# Windows — Windows PowerShell 5.1 (built into Windows) or PowerShell 7, either works
powershell -File scripts\launch-dev.ps1              # dev: sidecar + desktop app together (-UiOnly for browser mode)
powershell -File scripts\build-windows.ps1           # MSI + NSIS installers

# macOS — install PowerShell once: brew install --cask powershell
pwsh scripts/launch-dev.ps1
pwsh scripts/build-macos.ps1                          # .app + .dmg (-Universal for arm64+x64)
```
Build scripts compile the sidecar into a standalone binary (@yao-pkg/pkg) matching Tauri's
externalBin convention, then run `tauri build`. Installers land in `src-tauri/target/release/bundle/`.
Prereqs: Node 18+, Rust (MSVC Build Tools on Windows / Xcode CLT on macOS).
Production note: wire `main.rs::start_sidecar` to spawn the bundled sidecar on app start
(dev mode uses `npm run sidecar`). End users need Playwright's Chromium once: `npx playwright install chromium`.

## Run it

```bash
npm install
npx playwright install chromium     # once — browser binaries can't be bundled

npm run tauri:dev                   # ONE command: sidecar + UI + desktop window
```

That's it. `tauri:dev` starts the automation sidecar and the Vite dev server together
(via `concurrently`), then opens the desktop window.

Other entry points:

| Command | What it runs |
|---|---|
| `npm run tauri:dev` | Sidecar + UI + desktop window (**the normal one**) |
| `npm run dev` | Sidecar + UI in the browser — no Rust toolchain needed |
| `npm run dev:ui` | Vite only, for pure UI work |
| `npm run sidecar` | The automation engine on its own |

**In the installed app you never start anything.** Tauri spawns and supervises the sidecar
itself — health check, orphan cleanup, three retries, and a clean kill on exit.

**Port 8787 conflicts sort themselves out.** If a healthy A11y Lens sidecar is already
listening, a second one detects it, says so, and exits cleanly rather than killing your dev
run. If something *else* is holding the port, it says that instead.

### Troubleshooting: "TypeError: Failed to fetch"
This means the UI can't reach the sidecar at `localhost:8787` — always start it separately first:
```bash
npm run sidecar
```
Keep that terminal open while using the app (`launch-dev.ps1` does this for you automatically).
If it still fails, check the sidecar terminal for errors (e.g. missing Chromium — run `npx playwright install chromium`).

## Next phases (feed to Claude Code one at a time)
Excel/PDF export · full ignore management (reason/owner/expiry).

## Recent fixes & additions

**HTML report was rendering blank** — fixed. The AI-fixes section in the exported interactive
HTML report had an under-escaped `\n` inside a template literal, which embedded a literal
newline byte into the generated `<script>` tag and broke it with a syntax error (so nothing
on the page ever rendered). Verified fixed by actually executing the generated report's script
in a real DOM (jsdom) and confirming zero errors, correct score/title/counts, working severity
filters and search, and a correctly rendered AI report section.

**Custom URL list for Full Scan** — optional, toggled by checkbox in Scan Center. Instead of
letting the AI navigate on its own, upload a JSON file listing the exact pages to visit in order:
```json
{ "urls": ["/", "/pricing", "/about", "/contact", "/help/faq"] }
```
or a plain array: `["/pricing", "/about", "https://yourapp.com/help"]`. See `examples/url-list-example.json`.
Same safety rules apply — every URL is checked against the origin of the open browser session;
off-origin, non-http(s), duplicate, or malformed entries are skipped and logged, never followed.

**Record path & scan path** — new section "2 · Record a path" in Scan Center. With a browser
session open, click **Record path**, navigate the journey manually in Chrome (login, add to cart,
checkout...), then **Stop recording**. Every page visited is captured in order (main-frame
navigations only, consecutive duplicates deduped, capped at 200). The recorded path automatically
becomes the custom URL list for Full Scan — hit the scan button and it revisits exactly those
pages. **Save as JSON** exports the path for reuse or sharing; re-upload it later via the URL-list
uploader. Sidecar endpoints: POST /record/start, POST /record/stop, GET /record/status.
Recording is navigation-only by design — no clicks, form input, or timing are captured, which keeps
replay deterministic and avoids storing anything sensitive typed during the session.
