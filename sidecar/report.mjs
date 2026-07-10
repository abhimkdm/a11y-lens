// A11y Lens AI Report Generator (Phase 8).
// Turns raw axe findings into three audiences' views:
//   executive summary · developer fixes (HTML/React/Angular) · business impact.
import { aiJson } from "./ai.mjs";

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

  const report = await aiJson(ai, prompt, 3500);

  // Minimal shape validation so the UI never renders garbage.
  if (typeof report.executiveSummary !== "string" || !Array.isArray(report.fixes))
    throw new Error("AI returned an unexpected report shape. Try again or switch models.");
  report.generatedAt = new Date().toISOString();
  report.provider = `${ai.provider}/${ai.model}`;
  return report;
}
