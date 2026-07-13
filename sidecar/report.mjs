// A11y Lens AI Report Generator (Phase 8).
// Turns raw axe findings into three audiences' views:
//   executive summary · developer fixes (HTML/React/Angular) · business impact.
import { aiChat } from "./ai.mjs";
import { parseAiJson } from "./json-repair.mjs";

export async function generateAiReport(scan, ai) {
  // Keep the prompt lean: top rules by severity, one sample element each.
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const top = [...(scan.violations ?? [])]
    .sort((a, b) => order[a.impact] - order[b.impact] || b.nodes.length - a.nodes.length)
    .slice(0, 8)
    .map(v => ({
      rule: v.id, impact: v.impact, wcag: v.wcag, help: v.help,
      elements: v.nodes.length,
      sampleHtml: v.nodes[0]?.html?.slice(0, 220) ?? "",
      sampleSelector: v.nodes[0]?.target ?? "",
    }));

  const prompt = `You are an accessibility consultant writing a report for a WCAG 2.1 AA audit.

Scan facts:
- Application: ${scan.title || scan.url}
- Score: ${scan.score}/100
- Issue counts: ${JSON.stringify(scan.counts)}
- Pages scanned: ${scan.pages?.length ?? 1}
- Top failing rules (with one sample element each): ${JSON.stringify(top)}

Produce a JSON object with exactly this shape:
{
  "executiveSummary": "3-5 sentences: overall state, the biggest risks, what to prioritize first.",
  "businessImpact": "3-4 sentences for non-technical stakeholders: which users are affected and how, plus compliance exposure (ADA / EN 301 549 / Section 508) stated as risk, not legal advice.",
  "fixes": [
    {
      "rule": "rule-id",
      "impact": "critical|serious|moderate|minor",
      "title": "short title",
      "explanation": "1-2 sentences why this fails and who it affects",
      "html": "corrected plain HTML snippet based on the sample element",
      "react": "corrected JSX snippet",
      "angular": "corrected Angular template snippet"
    }
  ],
  "quickWins": ["3-5 one-line actions ordered by effort-to-impact"]
}
Cover every rule listed above in "fixes". Base each corrected snippet on the provided sampleHtml.`;

  const raw = await aiChat(
    ai,
    prompt + "\n\nReply with ONLY valid JSON. No markdown fences, no preamble. " +
      "Inside JSON string values, escape all double quotes and newlines. " +
      "Never use backticks to quote a value — JSON has no backtick strings.",
    4000
  );

  // Parse tolerantly. A model that emits one malformed code snippet must not cost
  // the user their whole report — we recover what we can and surface the rest as
  // warnings rather than throwing everything away.
  const { data, warnings, recovered } = parseAiJson(raw, {
    salvageKeys: ["fixes", "quickWins"],
  });

  const report = {
    executiveSummary:
      typeof data.executiveSummary === "string" && data.executiveSummary.trim()
        ? data.executiveSummary
        : "(The model did not return an executive summary — see Logs for details.)",
    businessImpact:
      typeof data.businessImpact === "string" && data.businessImpact.trim()
        ? data.businessImpact
        : "(The model did not return a business impact section — see Logs for details.)",
    fixes: Array.isArray(data.fixes)
      ? data.fixes
          .filter((f) => f && (f.title || f.rule))
          .map((f) => ({
            rule: String(f.rule ?? "unknown"),
            impact: ["critical", "serious", "moderate", "minor"].includes(f.impact) ? f.impact : "moderate",
            title: String(f.title ?? f.rule ?? "Fix"),
            explanation: String(f.explanation ?? ""),
            html: String(f.html ?? ""),
            react: String(f.react ?? ""),
            angular: String(f.angular ?? ""),
          }))
      : [],
    quickWins: Array.isArray(data.quickWins) ? data.quickWins.map(String) : [],
    generatedAt: new Date().toISOString(),
    provider: `${ai.provider}/${ai.model}`,
  };

  // If we lost content, say so ON the report rather than silently shipping a
  // thinner one — but still ship it.
  const expected = top.length;
  if (report.fixes.length < expected) {
    warnings.push({
      stage: "coverage",
      message: `Asked for ${expected} fix${expected === 1 ? "" : "es"} but only ${report.fixes.length} came back intact. The rest were malformed and dropped.`,
      detail: null,
    });
  }

  return { report, warnings, recovered, degraded: recovered || report.fixes.length < expected };
}
