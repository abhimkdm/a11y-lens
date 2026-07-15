# A11y Lens

**An AI accessibility testing platform that proves what it finds.**

Version 2.0 · WCAG 2.1 Level A/AA · Desktop application for Windows and macOS

---

## The problem

Accessibility testing is stuck between two bad options.

**Automated scanners** — axe-core, Lighthouse, WAVE — are fast, free, and catch perhaps 30% of what matters. They read markup. They can tell you an image has no `alt` attribute. They cannot tell you whether the alt text is *meaningful*, whether a keyboard user can actually reach the checkout button, or whether the thing that *looks* like a heading is really a `<div>` that a screen reader will read as nothing at all. A scanner cannot press Tab.

**Manual expert audits** catch the rest — and cost thousands per page, take weeks, and go stale the moment the next sprint ships.

Meanwhile the European Accessibility Act came into force in June 2025. WCAG 2.1 AA is no longer a nice-to-have.

**AI could bridge that gap — except that an AI which hallucinates a finding is worse than no finding at all.** A developer who chases three invented bugs stops trusting the tool, and the tool stops being used.

A11y Lens is built around that last problem.

---

## The core idea: evidence, not opinions

Every finding in A11y Lens falls into one of three tiers, and the tier is always visible.

| Tier | What it means | Can it be wrong? |
|---|---|---|
| **Scanner** | axe-core found a WCAG 2.1 A/AA violation in the markup. | No — it's a rule match. |
| **Measured** | We *measured* it. Focus rings are read from computed styles. Tab order is walked. Reflow is tested at 320px. | **No.** These are measurements, not judgements. A model cannot hallucinate them because no model was involved. |
| **AI (verified)** | The model found something a scanner can't see — and cited a verbatim quote from the page, which we then **checked against the captured DOM**. | Traceable to real evidence. |
| **AI (unverified)** | The model made a claim whose evidence we could **not** find in the page. | **Flagged in orange. Confirm before acting.** |

That last row is the one that matters. Most AI tools present every finding with the same confidence. A11y Lens tells you, per finding, whether it can back it up.

> **How we test this:** we feed the system fabricated findings — a `<dialog>` that isn't on the page, a plausible-but-absent button, a narrative about a carousel that doesn't exist — and confirm every one is caught and flagged. Genuine citations, including quotes embedded in a sentence, still verify. Current pass rate on that suite: **6/6**.

---

## What the AI actually sees

The quality of an AI report is decided entirely by what you feed it. Most tools send the model a list of rule names, and get back advice that could have been written from the rule name alone.

A11y Lens sends the model the page:

- 📸 **A screenshot of the page** — so it can see the layout it's writing about
- 🔍 **A highlighted screenshot of each failing element** — so a fix refers to the *actual* broken control
- 🌳 **The real DOM and accessibility tree** — what a screen reader would announce
- ⌨️ **The full keyboard focus trace** — every Tab stop, with position, size, and whether a focus ring is visible
- 🧭 **The scanner's own results** — with an explicit instruction *not* to re-report them, so the model spends its entire budget on what the scanner cannot see

The result is the difference between:

> ❌ *"Provide an accessible name for the button."*

and

> ✅ *"The `<button class="icon-btn">` in the product carousel contains only an SVG and exposes no accessible name. Screen reader users hear 'button' with no indication of what it does. Add `aria-label="Next product"`, or wrap the SVG in `<span class="sr-only">Next product</span>`."*

Same rule. Completely different value.

---

## The modules

### 🗺️ Crawl Explorer
Discover what to test — and decide it yourself, rather than hoping an AI wanders somewhere useful.

- Import **sitemap.xml** (including nested sitemap indexes), crawl from a **root URL**, or paste a **URL list**
- Builds a **parent–child page tree** — and for flat sources, infers structure from URL paths so you still get something navigable
- **Tree view with checkboxes.** Shift-click toggles a whole subtree. Search, and filter by enabled/disabled/errors
- **Re-crawl** refreshes titles and status codes **without destroying your enable/disable choices** — your curation survives
- **Export/import** the configuration, so a curated page set can be shared or version-controlled

Crawling runs **inside your authenticated browser session** — an anonymous crawler pointed at an enterprise app just maps the login page. And it is read-only by construction: it reads links, and never follows a logout link, because doing so mid-crawl would destroy the session the whole scan depends on.

### 🎯 Scan Center
Three engines, one session.

- **Quick Scan** — axe-core against the current page. Score, violations, per-element screenshots
- **Keyboard Audit** — hidden focusables, keyboard traps, focus indicators
- **Full Scan** — walks the site (AI-driven, or your curated list from Crawl Explorer), scanning each page

Plus:
- **Record path** — click through a real journey (login → cart → checkout) and A11y Lens remembers every page. Scan that exact path later, or save it as JSON and share it
- **Overlay** — draws severity markers directly on the live page, with a tooltip carrying the rule, WCAG criterion, failing HTML, and a suggested fix
- **Inspect toolbar** — alt-text visualiser and screen reader simulator, injected into the page for the checks automation can't fully judge

### 📊 Reports
- **Interactive HTML report** — filterable, searchable, with screenshots embedded
- **Site report** for multi-page scans — a small static report site: index hub, executive summary, site-wide chrome, and a page per URL
- **Session comparison** — element-level diff between any two runs: fixed / new / **regressions** (rules that were clean and broke)
- **Portable sessions** — export a full scan and re-import it on another machine

### 🐞 Logs
Every error and warning, with the full context: the offending model output, the exact parse position, the provider, the URL. One place to look, and one click to copy into a bug report.

---

## The numbers that matter

**Site-wide deduplication.** Scan 19 pages and the same footer contrast failure appears 19 times. A11y Lens detects that a rule fails on most pages, classifies it as **site-wide chrome**, and reports it **once** — tagged *"affects 19 pages"*.

On a simulated 19-page site:

```
Without deduplication:  40 rows
With deduplication:      4 rows
Duplicate rows avoided: 36
```

The report even tells the reader: *"2 findings · reported once instead of 14 times."* One fix to the footer resolves it everywhere — so those findings are listed **first**, because they're the highest-leverage work available.

**Stable finding IDs.** Every finding gets an ID like `AL-813F2CF0`, derived from the rule and its scope. Paste it into a Jira ticket and it still means the same thing next month.

---

## What a scanner structurally cannot see — and we do

axe-core inspects markup. It cannot press Tab. So the entire class of defect that most reliably blocks a keyboard user was invisible — to it, and to every AI report built on top of it.

We measure it directly:

| Defect | Detected by |
|---|---|
| Focus lands on hidden or 0×0 elements | Focus walk |
| Focus jumps far offscreen | Focus walk |
| **Focus order diverges from visual reading order** | Geometry — counts backward jumps up the page |
| Positive `tabindex` overriding natural order | Focus walk |
| **No visible focus indicator** | Computed outline/box-shadow, measured on focus |
| Content requires horizontal scrolling at 320px | Reflow probe (WCAG 1.4.10) |
| Content clipped at 200% text size | Zoom probe (WCAG 1.4.4) |

These arrive as **measured** findings — facts, not opinions.

---

## Security and privacy

Built for enterprise applications behind a login, which means the data is real customer data.

- 🔐 **API keys encrypted at rest** — AES-256-GCM. The key is never returned to the UI, even to the screen you typed it into
- 🏠 **Local-only mode** — one switch blocks every cloud provider. Ollama on your machine, nothing leaves the building
- 🎭 **Sensitive data masking (on by default)** — emails, card numbers, national IDs, tokens and password values are scrubbed before anything is written to disk
- 📸 **Screenshots are opt-in for storage.** They're captured, sent to the model, and *discarded*. A full-page screenshot of a logged-in session can contain a customer's name and order history — so storing it is an explicit, informed choice, not a default
- 📜 **Append-only audit log** — every scan, export, settings change, and AI call
- 🔑 **Credentials never touch A11y Lens.** You log in yourself, in a real browser window

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Desktop app  (Tauri v2 · React 19 · Material UI)│
│  Dashboard · Crawl Explorer · Scan Center        │
│  Reports · Logs · Settings                       │
└───────────────────┬─────────────────────────────┘
                    │  localhost:8787
┌───────────────────┴─────────────────────────────┐
│  Automation sidecar  (Node.js · 23 modules)      │
│                                                  │
│  Playwright ── axe-core ── Element screenshots    │
│  Keyboard & focus probes ── Reflow/zoom probes    │
│  Crawl Explorer ── Path recorder ── Overlay       │
│  AI layer (4 providers) ── Evidence verification  │
│  Report engines ── SQLite ── Encryption           │
└───────────────────┬─────────────────────────────┘
                    │
     ┌──────────────┴──────────────┐
     │  Your app, in a real browser │
     │  (you log in; we never see   │
     │   the credentials)           │
     └──────────────────────────────┘
```

**AI providers:** OpenAI-compatible (incl. corporate LiteLLM gateways), Claude, Gemini, and **Ollama for fully local processing**. Schema-constrained output where the provider supports it, so malformed responses become mechanically impossible rather than merely unlikely.

---

## How it compares

|  | Scanners<br>(axe, Lighthouse) | Typical<br>AI a11y tools | Manual<br>expert audit | **A11y Lens** |
|---|---|---|---|---|
| Speed | Seconds | Minutes | Weeks | Minutes |
| Catches ~30% syntax issues | ✅ | ✅ | ✅ | ✅ |
| Meaningful names, focus management | ❌ | ⚠️ | ✅ | ✅ |
| Keyboard order & focus visibility | ❌ | ❌ | ✅ | ✅ **measured** |
| Visual vs. programmatic mismatch | ❌ | ❌ | ✅ | ✅ (vision) |
| **Tells you which findings to trust** | n/a | ❌ | ✅ | ✅ |
| Works behind a login | ⚠️ | ⚠️ | ✅ | ✅ |
| Run-over-run regression tracking | ❌ | ❌ | ❌ | ✅ |
| Cost per run | Free | $$ | $$$$ | ¢ (or free, locally) |

---

## Status

**Shipping:** Crawl Explorer · Quick Scan · Full Scan · Keyboard audit · Path recording · Overlay & inspect tools · Evidence-grounded AI reports · Site reports with deduplication · Session comparison · Logs · Enterprise security · Windows MSI + macOS DMG installers

**Built, currently disabled by a feature flag:** AI Expert Audit (six user perspectives, deterministic probes, WCAG 2.1 scope enforcement) and two-model Cross-Check (consensus / confirmed / needs-review tiers).

**Next:** benchmark harness — scoring recall against W3C's *Before and After* demo and false-positive rate against known-clean pages. Without it, no accessibility AI can honestly claim it's improving.

---

## Contact

**Abhishek M Kadam** · System Architect
📧 Abhishek.M.Kadam@netcracker.com
💬 Webex: `webexteams://im?space=25f42ac0-7e9d-11f1-a1ea-df11035388c8`
