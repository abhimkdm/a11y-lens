# A11y Lens — stop re-scanning identical controls + uniform report blocks

Two changes. All sidecar. `node --check` clean; 11 mock assertions pass
(`node scripts/test-dedupe-block.mjs`).

## Files
    sidecar/interact.mjs        (+ scan-wide interaction de-dup)
    sidecar/crawler.mjs         (+ shared scanCache, injects dedupe into interaction deps)
    sidecar/finding-block.mjs   (new — toBlock() normalizer + codeExample dictionary)
    sidecar/report-site.mjs     (+ carries evidence/recommendation/codeExample through dedup)
    sidecar/report-site-html.mjs(+ renders Evidence / Recommendation / Code example + CSS)

## 1. No more re-scanning the same controls (the duplicates)
The interaction pass was opening + AI-auditing every interactive control on every
page. On a 158-page shop, the site-global chrome — "Filter", "Kontantpris", "Mest
populære", "Log ind" — got opened and audited 158 times each, costing an AI call
per page and flooding the report with the identical 0-finding state.

Now a scan-wide cache keys each control by (kind + role + normalized accessible
name), digits collapsed so "Item 1 / Item 2" count as one. The first time a
control is seen it's audited; every identical control later in the scan is skipped
("Skipped N control(s) already audited earlier this scan"). Its finding, if any,
is still recorded once. This cuts the repeated AI-audit calls and the duplicate
report rows at the source, and frees the per-page interaction budget for genuinely
new controls.

Why here and not just report-side dedup: skipping the WORK saves the tokens/time.
Report-side dedup (already present via report-site) only tidies the output after
you've already paid for 158 identical audits.

## 2. Uniform finding block { severity, wcag, description, evidence, recommendation, codeExample }
AI-audit findings already carried this shape; deterministic (axe) and measured
(interaction) findings did not, and the report card only showed Description.
`finding-block.mjs#toBlock()` maps ANY finding to the flat block: impact→severity,
help→recommendation, wcag[]→single most-specific wcag, evidence from the node HTML,
and a codeExample — kept as-is for AI findings, or synthesized from a ~45-rule fix
dictionary for axe/measured rules (unknown rules get "", never a fabricated snippet).
The site report now carries these fields through de-dup and the HTML card renders
Evidence, Recommendation, and a syntax-highlighted Code example block.

## Two things I noticed (not changed here — say the word)
- **"22 / 7 checkpoints scanned / 100%"** in the agent panel: the progress numerator
  counts every recorded scan row (pages + interaction sub-states), while the
  denominator is checkpoints. The dedup above reduces the inflation but the mismatch
  is a real display bug — the panel should count checkpoints reached, not all rows.
  One-line frontend fix.
- **"AI audit failed … multimodal data but multimodal processing is not enabled"**:
  the state audits are sending a screenshot to a text-only model. Same root cause as
  the earlier mobile 400. Fix is to gate the screenshot when the configured model
  isn't vision-capable (or route to one). I can add that guard in ai-audit.mjs.

## Optional stronger lever (not enabled)
A page-template cache (skip the AI *page* audit on structurally-identical pages)
would cut cost further, but risks skipping page-specific AI judgement, so I left it
off by default. Easy to add behind a flag if you want it.
