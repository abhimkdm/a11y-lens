# A11y Lens — fix clipped pulse animation on the active agent

One file: src/components/AgentActivityPanel.tsx (drop-in replacement for the one
from the agent-panel delta). `tsc -b` + `vite build` clean.

## What was wrong
The active orb's pulse ring and glow expand outward, but the agent row used
`overflowX: "auto"` (for horizontal scroll on narrow windows). Per CSS, when one
overflow axis is auto/scroll the other is no longer treated as "visible" — so the
row was also clipping vertically, cutting the top off the growing ring.

## The fix
Kept the horizontal-scroll behaviour but added interior padding to the row
(pt: 3, pb: 1.5, px: 1.5). Padding sits *inside* the overflow clip box, so the
ring and glow now have room to expand into it instead of being cut off. No change
to the animation itself or any logic.
