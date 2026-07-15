# A11y Lens — Developer Guide

Setup, architecture, and the traps we already fell into so you don't have to.

---

## 1. Prerequisites

| | Version | Why |
|---|---|---|
| **Node.js** | **≥ 22.5** | Non-negotiable. We use `node:sqlite`, Node's built-in SQLite, which lands in 22.5. The build also ships *your* Node binary as the app's runtime. |
| **Rust** | stable | Tauri shell. Install via [rustup](https://rustup.rs). |
| **MSVC Build Tools** | Windows only | Visual Studio Build Tools + *"Desktop development with C++"*. |
| **Xcode CLT** | macOS only | `xcode-select --install` |
| **Python + Pillow** | optional | Only to regenerate icons (`npm run icons`). |

---

## 2. Run it (development)

```bash
npm install
npx playwright install chromium      # browser binaries — cannot be bundled, see §7
```

Then **two terminals**:

```bash
# Terminal 1 — the automation sidecar
npm run sidecar                      # http://localhost:8787

# Terminal 2 — the desktop app
npm run tauri:dev                    # or: npm run dev  (browser only, no Rust needed)
```

Or use the launcher, which does both:

```powershell
powershell -File scripts\launch-dev.ps1          # Windows
pwsh scripts/launch-dev.ps1                      # macOS (brew install --cask powershell)
powershell -File scripts\launch-dev.ps1 -UiOnly  # skip Rust entirely
```

> **In dev, Tauri does *not* spawn the sidecar.** You're running it yourself, and two servers fighting over port 8787 is worse than none. In a packaged build, Rust owns it.

---

## 3. Build installers

```bash
npm run tauri:build     # stages the sidecar, then bundles
```

This is **not** the same as `npx tauri build` — it runs `sidecar:build` first. Skip it and you ship an app with no automation engine.

Output lands in `src-tauri/target/release/bundle/` — MSI + NSIS on Windows, DMG + .app on macOS.

Platform scripts:
```powershell
powershell -File scripts\build-windows.ps1
pwsh scripts/build-macos.ps1 -Universal
```

---

## 4. Architecture

```
src/                      React 19 + TypeScript + MUI + Zustand
  pages/                  Dashboard · CrawlExplorer · ScanCenter · Reports · Logs · Settings
  components/             ScoreRing · ViolationList · ElementEvidence · AiReportPanel
                          ExpertAuditPanel · SidecarGate · ErrorBanner · ContactCard
  services/api.ts         Every sidecar call. All errors routed through req()
  store/useAppStore.ts    Zustand
  utils/reportHtml.ts     Standalone interactive HTML report

sidecar/                  Node.js automation engine — 23 modules, HTTP on :8787
src-tauri/                Rust shell: spawns and supervises the sidecar
scripts/                  build-sidecar.mjs · build-windows.ps1 · build-macos.ps1 · make-icons.py
```

### Sidecar module map

| Module | Responsibility |
|---|---|
| `server.mjs` | Express app, 47 endpoints, session state |
| `db.mjs` | SQLite (`node:sqlite`). Sessions, settings, logs, audit, crawls |
| **Scanning** | |
| `crawler.mjs` | Full Scan — AI-driven navigation or a fixed URL list |
| `crawl-explorer.mjs` | Sitemap import, BFS link discovery, URL-tree building |
| `recorder.mjs` | Path recording via Playwright's `framenavigated` |
| `element-shots.mjs` | Per-element highlighted screenshots |
| `keyboard-evidence.mjs` | Focus walk, tab order, focus-visibility, trap analysis |
| `probes.mjs` | Deterministic focus-visible + zoom/reflow probes |
| `evidence.mjs` | Screenshot + sanitized DOM + ARIA tree capture |
| **AI** | |
| `ai.mjs` | One `chat()` for 4 providers. `aiStructured()` adds vision + schema constraint |
| `report.mjs` | Evidence-grounded AI report + evidence verification |
| `report-site.mjs` | Cross-page deduplication, stable IDs, executive summary |
| `report-site-html.mjs` | Multi-page static HTML report writer |
| `json-repair.mjs` | Tolerant JSON parsing — repair, then salvage |
| `wcag.mjs` | WCAG 2.1 A/AA scope guard |
| `expert-audit.mjs`, `expert-prompt.mjs`, `cross-check.mjs` | Expert Audit (flagged off) |
| **Support** | |
| `security.mjs` | AES-256-GCM vault, PII masking, local-only enforcement |
| `compare.mjs` | Element-level session diffing |
| `overlay.mjs`, `toolbar.mjs` | Injected page scripts |
| `cost.mjs` | Token cost estimation |

### Data locations

| What | Where |
|---|---|
| Database | `~/.a11y-lens/sessions.db` |
| Encryption key | `~/.a11y-lens/.keyfile` (0600) |
| Exported reports | `~/A11yLens/reports/` |

Override with `A11Y_DATA_DIR` and `A11Y_EXPORT_DIR`.

---

## 5. Feature flags

Two features are built, tested, and currently hidden:

```ts
// src/pages/ScanCenter.tsx
const SHOW_EXPERT_AUDIT = false;   // AI Expert Audit, probes, scope selector

// src/pages/Settings.tsx
const SHOW_CROSS_CHECK = false;    // Second-opinion model config
```

**Flip both together** — cross-check is only reachable from the Expert Audit. All backend endpoints remain live.

---

## 6. API surface (47 endpoints)

```
GET  /health                       identifies the sidecar (Rust probes this)
POST /session/open                 launch headed browser
POST /scan/quick                   axe + element shots + keyboard evidence
POST /scan/keyboard                keyboard audit
POST /scan/full/{start,stop}       GET /scan/full/status
POST /audit/expert                 expert audit (single or cross-check)
POST /report/ai                    evidence-grounded AI report
POST /report/site                  multi-page deduplicated report site
POST /overlay/{show,clear}         POST /toolbar/{show,hide}
POST /record/{start,stop}          GET /record/status

POST /crawl/start                  crawl | sitemap | list
GET  /crawl/status                 POST /crawl/stop
GET  /crawls                       GET/DELETE /crawls/:id
PATCH /crawls/:id/urls             enable/disable pages
POST /crawls/:id/recrawl           GET /crawls/:id/export
POST /crawls/import

GET/POST/PUT/DELETE /sessions[/:id]
POST /sessions/import              POST /compare
POST /export                       writes a file to disk (see §7)

GET/POST /settings/ai              /settings/ai/providers · /test · /crosscheck
GET/POST /settings/security
GET/POST/DELETE /logs              GET /audit
```

---

## 7. Traps we already hit

These cost real time. Each one is now handled — don't undo them.

### ❌ `pkg` cannot bundle Playwright
The first packaging attempt compiled the sidecar to a single `.exe`. It died instantly on every installed machine:

```
Error: Cannot find module '/snapshot/.../playwright-core/browsers.json'
```

`pkg` packs code into a virtual snapshot filesystem, but `playwright-core` does **runtime lookups for real files**. They don't exist inside the snapshot.

**Fix:** ship a real Node runtime (renamed `a11y-node`, so orphan-killing can only ever target *ours*) plus the sidecar source as a Tauri resource. Rust spawns `a11y-node <resources>/sidecar/server.mjs`. That's what `scripts/build-sidecar.mjs` prepares.

### ❌ `better-sqlite3` is a native addon
Two failure modes: `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch whenever Node is upgraded, and `.node` binaries don't bundle reliably.

**Fix:** `node:sqlite` — built into Node, zero addons. Same API surface for our usage (`prepare`/`run`/`get`/`all`, `@named` params). **This is why Node ≥ 22.5 is mandatory.**

### ❌ Tauri's webview ignores `<a download>`
Blob-URL downloads are a *browser* API. WebView2/WKWebView silently do nothing — clicking Export appeared to work and produced no file.

**Fix:** the sidecar writes the file with Node (`POST /export`) and returns the path. The blob fallback remains for browser dev mode.

### ❌ CORS
The Tauri webview runs on `tauri://localhost`. Without `cors()` on the sidecar, every request fails as `TypeError: Failed to fetch`.

### ❌ Models emit invalid JSON
A model asked for an Angular snippet returned:
```js
"angular": `<img [src]="url" alt="...">`
```
Backticks are valid JavaScript and invalid JSON. `JSON.parse` threw, and the **entire report** — summary, business impact, every other fix — was discarded over one bad field.

**Fix (two layers):**
1. **Prevention** — `aiStructured()` uses schema-constrained decoding (Ollama `format`, OpenAI `json_schema`, Gemini `responseSchema`). Invalid JSON becomes mechanically impossible.
2. **Cure** — `json-repair.mjs` degrades in stages: parse → repair (backticks, raw newlines, trailing commas) → *salvage* individual objects that do parse. A malformed 8th fix must never cost you the other 7.

### ❌ Rust: `MutexGuard` outliving `state` (E0597)
```rust
// ✗ the if-let scrutinee's temporaries live to the end of the block
if let Ok(mut guard) = state.0.lock() { ... }

// ✓ temporaries drop at the semicolon; `child` is owned
let child = state.0.lock().ok().and_then(|mut g| g.take());
```

### ❌ Tauri v2 denies shell access by default
Spawning the sidecar and opening `mailto:` / `webexteams:` links both need explicit permissions in `src-tauri/capabilities/default.json`. Without them they fail at runtime with correct code.

### ⚠️ Playwright's Chromium is not bundled
Browser binaries genuinely cannot be packed into an installer. First launch on a clean machine needs `npx playwright install chromium`. **This is the last open item for a clean end-user install** — the app detects it and shows a retry screen, but a one-click download flow is still to build.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `TypeError: Failed to fetch` | Sidecar isn't running | `npm run sidecar` |
| "The automation engine didn't start" | Chromium missing, or port 8787 held | Error screen now shows the sidecar's real stderr. Rust already retries 3× and kills orphaned `a11y-node` processes |
| `ERR_DLOPEN_FAILED` | Stale `better-sqlite3` | It's gone — delete `node_modules`, reinstall |
| `Couldn't find a .ico icon` | Icons missing | `npm run icons` |
| Ollama: `failed to allocate buffer` | Model too big for RAM | Smaller model, or switch to a cloud provider |
| AI report is generic | Model isn't vision-capable | The report *sends* screenshots; a text-only model ignores them |
| Corporate gateway unreachable from Node but fine in PowerShell | Proxy or TLS inspection | `$env:HTTPS_PROXY` / `$env:NODE_EXTRA_CA_CERTS` before `npm run sidecar` |

---

## 9. Testing

There's no formal suite yet — every module was verified by executing it against mocked Playwright pages and mocked model responses. Worth preserving as you extend:

- **Evidence verification** — feed it fabricated findings (an absent `<dialog>`, a plausible-but-missing button, a pure narrative) and confirm each is flagged `unverified`. Genuine citations, including quotes inside a sentence, must still pass. *Current: 6/6.*
- **Deduplication** — a 19-page site with shared chrome must collapse 40 rows to 4.
- **Crawl safety** — logout, delete, off-origin, and asset links must never be followed.
- **Crawl curation** — a re-crawl must update titles **without** resetting the user's enable/disable choices.
- **HTML export** — execute the generated report in jsdom and assert zero script errors. A single stray backslash in the inline `<script>` silently blanks the entire report; this caught it once already.

---

## 10. Conventions

- **Never lose the user's work.** A failed screenshot must not lose the scan. A malformed fix must not lose the report. Degrade, log, and say so.
- **Measured beats inferred.** Anything measurable is measured — never asked of a model.
- **Say what you can't back up.** Unverified findings are labelled, not hidden or silently trusted.
- **Errors go to `/logs`** with full context, and the UI points there rather than swallowing them.

---

**Maintainer:** Abhishek M Kadam · System Architect · Abhishek.M.Kadam@netcracker.com
