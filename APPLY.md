# A11y Lens — Logs tidy-up

One file: src/pages/Logs.tsx. Verified with `tsc -b` + `vite build`.

## Changes
1. **Tile title capped at 50 chars + "…"** — long API-error blobs no longer fill the
   collapsed row. The full message still shows when expanded, and on hover (added a
   Tooltip with the complete text).
2. **Detail shows only Code + Message** — the stored detail's stack trace and local
   file paths (…/sidecar/ai.mjs:135:26) are stripped. For an API error it renders:
       Code: 400
       Message: Multimodal data provided, but model does not support multimodal requests.
   If a detail has no parseable API error, it falls back to removing stack frames and
   path lines so non-API errors still read cleanly.

## Note
The Copy button still copies the full raw detail (stack included) — that's the one place
a developer usually wants the paths for debugging. Say the word and I'll clean that too.
