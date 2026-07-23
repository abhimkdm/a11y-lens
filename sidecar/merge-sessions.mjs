// Merge two (or more) saved scans into one combined report.
//
// This is NOT the same operation as Compare. Compare answers "what changed between
// run A and run B" (fixed / new / regressed). Merge answers "show me A and B as a
// single body of evidence" — the case where one run covered /ecare and another
// covered /shop, or where a deterministic Full Scan and an AI Full Scan each found
// things the other did not, and management wants ONE document.
//
// The edge cases that decide whether a merge is honest:
//
//  1. Same page scanned twice. A union that keeps both rows would double every
//     finding and inflate the totals. We keep ONE row per page and merge its
//     findings, recording that the page appeared in both runs.
//  2. Same finding in both runs. Deduplicated by (rule + page + target). The
//     surviving copy notes both sources, so nothing is silently dropped.
//  3. One AI run + one static run. Findings carry their own `source`, so the
//     merged report still distinguishes AI from Automated — merging must not
//     launder an AI suggestion into a measured fact.
//  4. Different origins. Merging a dev scan with a prod scan produces a document
//     that looks like one site and is not. We allow it but flag it loudly.
//  5. Screenshots. Each page keeps its own shot; shot keys are namespaced per
//     source scan so two runs cannot collide on the same key.

function pageKey(p) {
  try {
    const u = new URL(p.url);
    // Interaction states share a URL with their base page, so the label is part
    // of identity — otherwise "Cart" and "Cart — Interaction: Filter" would merge.
    return `${u.origin}${u.pathname}${u.search}||${p.title || ""}`;
  } catch {
    return `${p.url}||${p.title || ""}`;
  }
}

// Identity of a single occurrence (one failing element), not of a whole finding.
// Merging has to work at THIS level: two scans of the same page report the same
// rule, but their node lists can differ — scan A finds 2 bad images, scan B finds
// those 2 plus a third that only appears when logged in. Keying on the finding as
// a whole (or on its first node) would drop B entirely and lose that third image.
function nodeKey(n) {
  const t = (n && (n.target || n.html || n.selector)) || "";
  return String(t).replace(/\s+/g, " ").trim().slice(0, 160);
}

// Identity of a finding WITHIN a page: the rule, plus its source so an AI
// observation is never silently folded into a measured axe result.
function findingKey(f, pKey) {
  const src = String(f.source || "").toLowerCase().startsWith("ai") ? "ai" : "auto";
  return `${f.id || f.rule}||${src}||${pKey}`;
}

export function mergeSessions(sessions, opts = {}) {
  const list = (sessions || []).filter(Boolean);
  if (list.length < 2) throw new Error("Merging needs at least two saved scans.");

  const warnings = [];
  const origins = new Set();
  for (const s of list) {
    for (const p of s.pages ?? []) {
      try { origins.add(new URL(p.url).origin); } catch { /* ignore */ }
    }
  }
  if (origins.size > 1) {
    warnings.push(
      `These scans cover ${origins.size} different origins (${[...origins].join(", ")}). ` +
      `The merged report presents them as one body of evidence — make sure that is what you intend.`
    );
  }

  const anyAi = list.some((s) => !!(s.aiAudit || s.aiReport || (s.pages ?? []).some((p) =>
    (p.violations ?? []).some((v) => String(v.source || "").startsWith("ai")))));
  const allAi = list.every((s) => !!(s.aiAudit || s.aiReport));
  if (anyAi && !allAi) {
    warnings.push(
      "One scan included an AI review and the other did not. Findings keep their own source, " +
      "so a page from the non-AI scan will legitimately show fewer AI findings — that is a " +
      "difference in method, not in the page."
    );
  }

  const pages = new Map();       // pageKey -> merged page
  const findingIndex = new Map(); // `${pageKey}::${findingKey}` -> finding object
  const pageShots = {};
  const stats = { sources: [], pagesFromBoth: 0, duplicateFindingsDropped: 0, duplicateOccurrencesDropped: 0 };

  // Add one incoming finding to a page, merging it into an existing finding of the
  // same rule+source rather than appending a second copy.
  function absorb(targetPage, pKey, v) {
    const fk = `${pKey}::${findingKey(v, pKey)}`;
    const existing = findingIndex.get(fk);
    if (!existing) {
      const copy = { ...v, nodes: [...(v.nodes ?? [])] };
      findingIndex.set(fk, copy);
      targetPage.violations.push(copy);
      return;
    }
    // Same rule already recorded for this page: union the OCCURRENCES. This is
    // where duplicates actually get removed — and where a node the other scan
    // uniquely saw is preserved instead of thrown away.
    stats.duplicateFindingsDropped++;
    const seenNodes = new Set((existing.nodes ?? []).map(nodeKey));
    for (const n of v.nodes ?? []) {
      const k = nodeKey(n);
      if (seenNodes.has(k)) { stats.duplicateOccurrencesDropped++; continue; }
      seenNodes.add(k);
      existing.nodes.push(n);
    }
    if (!existing.__fromScan?.includes(v.__fromScan)) {
      existing.__fromScan = [existing.__fromScan, v.__fromScan].filter(Boolean).join(" + ");
    }
  }

  list.forEach((s, si) => {
    const label = s.title || s.url || `Scan ${si + 1}`;
    stats.sources.push({ index: si, label, timestamp: s.timestamp ?? null, pages: (s.pages ?? []).length });

    // Namespace shot keys per source scan so two runs cannot collide.
    for (const [k, v] of Object.entries(s.pageShots ?? {})) {
      pageShots[`s${si}::${k}`] = v;
    }

    for (const p of s.pages ?? []) {
      const k = pageKey(p);
      const incoming = (p.violations ?? []).map((v) => ({
        ...v,
        // Re-point this finding's shot key at the namespaced copy.
        nodes: (v.nodes ?? []).map((n) => (n.shotKey ? { ...n, shotKey: `s${si}::${n.shotKey}` } : n)),
        __fromScan: label,
      }));

      if (!pages.has(k)) {
        pages.set(k, { ...p, violations: [], mergedFrom: [label] });
      } else {
        const t = pages.get(k);
        if (!t.mergedFrom.includes(label)) { t.mergedFrom.push(label); stats.pagesFromBoth++; }
        // Keep the WORSE score — a merged page is only as good as its worst run.
        if (typeof p.score === "number" && typeof t.score === "number") t.score = Math.min(t.score, p.score);
        if (!t.shotKey && p.shotKey) t.shotKey = p.shotKey;
      }
      const targetPage = pages.get(k);
      for (const v of incoming) absorb(targetPage, k, v);
    }
  });

  const mergedPages = [...pages.values()];
  // Recompute counts from the merged findings rather than summing the sources —
  // summing would re-introduce exactly the duplicates we just removed.
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const p of mergedPages) {
    const pc = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of p.violations) {
      const sev = String(v.impact || v.severity || "minor").toLowerCase();
      if (counts[sev] !== undefined) { counts[sev]++; pc[sev]++; }
    }
    p.counts = pc;
  }

  return {
    kind: "merged",
    title: opts.title || `Merged report (${list.length} scans)`,
    url: mergedPages[0]?.url ?? "",
    timestamp: new Date().toISOString(),
    pages: mergedPages,
    pageShots,
    counts,
    aiAudit: anyAi,
    mergedFrom: stats.sources,
    mergeStats: stats,
    warnings,
    score: mergedPages.length
      ? Math.round(mergedPages.reduce((a, p) => a + (typeof p.score === "number" ? p.score : 100), 0) / mergedPages.length)
      : 100,
  };
}
