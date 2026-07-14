// A11y Lens — AI Expert Audit engine.
//
// Pipeline:
//   capture evidence (screenshot + DOM + ARIA tree + keyboard walk)
//     -> build suppression list from the LIVE axe results for this page
//     -> one-shot the model with a schema-constrained request
//     -> validate shape, then VERIFY each finding's evidence against the inputs
//     -> return findings + passes
//
// The verification step is the part that matters. The prompt tells the model to
// quote verbatim; this checks that it actually did. A "finding" whose evidence
// string appears nowhere in the DOM, ARIA tree, or keyboard walk is flagged
// unverified rather than silently trusted — that's the difference between an
// audit you can hand to a developer and a plausible-sounding hallucination.
import { captureEvidence, buildEvidenceText } from "./evidence.mjs";
import { buildExpertSystemPrompt } from "./expert-prompt.mjs";
import { aiStructured } from "./ai.mjs";
import { runFocusVisibleProbe, runZoomReflowProbe } from "./probes.mjs";
import { estimateCost } from "./cost.mjs";
import { normalizeWcag } from "./wcag.mjs";

// JSON schema handed to the provider for constrained decoding.
export const EXPERT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          zone: { type: "string", description: 'Visible page area, e.g. "Product filters"' },
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "serious", "moderate", "minor"] },
          description: { type: "string", description: "What is wrong, in plain language." },
          userImpact: { type: "string", description: "Concrete impact on keyboard / screen-reader / low-vision users." },
          fix: { type: "string", description: "Concrete code-level remediation, not a WCAG paraphrase." },
          evidence: { type: "string", description: "Verbatim string copied from the DOM, ARIA tree, or keyboard walk." },
          wcag: { type: "array", items: { type: "string" }, description: 'e.g. ["4.1.2 A", "2.4.7 AA"]' },
        },
        required: ["zone", "title", "severity", "description", "userImpact", "fix", "evidence", "wcag"],
      },
    },
    passes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          zone: { type: "string" },
          message: { type: "string" },
        },
        required: ["zone", "message"],
      },
    },
  },
  required: ["findings", "passes"],
};

const SEVERITIES = ["critical", "serious", "moderate", "minor"];

// Normalize whitespace/quotes so verification isn't defeated by trivial
// reformatting the model may apply when copying a quote.
function normalize(s) {
  return String(s)
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// Does this evidence string actually appear in what we gave the model?
// Absence-evidence legitimately won't match verbatim (the model is quoting an
// element and asserting something is missing from it), so we also accept a
// partial match on a meaningful fragment.
function verifyEvidence(evidence, haystack) {
  const e = normalize(evidence);
  if (!e || e.length < 8) return false;
  if (haystack.includes(e)) return true;

  // Models often embed the real quote inside a sentence:
  //   'The link text is "Læs mere", which is not descriptive'
  // The sentence is the model's words; the quoted span is what must be real.
  const quoted = [...String(evidence).matchAll(/[<"'`\u201C\u2018]([^<>"'`\u201D\u2019]{4,})[>"'`\u201D\u2019]/g)]
    .map((m) => m[1]);
  for (const q of quoted) {
    const nq = normalize(q);
    if (nq.length >= 4 && haystack.includes(nq)) return true;
  }

  // Fall back to the longest run of meaningful words appearing verbatim.
  const words = e.split(" ").filter((w) => w.length > 3);
  for (let n = Math.min(words.length, 8); n >= 3; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (haystack.includes(words.slice(i, i + n).join(" "))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Split into capture / judge so a cross-check can run TWO models against the
// EXACT SAME evidence. If the agents saw different screenshots or a different
// DOM, agreement between them would mean nothing.
// ---------------------------------------------------------------------------

export async function captureAuditContext(page, {
  axeViolations = [],
  keyboardWalk = true,
  scope = "main",
  probes = true,
} = {}) {
  // Deterministic probes first: measurements, not opinions. They run regardless
  // of the model and can never hallucinate.
  let probeFindings = [];
  let probeStats = { focusChecked: 0, focusMissing: 0 };
  if (probes) {
    const focus = await runFocusVisibleProbe(page, { excludeChrome: scope === "main" })
      .catch(() => ({ findings: [], checked: 0, missing: 0 }));
    const zoom = await runZoomReflowProbe(page).catch(() => ({ findings: [] }));
    probeFindings = [...focus.findings, ...zoom.findings];
    probeStats = { focusChecked: focus.checked, focusMissing: focus.missing };
  }

  const evidence = await captureEvidence(page, { keyboardWalk });

  // Suppression list from THIS page's live scanner results — not a static list.
  const suppress = [...new Set(axeViolations.map((v) => v.id))];

  const haystack = normalize(
    [evidence.dom?.html ?? "", evidence.ariaTree ?? "", JSON.stringify(evidence.keyboardWalk ?? [])].join(" ")
  );

  return { evidence, probeFindings, probeStats, suppress, haystack, scope };
}

// Run ONE model against a captured context. Returns cleaned findings + usage.
export async function judgeEvidence(ai, ctx) {
  const { evidence, probeFindings, suppress, haystack, scope } = ctx;

  const system = buildExpertSystemPrompt({ scope, probeFindings });
  const user = buildEvidenceText(evidence, suppress);

  const raw = await aiStructured(ai, {
    system,
    user,
    images: evidence.screenshot ? [evidence.screenshot] : [],
    schema: EXPERT_SCHEMA,
    maxTokens: 8000,
  });
  const usage = raw.__usage ?? { inputTokens: 0, outputTokens: 0 };

  if (!raw || !Array.isArray(raw.findings)) {
    throw new Error("The model returned an unexpected shape. Try a larger model or a different provider.");
  }

  const suppressed = new Set(suppress);
  let droppedSuppressed = 0;
  let droppedProbeDuplicate = 0;
  let wcagRemapped = 0;
  let droppedOutOfScope = 0;

  // A probe MEASURED these. The prompt asks the model not to duplicate them, but
  // a prompt is a request, not a guarantee — so enforce it here too.
  const probeCriteria = new Set(
    probeFindings.flatMap((f) => (f.wcag ?? []).map((w) => String(w).match(/(\d+\.\d+\.\d+)/)?.[1]).filter(Boolean))
  );
  const titleTokens = (t) => new Set(normalize(t).split(" ").filter((w) => w.length > 3));
  const probeTitleSets = probeFindings.map((f) => titleTokens(f.title));
  const duplicatesProbe = (f) => {
    const crits = (f.wcag ?? []).map((w) => String(w).match(/(\d+\.\d+\.\d+)/)?.[1]).filter(Boolean);
    if (!crits.some((c) => probeCriteria.has(c))) return false;
    const t = titleTokens(f.title);
    return probeTitleSets.some((p) => {
      const overlap = [...t].filter((w) => p.has(w)).length;
      return overlap >= 2 || overlap / Math.max(1, Math.min(t.size, p.size)) >= 0.5;
    });
  };

  const findings = raw.findings
    .filter((f) => f && f.title && f.severity)
    .filter((f) => {
      const hit = [...suppressed].some((id) =>
        normalize(`${f.title} ${f.description ?? ""}`).includes(normalize(id.replace(/-/g, " ")))
      );
      if (hit) droppedSuppressed++;
      return !hit;
    })
    .filter((f) => {
      if (duplicatesProbe(f)) { droppedProbeDuplicate++; return false; }
      return true;
    })
    .map((f) => {
      // Scope guard: target standard is WCAG 2.1 A/AA. Models habitually cite
      // WCAG 2.2 criteria. Remap where a 2.1 equivalent exists, flag where not.
      const w = normalizeWcag(f.wcag);
      if (w.remapped.length) wcagRemapped += w.remapped.length;
      return {
        zone: String(f.zone ?? "Page").slice(0, 120),
        title: String(f.title).slice(0, 160),
        severity: SEVERITIES.includes(f.severity) ? f.severity : "moderate",
        description: String(f.description ?? "").slice(0, 900),
        userImpact: String(f.userImpact ?? "").slice(0, 700),
        fix: String(f.fix ?? "").slice(0, 900),
        evidence: String(f.evidence ?? "").slice(0, 600),
        wcag: w.wcag,
        outOfScopeWcag: w.outOfScope,
        evidenceStatus: verifyEvidence(f.evidence ?? "", haystack) ? "verified" : "unverified",
        source: "ai",
      };
    })
    // A finding whose ONLY citation fell outside WCAG 2.1 (e.g. 2.5.8 Target Size,
    // which has no 2.1 AA equivalent) is not a 2.1 conformance issue. Drop rather
    // than mislabel.
    .filter((f) => {
      if (!f.wcag.length && f.outOfScopeWcag.length) { droppedOutOfScope++; return false; }
      return true;
    });

  const passes = Array.isArray(raw.passes)
    ? raw.passes
        .filter((p) => p && p.message)
        .map((p) => ({ zone: String(p.zone ?? "Page").slice(0, 120), message: String(p.message).slice(0, 400) }))
    : [];

  return {
    findings,
    passes,
    usage,
    dropped: {
      scannerDuplicate: droppedSuppressed,
      probeDuplicate: droppedProbeDuplicate,
      outOfWcag21Scope: droppedOutOfScope,
      wcagRemappedFrom22: wcagRemapped,
    },
  };
}

// Single-agent audit. Signature unchanged — existing callers keep working.
export async function runExpertAudit(page, {
  ai,
  axeViolations = [],
  keyboardWalk = true,
  scope = "main",
  probes = true,
} = {}) {
  const ctx = await captureAuditContext(page, { axeViolations, keyboardWalk, scope, probes });
  const judged = await judgeEvidence(ai, ctx);

  const all = [...ctx.probeFindings, ...judged.findings];
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of all) counts[f.severity]++;

  const cost = estimateCost({
    provider: ai.provider,
    model: ai.model,
    inputTokens: judged.usage.inputTokens,
    outputTokens: judged.usage.outputTokens,
  });

  return {
    url: ctx.evidence.url,
    title: ctx.evidence.title,
    generatedAt: new Date().toISOString(),
    provider: `${ai.provider}/${ai.model}`,
    mode: "single",
    scope,
    findings: all,
    passes: judged.passes,
    counts,
    cost,
    stats: {
      total: all.length,
      fromProbes: ctx.probeFindings.length,
      fromAi: judged.findings.length,
      verified: all.filter((f) => f.evidenceStatus === "verified").length,
      unverified: all.filter((f) => f.evidenceStatus === "unverified").length,
      suppressedRules: ctx.suppress,
      droppedAsScannerDuplicate: judged.dropped.scannerDuplicate,
      droppedAsProbeDuplicate: judged.dropped.probeDuplicate,
      wcagRemappedFrom22: judged.dropped.wcagRemappedFrom22,
      droppedOutOfWcag21Scope: judged.dropped.outOfWcag21Scope,
      standard: "WCAG 2.1 A/AA",
      keyboardWalkSteps: ctx.evidence.keyboardWalk?.length ?? 0,
      focusProbeChecked: ctx.probeStats.focusChecked,
      focusProbeMissing: ctx.probeStats.focusMissing,
      domTruncated: !!ctx.evidence.dom?.truncated,
      ariaTreeAvailable: !!ctx.evidence.ariaTree,
      screenshotIncluded: !!ctx.evidence.screenshot,
    },
  };
}

export { normalize, verifyEvidence };
