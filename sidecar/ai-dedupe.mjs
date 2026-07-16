// A11y Lens — semantic dedupe for AI Full Scan findings.
//
// A multi-page AI audit reports the SAME root issue many times: the header's
// unlabelled menu button on all 20 pages, the same "Se produkt" repeated-link
// critique on every listing. Each was a separate LLM call so the wording drifts
// slightly, which defeats naive string dedupe. This clusters them so the report
// shows one group per root issue instead of 20 near-identical rows.
//
// Strategy: a cheap deterministic pass first (group by normalized wcag +
// description signature), then — only if a provider is available and there are
// enough survivors to be worth it — one LLM grouping call to catch the
// worded-differently duplicates the deterministic pass missed. Degrades to the
// deterministic result if the model call fails.

import { aiJson } from "./ai.mjs";

const GROUP_SYSTEM = `You are grouping accessibility findings that describe the SAME underlying issue worded differently.

Findings come from auditing many pages of one website. The same root issue often recurs 2-20 times with slightly different wording because each page was a separate audit call. Cluster the duplicates so the report renders one group per root issue.

GROUP findings when:
- Site chrome repeated across pages — the same header/footer/cookie/nav/skip-link issue on many pages.
- The same component issue across pages — same root problem, slightly different wording.

Do NOT group when:
- Clearly different components (a product-card issue vs a footer issue).
- The recommended fix would be substantively different.
- Severities differ by more than one level AND the fixes differ.

Group AGGRESSIVELY — singletons should be the minority for chrome issues. Return JSON only:
{ "groups": [ { "memberIds": ["f1","f7","f12"], "title": "short canonical title (<=80 chars)" } ] }
Every input id must appear in exactly one group. Singletons are groups of one (title optional).`;

// Deterministic signature: normalized wcag + the first ~8 significant words of
// the description. Catches exact and near-exact repeats for free.
function signature(f) {
  const wcag = String(f.wcagString || (Array.isArray(f.wcag) ? f.wcag[0] : f.wcag) || "").trim();
  const desc = String(f.description || f.explanation || f.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .join(" ");
  return `${wcag}|${desc}`;
}

/**
 * @param findings array of AI-audit findings (each needs a stable `id`)
 * @param ai optional provider for the semantic pass
 * @returns { groups: [{ id, title, severity, wcag, count, members:[finding], pages:[url] }], usage }
 */
export async function dedupeFindings(findings, ai) {
  const list = (findings ?? []).filter((f) => f && (f.description || f.explanation));
  if (list.length <= 1) {
    return { groups: list.map((f) => oneGroup(f, [f])), usage: { inputTokens: 0, outputTokens: 0 } };
  }

  // Ensure every finding has a unique id for grouping.
  list.forEach((f, i) => { if (!f._gid) f._gid = `f${i}`; });

  // 1) deterministic pass
  const bySig = new Map();
  for (const f of list) {
    const s = signature(f);
    if (!bySig.has(s)) bySig.set(s, []);
    bySig.get(s).push(f);
  }
  let clusters = [...bySig.values()];

  // 2) optional semantic pass over the deterministic representatives, to merge
  //    duplicates that are worded too differently to share a signature.
  let usage = { inputTokens: 0, outputTokens: 0 };
  if (ai?.provider && clusters.length > 1) {
    const reps = clusters.map((c) => c[0]);
    try {
      const prompt = `${GROUP_SYSTEM}\n\nFINDINGS:\n${reps
        .map((f) => `- id ${f._gid} [${f.severity} · ${f.wcagString || ""}] ${String(f.description || f.explanation).slice(0, 200)}`)
        .join("\n")}`;
      const out = await aiJson(ai, prompt, 3000);
      usage = out.__usage ?? usage;
      const groups = Array.isArray(out.groups) ? out.groups : [];
      if (groups.length) {
        // Merge deterministic clusters whose representatives were grouped together.
        const repById = new Map(reps.map((r, i) => [r._gid, clusters[i]]));
        const used = new Set();
        const merged = [];
        for (const g of groups) {
          const ids = (g.memberIds ?? []).filter((id) => repById.has(id) && !used.has(id));
          if (!ids.length) continue;
          let members = [];
          for (const id of ids) { used.add(id); members = members.concat(repById.get(id)); }
          merged.push({ members, title: g.title });
        }
        // Any representative the model omitted stays as its own cluster.
        for (const r of reps) if (!used.has(r._gid)) merged.push({ members: repById.get(r._gid), title: null });
        clusters = merged.map((m) => m.members);
        return {
          groups: merged.map((m) => oneGroup(m.members[0], m.members, m.title)),
          usage,
        };
      }
    } catch { /* fall back to deterministic clusters */ }
  }

  return { groups: clusters.map((c) => oneGroup(c[0], c)), usage };
}

function oneGroup(rep, members, title) {
  const pages = [...new Set(members.flatMap((m) => (m.nodes ?? []).map((n) => n.target)).filter(Boolean))];
  // Worst severity in the group wins.
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const worst = members.reduce((a, b) => (order[b.severity] < order[a.severity] ? b : a), members[0]);
  return {
    id: rep.id || rep._gid,
    title: title || rep.description?.slice(0, 80) || rep.title || "Finding",
    severity: worst.severity,
    wcag: rep.wcagString || (Array.isArray(rep.wcag) ? rep.wcag[0] : rep.wcag) || "",
    count: members.length,
    pages,
    members,
  };
}
