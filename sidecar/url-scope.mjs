// Path scope filter.
//
// A discovery crawl started at /ecare should not wander into /login, marketing
// pages, or a sibling portal — that is wasted budget and noise in the report. This
// turns a few human-friendly patterns into a matcher:
//
//   /ecare          -> that path and everything under it (/ecare, /ecare/...)
//   /ecare/*        -> the same, explicitly
//   /ecare/**       -> the same (both globs mean "and below")
//   /shop/*/details -> a wildcard in the MIDDLE: /shop/123/details, /shop/x/details
//   !/ecare/logout  -> exclusion; anything matching is rejected even if included
//
// Rules:
//   * matches within one path segment (no "/")
//   ** matches across segments
//   a bare prefix with no wildcard means "this path or anything beneath it"
//   include patterns are OR'd; a URL must match at least one (if any include exists)
//   exclude patterns (leading !) always win
//   query and hash are ignored — scope is about the route, not its parameters

function toRegex(glob) {
  // Escape regex metachars, then re-expand our two wildcards.
  let g = glob.trim().replace(/\/+$/, "");            // trailing slash is noise
  if (!g.startsWith("/")) g = "/" + g;
  const hadTrailingGlob = /\/\*\*?$/.test(g);
  g = g.replace(/\/\*\*?$/, "");                      // strip a trailing /* or /**; handled below

  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")             // escape, but NOT * or /
    .replace(/\*\*/g, "\u0000")                       // ** -> placeholder
    .replace(/\*/g, "[^/]*")                          // * -> within-segment
    .replace(/\u0000/g, ".*");                        // ** -> across-segments

  // "This path or anything beneath it" applies to a PREFIX pattern with no
  // wildcards (/ecare matches /ecare/anything) or one that explicitly ends in
  // /* or /**. A pattern with a wildcard anywhere else names an exact depth:
  // /shop/*/details matches /shop/123/details, never /shop/123/details/print.
  const hasInnerWildcard = /\*/.test(g);              // g already had any trailing glob stripped
  const descend = hadTrailingGlob || !hasInnerWildcard;
  const tail = descend ? "(?:/.*)?" : "";
  return new RegExp(`^${escaped}${tail}$`);
}

// Build a matcher from an array of patterns (or a comma/newline string).
export function createScope(patterns) {
  const list = Array.isArray(patterns)
    ? patterns
    : String(patterns || "").split(/[\n,]/);
  const includes = [];
  const excludes = [];
  for (const raw of list) {
    const p = String(raw || "").trim();
    if (!p) continue;
    if (p.startsWith("!")) excludes.push(toRegex(p.slice(1)));
    else includes.push(toRegex(p));
  }

  const active = includes.length > 0 || excludes.length > 0;

  function pathOf(url) {
    try { return new URL(url).pathname; } catch {
      // Bare path like "/ecare/x" — use as-is.
      return String(url || "").split(/[?#]/)[0];
    }
  }

  function allows(url) {
    if (!active) return true;                          // no scope set -> allow all
    const path = pathOf(url);
    if (excludes.some((re) => re.test(path))) return false;
    if (!includes.length) return true;                 // only excludes given
    return includes.some((re) => re.test(path));
  }

  return { active, allows, includeCount: includes.length, excludeCount: excludes.length };
}
