// Merging two saved scans into one report — the edge cases that decide whether
// the merged totals are honest.
import { mergeSessions } from "../sidecar/merge-sessions.mjs";
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

const mk = (title, pages, extra = {}) => ({ title, timestamp: new Date().toISOString(), pages, ...extra });
const v = (id, impact, target, source = "") => ({ id, impact, source, description: id, nodes: [{ target, html: `<${target}>` }] });

// 1 · disjoint pages -> simple union
{
  const a = mk("ECare scan", [{ url: "https://h/ecare", title: "ECare", score: 80, violations: [v("image-alt", "serious", "img")] }]);
  const b = mk("Shop scan",  [{ url: "https://h/shop",  title: "Shop",  score: 90, violations: [v("link-name", "moderate", "a")] }]);
  const m = mergeSessions([a, b]);
  ck(m.pages.length === 2, `two different pages -> 2 rows (got ${m.pages.length})`);
  ck(m.counts.serious === 1 && m.counts.moderate === 1, "counts summed across both scans");
  ck(m.mergedFrom.length === 2, "merged report records both source scans");
}

// 2 · SAME page in both scans -> one row, findings merged, no double-count
{
  const p = (score, vs) => [{ url: "https://h/ecare", title: "ECare", score, violations: vs }];
  const a = mk("Run 1", p(80, [v("image-alt", "serious", "img.hero")]));
  const b = mk("Run 2", p(60, [v("link-name", "moderate", "a.nav")]));
  const m = mergeSessions([a, b]);
  ck(m.pages.length === 1, `same page twice -> ONE row (got ${m.pages.length})`);
  ck(m.pages[0].violations.length === 2, "both runs' findings kept on that page");
  ck(m.pages[0].mergedFrom.length === 2, "the page notes it came from both runs");
  ck(m.pages[0].score === 60, "keeps the WORSE score (a merge is only as good as its worst run)");
}

// 3 · identical finding in both -> deduplicated, not doubled
{
  const same = () => [{ url: "https://h/ecare", title: "ECare", score: 80, violations: [v("image-alt", "serious", "img.hero")] }];
  const m = mergeSessions([mk("Run 1", same()), mk("Run 2", same())]);
  ck(m.pages[0].violations.length === 1, `the same finding in both runs appears ONCE (got ${m.pages[0].violations.length})`);
  ck(m.counts.serious === 1, "totals are not inflated by the duplicate");
  ck(m.mergeStats.duplicateFindingsDropped === 1, "the drop is reported, not silent");
}

// 4 · AI + static -> sources preserved, warning raised
{
  const stat = mk("Static", [{ url: "https://h/x", title: "X", score: 80, violations: [v("image-alt", "serious", "img")] }]);
  const ai = mk("AI", [{ url: "https://h/x", title: "X", score: 80, violations: [v("vague-link", "moderate", "a", "ai-audit")] }], { aiAudit: true });
  const m = mergeSessions([stat, ai]);
  const sources = m.pages[0].violations.map((f) => f.source);
  ck(sources.includes("ai-audit") && sources.includes(""), "AI and automated findings keep their own source after merge");
  ck(m.warnings.some((w) => /AI review/i.test(w)), "warns that only one scan had AI (method difference, not page difference)");
  ck(m.aiAudit === true, "merged report is marked as containing AI findings");
}

// 5 · different origins -> allowed but flagged
{
  const dev = mk("Dev", [{ url: "https://dev.h/ecare", title: "E", score: 80, violations: [] }]);
  const prod = mk("Prod", [{ url: "https://prod.h/ecare", title: "E", score: 80, violations: [] }]);
  const m = mergeSessions([dev, prod]);
  ck(m.warnings.some((w) => /different origins/i.test(w)), "merging across origins is flagged loudly");
  ck(m.pages.length === 2, "different origins are NOT collapsed into one page");
}

// 6 · screenshots namespaced so two runs cannot collide
{
  const a = mk("A", [{ url: "https://h/x", title: "X", score: 80, violations: [{ id: "r", impact: "minor", nodes: [{ target: "i", shotKey: "/x||X" }] }] }]);
  a.pageShots = { "/x||X": { shot: "AAA", w: 10, h: 10 } };
  const b = mk("B", [{ url: "https://h/y", title: "Y", score: 80, violations: [{ id: "r2", impact: "minor", nodes: [{ target: "i", shotKey: "/x||X" }] }] }]);
  b.pageShots = { "/x||X": { shot: "BBB", w: 10, h: 10 } };
  const m = mergeSessions([a, b]);
  const keys = Object.keys(m.pageShots);
  ck(keys.length === 2, `two same-named shot keys survive as ${keys.length} distinct entries`);
  ck(keys.every((k) => /^s\d+::/.test(k)), "shot keys are namespaced per source scan");
  const pointed = m.pages.flatMap((p) => p.violations).flatMap((f) => f.nodes).map((n) => n.shotKey);
  ck(pointed.every((k) => keys.includes(k)), "findings point at their own scan's screenshot, not the other's");
}

// 7 · guardrail
{
  let threw = false;
  try { mergeSessions([mk("only one", [])]); } catch { threw = true; }
  ck(threw, "merging fewer than two scans is refused");
}


// --- regression: occurrence-level merging (the data-loss bug) ---------------
console.log("\n— occurrence-level dedup —");
{
  const p = (nodes) => [{ url: "https://h/ecare", title: "ECare", score: 80,
    violations: [{ id: "image-alt", impact: "serious", nodes }] }];
  // Scan A sees 2 bad images; scan B sees those 2 PLUS a third (login-only).
  const a = mk("Run A", p([{ target: "img.a" }, { target: "img.b" }]));
  const b = mk("Run B", p([{ target: "img.a" }, { target: "img.b" }, { target: "img.c" }]));
  const m = mergeSessions([a, b]);
  const f = m.pages[0].violations;
  ck(f.length === 1, `same rule on same page -> ONE finding, not two (got ${f.length})`);
  const targets = f[0].nodes.map((n) => n.target).sort();
  ck(JSON.stringify(targets) === '["img.a","img.b","img.c"]',
     `all THREE occurrences kept, duplicates removed (got ${JSON.stringify(targets)})`);
  ck(m.mergeStats.duplicateOccurrencesDropped === 2, "the 2 repeated occurrences are counted as dropped");
  ck(m.counts.serious === 1, "the merged rule counts once, not twice");
}

// AI and automated findings of the same rule must NOT be folded together
{
  const page = (source) => [{ url: "https://h/x", title: "X", score: 80,
    violations: [{ id: "contrast", impact: "serious", source, nodes: [{ target: "p" }] }] }];
  const m = mergeSessions([mk("Static", page("")), mk("AI", page("ai-audit"))]);
  ck(m.pages[0].violations.length === 2,
     "the same rule from AI and from axe stays as two findings (never launder AI into a measured fact)");
}

console.log(P ? "\nALL MERGE TESTS PASSED" : "\nSOME MERGE TESTS FAILED");
process.exit(P ? 0 : 1);
