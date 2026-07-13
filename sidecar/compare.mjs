// A11y Lens comparison engine (Phase 13).
// Diffs two scans at the element level: rule + selector identifies an issue.

// Expert findings have no stable rule ID or selector — they're prose. So we
// identify them by (zone + normalized title), which is stable enough across
// runs to track "did this get fixed" without being fooled by the model
// rewording a description. Severity changes on a surviving finding are surfaced
// separately, because a critical downgraded to moderate is real progress.
function expertKey(f) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return `${norm(f.zone)}::${norm(f.title)}`;
}

export function compareExpertAudits(prev, curr) {
  const a = new Map((prev?.findings ?? []).map((f) => [expertKey(f), f]));
  const b = new Map((curr?.findings ?? []).map((f) => [expertKey(f), f]));

  const fixed = [], added = [], persisting = [], severityChanged = [];
  for (const [k, f] of a) if (!b.has(k)) fixed.push(f);
  for (const [k, f] of b) {
    if (!a.has(k)) { added.push(f); continue; }
    persisting.push(f);
    const before = a.get(k);
    if (before.severity !== f.severity)
      severityChanged.push({ ...f, from: before.severity, to: f.severity });
  }

  const bySeverity = (list) => {
    const c = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const f of list) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  };

  return {
    prev: { generatedAt: prev?.generatedAt ?? null, total: prev?.findings?.length ?? 0 },
    curr: { generatedAt: curr?.generatedAt ?? null, total: curr?.findings?.length ?? 0 },
    fixed, added, persisting, severityChanged,
    summary: {
      fixed: fixed.length,
      added: added.length,
      persisting: persisting.length,
      severityChanged: severityChanged.length,
      fixedBySeverity: bySeverity(fixed),
      addedBySeverity: bySeverity(added),
      // Only count verified findings in the headline — unverified ones may be noise.
      addedVerified: added.filter((f) => f.evidenceStatus === "verified").length,
    },
  };
}

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

  // Expert findings diff runs alongside the axe diff when both scans have one.
  const expert = (prev.expertAudit || curr.expertAudit)
    ? compareExpertAudits(prev.expertAudit, curr.expertAudit)
    : null;

  return {
    prev: { url: prev.url, timestamp: prev.timestamp, score: prev.score },
    curr: { url: curr.url, timestamp: curr.timestamp, score: curr.score },
    scoreDelta: curr.score - prev.score,
    expert,
    fixed, added, regressions,
    summary: {
      fixed: fixed.length, added: added.length, regressions: regressions.length,
      fixedBySeverity: bySeverity(fixed), addedBySeverity: bySeverity(added),
    },
  };
}
