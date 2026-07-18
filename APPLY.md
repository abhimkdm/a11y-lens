# A11y Lens — interaction states now keep their own screenshot

`node --check` clean; ordering bug reproduced and verified fixed.

## Files
    sidecar/crawler.mjs    (carries the shot on the returned violations; restores per scenario)
    sidecar/interact.mjs   (each scenario carries the screenshot of its own state)

## What your uploaded report actually shows
I measured it rather than guessing. Across the 6 finding cards:
    Evidence rows ......... 6 / 6   (100% — every card HAS evidence, with real DOM snippets)
    Fix rows .............. 6 / 6
    Screenshots ........... 3 / 6   <-- the actual gap
    AI findings ........... 0 / 6   <-- see below
So text evidence is being captured. What is missing on half the cards is the
VISUAL evidence, and it is missing specifically on the interaction-state pages.

## The bug
`exploreInteractions` scans EVERY revealed state first, then the crawler records
them all afterwards. The screenshot was held in one shared slot, so each state's
scan overwrote the previous one — the first recorded state consumed the LAST
state's image, and the rest got nothing. Verified: 3 states in, exactly 1 image
out, and attached to the wrong state.
Now each scenario carries the screenshot captured while THAT state was open
(non-enumerable, so it never bloats the session JSON), and the crawler restores it
just before recording that row.

## The other half: ZERO AI findings in this report
All 6 findings are `Automated` (axe). Not one `AI` badge. That matches the logs you
sent earlier: `AI audit failed ... Can't reach nvidia (operation aborted due to
timeout)`. The AI reviewer is timing out, so its findings — the ones with the rich
"keyboard walk step 7 ..." evidence you are expecting — are never produced.
That is a provider/timeout problem, not a report problem, and no report change will
surface findings that were never generated. Fix options (say which):
  1. retry with backoff around the AI call, so one timeout doesn't cost a page;
  2. raise the request timeout / lower `maxTokens` for the audit;
  3. switch the audit to a faster model and keep nvidia for the report pass.
