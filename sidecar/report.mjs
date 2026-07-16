// A11y Lens — AI Report Generator (evidence-grounded).
//
// The old version was blind. It sent the model rule names and one truncated HTML
// snippet, so it produced generic advice — "add an aria-label" — that a developer
// could have written from the rule name alone.
//
// Meanwhile we were already capturing, for every scan: a page screenshot, a
// highlighted screenshot of each failing element, the real DOM, and each
// element's selector. None of it reached the model.
//
// Now it does:
//   - the PAGE SCREENSHOT goes in as vision, so the model can see the layout it
//     is writing about
//   - ELEMENT SCREENSHOTS go in for the worst offenders, so a fix refers to the
//     actual broken control rather than an imagined one
//   - the REAL DOM of each failing element goes in
//   - every fix must cite VERBATIM EVIDENCE from that DOM, and we VERIFY the
//     citation afterwards — a fix whose evidence isn't in the page gets flagged,
//     not silently trusted
//   - every SCENARIO (each page of a full scan, each recorded step) contributes
//     its own evidence, so a multi-page report isn't written from page one alone
//
// Output is schema-constrained where the provider supports it, which also
// prevents the malformed-JSON failures at the source instead of repairing them.
import { aiChat, aiChatWithUsage, aiStructured } from "./ai.mjs";
import { parseAiJson } from "./json-repair.mjs";
import { buildKeyboardEvidenceText } from "./keyboard-evidence.mjs";
import { estimateCost } from "./cost.mjs";

const SEV_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// Each image costs tokens, and past a handful the model stops using them well.
const MAX_ELEMENT_IMAGES = 4;
const MAX_RULES = 8;

export const REPORT_SCHEMA = {
  type: "object",
  properties: {
    executiveSummary: { type: "string" },
    businessImpact: { type: "string" },
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule: { type: "string" },
          impact: { type: "string", enum: ["critical", "serious", "moderate", "minor"] },
          title: { type: "string" },
          explanation: { type: "string" },
          selector: { type: "string", description: "CSS selector of the element this fix targets." },
          evidence: {
            type: "string",
            description: "A VERBATIM string copied from the supplied element HTML that proves the problem.",
          },
          html: { type: "string" },
          react: { type: "string" },
          angular: { type: "string" },
        },
        required: ["rule", "impact", "title", "explanation", "selector", "evidence", "html", "react", "angular"],
      },
    },
    quickWins: { type: "array", items: { type: "string" } },
  },
  required: ["executiveSummary", "businessImpact", "fixes", "quickWins"],
};

const normalize = (s) =>
  String(s ?? "")
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

// Words that appear in almost any markup or sentence. Matching on these proves
// nothing — `input id=` occurs in every form on earth — so a citation that only
// overlaps here is not evidence.
const GENERIC = new Set([
  "input", "button", "image", "images", "class", "type", "value", "label", "name", "role",
  "aria", "href", "link", "links", "text", "element", "elements", "attribute", "attributes",
  "span", "div", "title", "alt", "placeholder", "lazy", "loading", "false", "true", "none",
  "page", "pages", "with", "that", "this", "from", "have", "has", "does", "not", "the",
  "content", "container", "wrapper", "section", "header", "footer", "screen", "reader",
  "should", "would", "could", "there", "their", "which", "where", "when", "must",
]);

// Pull out the parts of a citation that could only have come from THIS page:
// attribute values, visible text, and distinctive words.
function distinctiveTokens(s) {
  const out = new Set();
  const str = String(s ?? "");

  for (const m of str.matchAll(/=\s*["']([^"']{3,})["']/g)) out.add(normalize(m[1]));   // attr values
  for (const m of str.matchAll(/>([^<>]{3,})</g)) out.add(normalize(m[1]));              // text content

  // A model often wraps the real quote in a sentence:
  //   The link text is "Læs mere", which is not descriptive
  // The sentence is the model's words; the quoted span is what must be real.
  for (const m of normalize(str).matchAll(/"([^"]{3,})"/g)) out.add(normalize(m[1]));

  for (const w of normalize(str).split(/[^a-z0-9_.\-æøå]+/)) {
    if (w.length >= 5 && !GENERIC.has(w)) out.add(w);
  }

  return [...out].filter((t) => t && t.length >= 4 && !GENERIC.has(t));
}

// Did the model copy this from the page, or invent it?
function verifyEvidence(evidence, haystack) {
  const e = normalize(evidence);
  if (!e || e.length < 6) return false;

  // 1. The citation appears verbatim. This is what the prompt asked for.
  if (haystack.includes(e)) return true;

  // 2. Otherwise it must contain at least one token that could ONLY have come
  //    from this page — a real id, class, filename, or piece of visible text.
  //    Matching only on generic HTML structure is not evidence of anything.
  const tokens = distinctiveTokens(evidence);
  return tokens.some((t) => haystack.includes(t));
}

/**
 * Gather everything captured across every scenario into the evidence the model
 * sees. A full scan has many pages; a recorded path has many steps. Each is a
 * scenario and each contributes.
 */
export function collectEvidence(scan) {
  const rules = new Map();

  const sources =
    Array.isArray(scan.pages) && scan.pages.length
      ? scan.pages.map((p) => ({ label: p.title || p.url, url: p.url, violations: p.violations ?? [] }))
      : [{ label: scan.title || scan.url, url: scan.url, violations: scan.violations ?? [] }];

  for (const src of sources) {
    for (const v of src.violations) {
      if (!rules.has(v.id)) {
        rules.set(v.id, {
          rule: v.id,
          impact: v.impact,
          help: v.help,
          description: v.description,
          wcag: v.wcag ?? [],
          elements: 0,
          scenarios: new Set(),
          samples: [],
        });
      }
      const r = rules.get(v.id);
      r.elements += (v.nodes ?? []).length;
      r.scenarios.add(src.label);

      for (const n of v.nodes ?? []) {
        r.samples.push({
          scenario: src.label,
          selector: n.target,
          html: n.html ?? "",
          failureSummary: n.failureSummary ?? "",
          screenshot: n.screenshot ?? null,
        });
      }
    }
  }

  const top = [...rules.values()]
    .sort((a, b) => SEV_ORDER[a.impact] - SEV_ORDER[b.impact] || b.elements - a.elements)
    .slice(0, MAX_RULES)
    .map((r) => ({
      ...r,
      scenarios: [...r.scenarios],
      // Prefer samples that carry a screenshot — those are the ones the model can
      // actually SEE, so they should be the ones it writes about.
      samples: r.samples
        .slice()
        .sort((a, b) => (b.screenshot ? 1 : 0) - (a.screenshot ? 1 : 0))
        .slice(0, 3),
    }));

  const images = [];
  if (scan.screenshot) images.push(scan.screenshot);
  for (const r of top) {
    for (const s of r.samples) {
      if (s.screenshot && images.length < MAX_ELEMENT_IMAGES + 1) images.push(s.screenshot);
    }
  }

  // Keyboard & focus evidence, per scenario. axe cannot press Tab, so without
  // this the report is structurally blind to the defects that most reliably
  // block a keyboard user.
  const keyboardByScenario = [];
  if (Array.isArray(scan.pages) && scan.pages.length) {
    for (const p of scan.pages) {
      if (p.keyboard) keyboardByScenario.push({ scenario: p.title || p.url, kb: p.keyboard });
    }
  } else if (scan.keyboard) {
    keyboardByScenario.push({ scenario: scan.title || scan.url, kb: scan.keyboard });
  }

  // These were MEASURED (focus rings, hidden focus targets, tab order). They are
  // facts, not opinions — they go into the report pre-verified, and the model is
  // told not to re-report them.
  const measuredKeyboard = [];
  for (const { scenario, kb } of keyboardByScenario) {
    for (const f of kb.findings ?? []) {
      measuredKeyboard.push({ ...f, scenario });
    }
  }

  const haystack = normalize(
    [
      ...top.flatMap((r) => r.samples.map((s) => `${s.selector} ${s.html} ${s.failureSummary}`)),
      // Keyboard traces are part of the evidence corpus too, so a model citing a
      // focus step counts as citing real evidence.
      ...keyboardByScenario.flatMap(({ kb }) =>
        (kb.walk?.trace ?? []).map((t) => `${t.selector} ${t.html} ${t.name}`)
      ),
    ].join(" ")
  );

  return { top, images, haystack, scenarioCount: sources.length, keyboardByScenario, measuredKeyboard };
}

function buildPrompt(scan, ev) {
  const imageNote = ev.images.length
    ? `\nYou have been given ${ev.images.length} image(s): the page as a sighted user sees it, followed by close-ups of failing elements (each outlined). Use them. Where the screenshot and the markup disagree — something that looks like a heading but is a generic div, a control that looks pressed but exposes no state — that disagreement is the most valuable thing you can report.`
    : `\nNo screenshots were captured for this scan. Work from the markup alone and do not speculate about anything visual.`;

  const rules = ev.top
    .map(
      (r) => `
RULE: ${r.rule}  [${r.impact}]  WCAG ${(r.wcag ?? []).join(", ") || "—"}
  ${r.help}
  Fails on ${r.elements} element(s), across: ${r.scenarios.join(", ")}
  Failing elements (verbatim from the live page):
${r.samples
  .map(
    (s, i) =>
      `    ${i + 1}. [${s.scenario}] selector: ${s.selector}
       html: ${String(s.html).slice(0, 400)}
       why:  ${String(s.failureSummary || "").slice(0, 200)}${s.screenshot ? "\n       (a screenshot of this element is attached)" : ""}`
  )
  .join("\n")}`
    )
    .join("\n");

  return `You are a senior accessibility consultant writing a WCAG 2.1 Level A/AA report for developers.

APPLICATION: ${scan.title || scan.url}
SCORE: ${scan.score}/100
SCENARIOS SCANNED: ${ev.scenarioCount}
ISSUE COUNTS: ${JSON.stringify(scan.counts ?? {})}
${imageNote}

THE EVIDENCE — every element below was captured from the live, logged-in page:
${rules}

${ev.keyboardByScenario
  .map(({ scenario, kb }) => `--- SCENARIO: ${scenario} ---\n${buildKeyboardEvidenceText(kb)}`)
  .join("\n\n") || "KEYBOARD & FOCUS: not captured for this scan."}

Write a JSON report containing:

- executiveSummary: 3-5 sentences. Where this stands against WCAG 2.1 AA, the biggest risks, what to do first.
- businessImpact: 3-4 sentences for non-technical stakeholders. Which users are blocked and how, plus compliance exposure (ADA / EN 301 549 / Section 508) framed as risk, not legal advice.
- fixes: one per rule above. Each MUST contain:
    * selector  — the CSS selector of the specific element you are fixing, copied from the evidence.
    * evidence  — a VERBATIM string copied character-for-character from that element's html above, proving the problem. Never paraphrase into this field. Never invent it. If you cannot copy a real string, do not write the fix.
    * explanation — 1-2 sentences on why it fails and who it blocks.
    * html / react / angular — the CORRECTED code, rewritten from the ACTUAL element above, not a generic example. Keep its real classes, ids and attributes; change only what fixes the issue.
- quickWins: 3-5 one-line actions ordered by effort-to-impact.

KEYBOARD AND FOCUS — this is the half of accessibility the scanner cannot see, and it is where a
keyboard user actually gets blocked. Using the focus trace above, add fixes (beyond the MEASURED
ones already listed) for anything you can evidence: focus that is lost after a menu or dialog opens,
custom widgets that cannot be operated with the keyboard (arrow keys, Escape, Enter, Space), controls
that can be focused but not activated, and focus order that will disorient a keyboard user. Cite a
step from the trace as your evidence. Do not invent keyboard behaviour you cannot see in the trace.

Scope is WCAG 2.1 Level A and AA only. Do not cite WCAG 2.2 criteria (2.4.11, 2.5.8, 3.3.7, 3.3.8) or Level AAA criteria.`;
}

export async function generateAiReport(scan, ai) {
  const ev = collectEvidence(scan);

  if (!ev.top.length) {
    return {
      report: {
        executiveSummary: "No accessibility violations were found in this scan.",
        businessImpact:
          "No WCAG 2.1 A/AA violations were detected, so this scan indicates no compliance exposure.",
        fixes: [],
        quickWins: [],
        generatedAt: new Date().toISOString(),
        provider: `${ai.provider}/${ai.model}`,
        // No AI call was made — nothing to price.
        usage: { inputTokens: 0, outputTokens: 0 },
        cost: { usd: 0, inputTokens: 0, outputTokens: 0, note: "no AI call was made — no violations to report on" },
        evidence: { scenarios: ev.scenarioCount, imagesUsed: 0, verified: 0, unverified: 0 },
      },
      warnings: [],
      recovered: false,
      degraded: false,
    };
  }

  const prompt = buildPrompt(scan, ev);
  const warnings = [];
  let data;
  let recovered = false;
  let sawImages = ev.images.length;
  let usage = { inputTokens: 0, outputTokens: 0 };

  try {
    // Schema-constrained + vision. Also the cure for the malformed-JSON failures:
    // the decoder cannot emit invalid JSON in the first place.
    data = await aiStructured(ai, {
      system:
        "You are a senior accessibility consultant. You ground every claim in the evidence you are given and never invent markup.",
      user: prompt,
      images: ev.images,
      schema: REPORT_SCHEMA,
      maxTokens: 6000,
    });
    usage = data.__usage ?? usage;
  } catch (e) {
    // Some gateways reject images or json_schema. Degrade to plain text with
    // tolerant parsing rather than losing the report entirely.
    sawImages = 0;
    warnings.push({
      stage: "structured",
      message: `Structured/vision request failed (${String(e.message ?? e)}). Retried as plain text — the model did NOT see the screenshots, so fixes may be less specific.`,
      detail: null,
    });
    const { text: raw, usage: fallbackUsage } = await aiChatWithUsage(
      ai,
      prompt +
        "\n\nReply with ONLY valid JSON. No markdown fences, no preamble. Escape all quotes and newlines inside JSON strings. Never use backticks to quote a value.",
      5000
    );
    usage = fallbackUsage;
    const parsed = parseAiJson(raw, { salvageKeys: ["fixes", "quickWins"] });
    data = parsed.data;
    warnings.push(...parsed.warnings);
    recovered = parsed.recovered;
  }

  let fixes = (Array.isArray(data.fixes) ? data.fixes : [])
    .filter((f) => f && (f.title || f.rule))
    .map((f) => {
      const evidence = String(f.evidence ?? "");
      const verified = verifyEvidence(evidence, ev.haystack);

      // Attach the screenshot of the element this fix is about, matched by
      // selector, so the report shows the reader exactly what is broken.
      const rule = ev.top.find((r) => r.rule === f.rule);
      const sample =
        rule?.samples.find((s) => s.selector === f.selector) ??
        rule?.samples.find((s) => s.screenshot) ??
        rule?.samples[0];

      return {
        rule: String(f.rule ?? "unknown"),
        impact: ["critical", "serious", "moderate", "minor"].includes(f.impact) ? f.impact : "moderate",
        title: String(f.title ?? f.rule ?? "Fix"),
        explanation: String(f.explanation ?? ""),
        selector: String(f.selector ?? sample?.selector ?? ""),
        evidence,
        evidenceStatus: verified ? "verified" : "unverified",
        scenario: sample?.scenario ?? null,
        screenshot: sample?.screenshot ?? null,
        html: String(f.html ?? ""),
        react: String(f.react ?? ""),
        angular: String(f.angular ?? ""),
      };
    });

  // Measured keyboard/focus findings go in as facts. They are not the model's
  // opinion, so they are verified by construction and cannot be hallucinated.
  const measuredFixes = ev.measuredKeyboard.map((f) => ({
    rule: f.rule,
    impact: f.impact,
    title: f.title,
    explanation: f.explanation,
    selector: f.selector ?? "",
    evidence: f.evidence ?? "",
    evidenceStatus: "verified",
    measured: true,
    wcag: f.wcag ?? [],
    scenario: f.scenario ?? null,
    screenshot: null,
    html: "",
    react: "",
    angular: "",
  }));

  // Drop any AI fix that merely restates a measurement.
  const measuredRules = new Set(measuredFixes.map((f) => f.rule));
  const aiFixes = fixes.filter((f) => !measuredRules.has(f.rule));
  fixes = [...measuredFixes, ...aiFixes];

  const unverified = fixes.filter((f) => f.evidenceStatus === "unverified").length;
  if (unverified) {
    warnings.push({
      stage: "evidence",
      message: `${unverified} of ${fixes.length} fixes cite evidence that could not be found in the captured page. They are flagged unverified — confirm before acting on them.`,
      detail: fixes
        .filter((f) => f.evidenceStatus === "unverified")
        .map((f) => `${f.rule}: "${f.evidence.slice(0, 120)}"`)
        .join("\n"),
    });
  }

  if (fixes.length < ev.top.length) {
    warnings.push({
      stage: "coverage",
      message: `Asked for ${ev.top.length} fixes but only ${fixes.length} came back intact.`,
      detail: null,
    });
  }

  const cost = estimateCost({
    provider: ai.provider,
    model: ai.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  const report = {
    executiveSummary:
      typeof data.executiveSummary === "string" && data.executiveSummary.trim()
        ? data.executiveSummary
        : "(The model did not return an executive summary — see Logs.)",
    businessImpact:
      typeof data.businessImpact === "string" && data.businessImpact.trim()
        ? data.businessImpact
        : "(The model did not return a business impact section — see Logs.)",
    fixes,
    quickWins: Array.isArray(data.quickWins) ? data.quickWins.map(String) : [],
    generatedAt: new Date().toISOString(),
    provider: `${ai.provider}/${ai.model}`,
    usage,
    cost,
    evidence: {
      scenarios: ev.scenarioCount,
      imagesUsed: sawImages,
      verified: fixes.length - unverified,
      unverified,
      keyboardMeasured: measuredFixes.length,
      focusIndicatorsMissing: ev.keyboardByScenario.reduce(
        (n, { kb }) => n + (kb.stats?.focusIndicatorsMissing ?? 0), 0
      ),
      focusableTraced: ev.keyboardByScenario.reduce(
        (n, { kb }) => n + (kb.stats?.stepsTraced ?? 0), 0
      ),
    },
  };

  return {
    report,
    warnings,
    recovered,
    degraded: recovered || unverified > 0 || fixes.length < ev.top.length,
  };
}
