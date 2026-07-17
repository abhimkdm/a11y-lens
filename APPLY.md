# A11y Lens — AI audit on interaction-revealed states (delta)

Closes the gap where AI Full Scan only audited the base page: the AI expert
review now follows the interaction pass into each opened modal / drawer / menu /
expander / validation-error state, exactly where focus-trap, aria-modal, Escape,
focus-return, option-announcement and error-announcement findings live.

## Apply
Overwrite these three files (apply together — they're a matched set):

    sidecar/interact.mjs
    sidecar/ai-audit.mjs
    sidecar/crawler.mjs

`scripts/test-interact-aiaudit.mjs` is an optional mock test:  `node scripts/test-interact-aiaudit.mjs`

## What changed
- **interact.mjs** — `exploreInteractions` accepts an optional injected
  `deps.auditState`. `openAndCheck`, `probeValidation` and `fillAndSubmit` each
  call it *while the state is live*, folding the AI findings into that scenario.
  In `openAndCheck` the AI audit runs BEFORE the Escape probe (which can dismiss
  the dialog). Measured + axe rule ids for the state are passed as the
  suppression list so the model never re-reports what's already found. No new
  imports — the module keeps zero hard dependency on the AI client.
- **ai-audit.mjs** — `auditPageAi` gains an optional `stateContext {trigger,kind}`.
  When present it prepends an "INTERACTION-REVEALED STATE" block telling the model
  to review only the newly revealed UI and NOT re-audit the inert base page
  behind an open modal (prevents base-page duplicate floods).
- **crawler.mjs** — injects `auditState` into the interaction deps, but only when
  `aiAudit && ai.provider`. Tokens accumulate into the same `aiUsage` total;
  revealed-state audits are counted in a new `aiAuditStates` and surfaced as
  `statesAudited` in the AI cost report. Findings carry `source:"ai-audit"`, so
  they flow through per-page records, cross-page dedupe and the cost report
  unchanged.

## Behaviour notes
- Coverage now depends on the interaction toggle: a drawer behind a click is
  covered only when "Interact with each page" is on (it's what opens the drawer).
  A drawer already open on load was, and still is, covered by the base-page audit.
- Cost scales with revealed states: each opened state that AI-audits is one extra
  model call. The interaction cap (`maxInteractions`, default 12) bounds it per page.
