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
npm i playwright axe-core express better-sqlite3 && npx playwright install chromium
npm run sidecar          # terminal 1 — automation engine on :8787
npm run tauri:dev        # terminal 2 — desktop app (or `npm run dev` for browser-only UI dev)
```
Flow: Scan Center → enter URL → **Open browser** → log in manually → **Quick Accessibility Scan**.

## Next phases (feed to Claude Code one at a time)
Excel/PDF export · full ignore management (reason/owner/expiry).
