# A11y Lens — Recorded-path v2: action capture, export/import, replay-into-scan

Replaces the URL-only recorder with an **action recorder** that works on SPAs,
saves to disk, re-imports, and replays — either to reproduce a journey or to
**scan every state the journey reveals** (axe + AI audit + interaction pass).

## Apply (these four files are a matched set)
    sidecar/recorder.mjs   (rewritten — v2 action capture; v1 backed up as recorder.v1.bak.mjs, do NOT ship the .bak)
    sidecar/replay.mjs     (new — resolver + step executor + checkpoint navigator)
    sidecar/crawler.mjs    (+ import, + navigator branch in the scan loop)
    sidecar/server.mjs     (+ import, + record/export, record/import, record/replay routes)

Optional: `scripts/test-replay.mjs` — 24 mock assertions, no browser needed:
`node scripts/test-replay.mjs`

## Why the old one "wasn't working"
v1 recorded only the list of URLs visited (via `framenavigated`) and the crawler
replayed it with `page.goto(url)`. On the ecare portal (a SPA) most views don't
change the URL, so there was nothing to `goto` — the recorded "6 pages" couldn't
reproduce an interaction-driven journey. v2 records the **actions**, so replay
reaches each state by re-doing the clicks.

## The approach — ranked selector chain (NOT xpath-first)
Every captured action stores an ORDERED list of ways to find its element. Replay
walks the list top-down and takes the first tier that resolves to exactly one
element:
    data-testid → role + accessible name → label / placeholder / text
                → stable #id → scoped CSS path → XPath (last resort)
This mirrors Playwright codegen. Two payoffs specific to an a11y tool:
- A well-built accessible app is the most replay-stable one (`getByRole(name)`
  just works), so selector robustness and accessibility are the same property.
- If replay is forced to the **XPath** tier, the control had no test id, role,
  name or text — brittle AND invisible to assistive tech. It's promoted to a
  **WCAG 4.1.2** finding (`id: replay-no-accessible-selector`) at that checkpoint,
  not silently tolerated.

## Secrets never touch disk
Password fields, one-time codes, and card/CVV/SSN-like inputs (by type,
autocomplete, or name/label heuristics) are recorded as `{ masked: true }` with
NO value. Export is therefore always safe. `validateRecording` also strips any
value from masked steps on **import**, so a hand-edited file can't smuggle a
secret back in. Replay reuses the QA's already-authenticated session, so masked
steps are simply skipped (set an `onMasked` hook if you ever need pause-for-login).

## Edge cases handled
- caused-vs-manual navigation: a nav within 2s of an action is treated as caused
  (replay re-does the action, does NOT double-`goto`); a standalone nav/reload is
  manual (replay `goto`s it).
- ambiguous match (>1): skips to a more specific tier; only falls back to
  `.first()` if nothing is unique, and logs it.
- slow SPA render: brief `waitFor(attached)` on css/xpath before giving up.
- custom (non-native) `<select>`: falls back to open-then-click-option-by-label.
- checkbox/radio captured on `change` (not the click), file inputs marked
  unreplayable, Enter/Escape captured as `press`, contenteditable handled.
- origin guard: replay refuses if the recording's origin ≠ the open session's
  origin (never drives recorded submits against the wrong host).
- SPA checkpoints sharing a URL are disambiguated (`#state-N`) so distinct states
  aren't merged in the report.
- runaway guards: 2000-step / 300-checkpoint caps; per-step 15s actionability
  timeout; failure throws with the offending step attached for diagnostics.

## New HTTP API (wire the UI to these)
    POST /record/start            begin capture on the open session
    POST /record/stop             -> { entries, steps, checkpoints, recording }
    GET  /record/status           -> { active, entries, steps }
    GET  /record/export           -> { recording }   (Save as JSON — safe, no secrets)
    POST /record/import  {recording} validate + hold in memory for replay
    POST /record/replay/start     { scan?, source?, ai?, aiAudit?, interact?, allowMutations? }
         scan:false -> reproduce only (QA sanity check; returns a fragility summary)
         scan:true  -> drive to each checkpoint and run the full scan on that state
    GET  /record/replay/status    reproduce summary, or crawler status for scan mode

## Recording schema (v2)
    { version:2, kind:"a11y-lens-recording", createdAt, startUrl, origin,
      steps:[ {i,type,target:{selectors[],role,name,tag},value?|masked?,...} ],
      checkpoints:[stepIndex...], entries:[legacy URL list] }
    step.type ∈ navigate | click | fill | select | check | uncheck | press | upload

## Note on the earlier AI-audit-on-revealed-states delta
crawler.mjs here also contains that change (it's the same file). Applying this
delta carries it too — consistent, no conflict.
