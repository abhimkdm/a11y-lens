// A11y Lens — site report engine.
//
// A flat list of findings does not survive contact with a real site. Scan 19
// pages and the same footer contrast failure appears 19 times; the reader drowns
// in duplicates and the genuinely page-specific problems get buried.
//
// So this does three things a single-page report cannot:
//
//   1. DEDUPLICATE across pages. A rule that fails on most pages is site-wide
//      chrome — report it ONCE, tagged with how many pages it affects. A rule
//      that fails on one page is page-specific. This is the difference between
//      648 readable findings and 1,000+ unreadable rows.
//   2. STABLE IDS. A finding gets the same id on every run (hash of rule +
//      scope + element signature), so it can be pasted into a ticket and still
//      mean something next month.
//   3. An AI EXECUTIVE SUMMARY over the whole site rather than one page:
//      overall risk, systemic themes, and which pages to fix first.
//
// It also embeds our per-element screenshots, which a text-only report can't.
import { createHash } from "node:crypto";
import { aiChat } from "./ai.mjs";
import { parseAiJson } from "./json-repair.mjs";

const SEV_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// A rule failing on this share of pages is chrome (header/footer/nav), not a
// page-specific defect. Three pages minimum so a 2-page scan can't call
// everything "site-wide".
const SITEWIDE_RATIO = 0.6;
const SITEWIDE_MIN_PAGES = 3;

const shortId = (s) =>
  "AL-" + createHash("sha1").update(s).digest("hex").slice(0, 8).toUpperCase();

const slug = (s) =>
  String(s || "page")
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "page";

/**
 * Collapse per-page violations into deduplicated findings.
 * Returns { siteWide, byPage, totals }.
 */
export function deduplicate(pages) {
  const pageCount = pages.length || 1;

  // rule -> { rule meta, pages: Map<url, nodes[]> }
  const byRule = new Map();

  for (const p of pages) {
    for (const v of p.violations ?? []) {
      if (!byRule.has(v.id)) {
        byRule.set(v.id, {
          rule: v.id,
          impact: v.impact,
          help: v.help,
          description: v.description,
          helpUrl: v.helpUrl,
          wcag: v.wcag ?? [],
          pages: new Map(),
        });
      }
      const entry = byRule.get(v.id);
      const existing = entry.pages.get(p.url) ?? [];
      entry.pages.set(p.url, existing.concat(v.nodes ?? []));
    }
  }

  const siteWide = [];
  const pageSpecific = new Map(); // url -> findings[]

  for (const entry of byRule.values()) {
    const affected = [...entry.pages.keys()];
    const occurrences = [...entry.pages.values()].reduce((n, nodes) => n + nodes.length, 0);
    const isSiteWide =
      affected.length >= SITEWIDE_MIN_PAGES &&
      affected.length / pageCount >= SITEWIDE_RATIO;

    // Take the richest sample nodes (ones that actually have a screenshot first),
    // so the reader sees evidence rather than the first arbitrary match.
    const allNodes = [...entry.pages.values()].flat();
    const samples = [...allNodes]
      .sort((a, b) => (b.screenshot ? 1 : 0) - (a.screenshot ? 1 : 0))
      .slice(0, 6);

    const base = {
      rule: entry.rule,
      impact: entry.impact,
      title: entry.help,
      description: entry.description,
      helpUrl: entry.helpUrl,
      wcag: entry.wcag,
      occurrences,
      affectedPages: affected,
      nodes: samples,
    };

    if (isSiteWide) {
      siteWide.push({
        ...base,
        id: shortId(`sitewide::${entry.rule}`),
        scope: "site-wide",
      });
    } else {
      for (const [url, nodes] of entry.pages) {
        const list = pageSpecific.get(url) ?? [];
        list.push({
          ...base,
          id: shortId(`page::${url}::${entry.rule}`),
          scope: "page-specific",
          occurrences: nodes.length,
          affectedPages: [url],
          nodes: [...nodes]
            .sort((a, b) => (b.screenshot ? 1 : 0) - (a.screenshot ? 1 : 0))
            .slice(0, 6),
        });
        pageSpecific.set(url, list);
      }
    }
  }

  const sortBySeverity = (a, b) =>
    SEV_ORDER[a.impact] - SEV_ORDER[b.impact] || b.occurrences - a.occurrences;

  siteWide.sort(sortBySeverity);

  const byPage = pages.map((p) => {
    const findings = (pageSpecific.get(p.url) ?? []).sort(sortBySeverity);
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const f of findings) counts[f.impact] += f.occurrences;
    return {
      url: p.url,
      title: p.title || p.url,
      slug: slug(p.title || p.url),
      score: p.score,
      findings,
      counts,
    };
  });

  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of siteWide) totals[f.impact] += f.occurrences;
  for (const p of byPage) for (const k of Object.keys(totals)) totals[k] += p.counts[k];

  return {
    siteWide,
    byPage,
    totals,
    stats: {
      pages: pages.length,
      siteWideFindings: siteWide.length,
      pageFindings: byPage.reduce((n, p) => n + p.findings.length, 0),
      totalOccurrences: Object.values(totals).reduce((a, b) => a + b, 0),
      // The number that justifies the whole exercise.
      duplicatesCollapsed: siteWide.reduce(
        (n, f) => n + Math.max(0, f.affectedPages.length - 1),
        0
      ),
    },
  };
}

/** AI executive summary over the WHOLE site, not one page. */
export async function generateExecutiveSummary(dedup, ai, meta) {
  const worstPages = [...dedup.byPage]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((p) => ({ title: p.title, score: p.score, findings: p.findings.length, counts: p.counts }));

  const prompt = `You are a senior accessibility consultant writing the executive summary of a WCAG 2.1 AA audit of a website.

FACTS (do not invent others):
- Pages audited: ${dedup.stats.pages}
- Site-wide issues (present on most pages — header, footer, navigation): ${dedup.stats.siteWideFindings}
- Page-specific issues: ${dedup.stats.pageFindings}
- Total occurrences: ${dedup.stats.totalOccurrences}
- Severity totals: ${JSON.stringify(dedup.totals)}
- Top site-wide rules: ${JSON.stringify(dedup.siteWide.slice(0, 8).map((f) => ({ rule: f.rule, impact: f.impact, title: f.title, pages: f.affectedPages.length })))}
- Lowest-scoring pages: ${JSON.stringify(worstPages)}

Return JSON:
{
  "overallAssessment": "2-4 sentences. Where does this site stand against WCAG 2.1 AA, and what is the shape of the risk?",
  "themes": [
    { "title": "Short theme name", "detail": "2-3 sentences on the systemic pattern and who it blocks." }
  ],
  "highestImpactPages": [
    { "page": "page title", "why": "one sentence" }
  ],
  "nextSteps": ["3-5 concrete, ordered actions. Fix site-wide chrome first — one fix there resolves the issue on every page."]
}
Give 3-5 themes. Be specific about WHICH users are blocked and HOW. Do not restate the numbers; interpret them.`;

  const raw = await aiChat(
    ai,
    prompt + "\n\nReply with ONLY valid JSON. No markdown fences. Never use backticks to quote a value.",
    2500
  );
  const { data, warnings } = parseAiJson(raw, { salvageKeys: ["themes", "highestImpactPages", "nextSteps"] });

  return {
    summary: {
      overallAssessment:
        typeof data.overallAssessment === "string" && data.overallAssessment.trim()
          ? data.overallAssessment
          : "(No overall assessment was returned — see Logs.)",
      themes: Array.isArray(data.themes)
        ? data.themes.filter((t) => t && t.title).map((t) => ({
            title: String(t.title),
            detail: String(t.detail ?? ""),
          }))
        : [],
      highestImpactPages: Array.isArray(data.highestImpactPages)
        ? data.highestImpactPages.filter((p) => p && p.page).map((p) => ({
            page: String(p.page),
            why: String(p.why ?? ""),
          }))
        : [],
      nextSteps: Array.isArray(data.nextSteps) ? data.nextSteps.map(String) : [],
      generatedAt: new Date().toISOString(),
      provider: `${ai.provider}/${ai.model}`,
      meta,
    },
    warnings,
  };
}
