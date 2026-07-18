# A11y Lens — screenshots with RED outlined callouts actually appear

`node --check` clean; sample report rendered and verified.

## Files
    sidecar/ai-audit.mjs        (asks the model for a selector; resolves it to a real box)
    sidecar/crawler.mjs         (one screenshot per SCAN ROW; stamps shotKey + callout number)
    sidecar/report-site-html.mjs(numbered red callouts on the row's screenshot)
    sidecar/element-shots.mjs   (unchanged from the full-page delta; included for completeness)

## Why no images were appearing (two real bugs)
**1. AI findings had no element to outline.** An AI finding's node was built as
`{ target: url }` — the PAGE URL, not a CSS selector. Nothing could be located, so
no box, so no screenshot. That is exactly your first image: "Failing elements (1
total, showing 1)" followed by an empty box and a URL.
Fixed: `selector` is now a REQUIRED field in the audit schema, with a prompt rule
telling the model to copy real attributes from the DOM it was given (id, name,
class, aria-label, data-*) and never return a URL/XPath/guess. Immediately after the
audit — while the state is still open — each selector is resolved on the live page
into a bounding box AND the element's real outerHTML. Doing it there matters: an
interaction-revealed drawer is gone by the time the report is built.

**2. Interaction states overwrote each other's screenshot.** Shots were keyed by
URL pathname, but a drawer/modal state shares the page's URL — so every revealed
state clobbered the base page's image. Now each shot is keyed by the SCAN ROW
(`/checkout||Checkout — Step 5b - SaldoMax limit`), which is also what the report
labels the image with, so a state's screenshot is its own.

## Callouts (matching your second image)
Each node gets a `callout` number at record time. The report draws a RED rounded
rectangle over each failing element on that row's full-page screenshot, with a
numbered circular badge at its top-left, and the summary reads
"Full-page screenshot — Checkout — Step 5b - SaldoMax limit (3 callouts)".
Screenshots now render EXPANDED by default (`<details open>`) rather than hidden
behind a "Show visual evidence" toggle.

## One thing to watch
There is now one full-page JPEG per scan row, and interaction states are rows too —
a 13-page scan with interactions can hold 50+ images in the session JSON. Levers if
it gets heavy: lower `quality` in `captureFullPageAnnotated` (currently 55), cap
rows that get a shot, or downscale to ~900px wide. Say the word and I will add the
downscale step.
