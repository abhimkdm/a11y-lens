// A11y Lens comparison engine (Phase 13).
// Diffs two scans at the element level: rule + selector identifies an issue.
export function compareScans(prev, curr) {
  const key = (v, n) => `${v.id}::${n.target}`;
  const index = (scan) => {
    const m = new Map();
    for (const v of scan.violations ?? [])
      for (const n of v.nodes ?? [])
        m.set(key(v, n), { rule: v.id, impact: v.impact, help: v.help, target: n.target });
    return m;
  };
  const a = index(prev), b = index(curr);

  const fixed = [], added = [];
  for (const [k, v] of a) if (!b.has(k)) fixed.push(v);
  for (const [k, v] of b) if (!a.has(k)) added.push(v);

  // A "regression" is a new failure of a rule that had zero failures before —
  // something that was clean and broke, rather than more of a known problem.
  const prevRules = new Set([...a.values()].map(v => v.rule));
  const regressions = added.filter(v => !prevRules.has(v.rule));
  const bySeverity = (list) => {
    const c = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of list) c[v.impact] = (c[v.impact] ?? 0) + 1;
    return c;
  };

  return {
    prev: { url: prev.url, timestamp: prev.timestamp, score: prev.score },
    curr: { url: curr.url, timestamp: curr.timestamp, score: curr.score },
    scoreDelta: curr.score - prev.score,
    fixed, added, regressions,
    summary: {
      fixed: fixed.length, added: added.length, regressions: regressions.length,
      fixedBySeverity: bySeverity(fixed), addedBySeverity: bySeverity(added),
    },
  };
}
