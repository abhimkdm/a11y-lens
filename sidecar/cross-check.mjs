// A11y Lens — two-agent cross-check.
//
// The problem: a single model's findings are plausible-sounding but you cannot
// tell which ones are real. Evidence verification catches fabricated *quotes*,
// but a model can quote a real element and still draw a wrong conclusion from it.
//
// The fix: run TWO models from different families against the EXACT SAME captured
// evidence, then reconcile.
//
//   consensus     — both agents independently flagged it. Highest trust.
//   confirmed     — one agent flagged it; the OTHER agent, shown it, agreed it's real.
//   single        — one agent flagged it; the other rejected it or wasn't asked. Needs review.
//   deterministic — a probe measured it. Not an opinion at all; cannot be wrong.
//
// Trusted tier = consensus + confirmed + deterministic. `single` = triage queue.
//
// Cost is roughly 2-2.3x a single-agent audit: two full audits plus two small
// adjudication calls. That is the price of knowing which findings to trust.
import { captureAuditContext, judgeEvidence, normalize } from "./expert-audit.mjs";
import { aiStructured } from "./ai.mjs";
import { estimateCost } from "./cost.mjs";
import { extractCriterion } from "./wcag.mjs";

// Two findings are "the same finding" if they cite a shared WCAG criterion AND
// their titles/zones overlap meaningfully. Deliberately deterministic — using an
// LLM to match findings would just add a third opinion to reconcile.
function sameFinding(a, b) {
  const critsA = new Set((a.wcag ?? []).map(extractCriterion).filter(Boolean));
  const critsB = new Set((b.wcag ?? []).map(extractCriterion).filter(Boolean));
  const sharedCriterion = [...critsA].some((c) => critsB.has(c));

  const toks = (f) =>
    new Set(
      normalize(`${f.zone} ${f.title}`)
        .split(" ")
        .filter((w) => w.length > 3)
    );
  const ta = toks(a), tb = toks(b);
  const overlap = [...ta].filter((w) => tb.has(w)).length;
  const ratio = overlap / Math.max(1, Math.min(ta.size, tb.size));

  // Shared criterion + some title overlap, OR very strong title overlap alone
  // (models sometimes cite different-but-related criteria for the same issue).
  if (sharedCriterion && (overlap >= 2 || ratio >= 0.4)) return true;
  if (ratio >= 0.7 && overlap >= 3) return true;
  return false;
}

const ADJUDICATION_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index of the finding being judged." },
          verdict: { type: "string", enum: ["real", "not_real"] },
          reason: { type: "string", description: "One sentence. Cite the evidence, or say what is missing." },
        },
        required: ["index", "verdict", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

// Show one agent the OTHER agent's unmatched findings and ask: given this exact
// evidence, is each one real? This is what turns a `single` into a `confirmed`
// or kills it.
async function adjudicate(ai, ctx, findings) {
  if (!findings.length) return new Map();

  const system =
    `You are a senior accessibility specialist reviewing another auditor's findings against WCAG 2.1 Level A/AA. ` +
    `You are given the SAME page evidence they saw. For each finding, decide whether it is REAL — supported by the ` +
    `evidence provided — or NOT REAL (unsupported, hallucinated, out of WCAG 2.1 A/AA scope, or already covered by ` +
    `the automated scanner).\n` +
    `Be strict. A finding is only "real" if you can point to the supporting evidence yourself. ` +
    `Do not be agreeable: rejecting a plausible-sounding but unsupported finding is the entire point of this review. ` +
    `Do not accept a finding that cites a WCAG 2.2 criterion — the target standard is WCAG 2.1.`;

  const list = findings
    .map(
      (f, i) =>
        `[${i}] zone="${f.zone}" severity=${f.severity} wcag=${(f.wcag ?? []).join(",") || "none"}\n` +
        `    title: ${f.title}\n` +
        `    claim: ${f.description}\n` +
        `    cited evidence: ${f.evidence}`
    )
    .join("\n\n");

  const user =
    `PAGE EVIDENCE\n` +
    `Accessibility tree:\n${(ctx.evidence.ariaTree || "(unavailable)").slice(0, 8000)}\n\n` +
    `Keyboard walk:\n${JSON.stringify(ctx.evidence.keyboardWalk ?? []).slice(0, 4000)}\n\n` +
    `Sanitized DOM:\n${(ctx.evidence.dom?.html || "").slice(0, 25000)}\n\n` +
    `Rules the automated scanner already caught (do not accept findings that merely restate these): ` +
    `${ctx.suppress.join(", ") || "(none)"}\n\n` +
    `FINDINGS TO JUDGE\n${list}`;

  const raw = await aiStructured(ai, {
    system,
    user,
    images: ctx.evidence.screenshot ? [ctx.evidence.screenshot] : [],
    schema: ADJUDICATION_SCHEMA,
    maxTokens: 3000,
  }).catch(() => null);

  const usage = raw?.__usage ?? { inputTokens: 0, outputTokens: 0 };
  const verdicts = new Map();
  for (const v of raw?.verdicts ?? []) {
    if (typeof v.index === "number" && findings[v.index]) {
      verdicts.set(v.index, { verdict: v.verdict, reason: String(v.reason ?? "").slice(0, 300) });
    }
  }
  verdicts.__usage = usage;
  return verdicts;
}

export async function runCrossCheckAudit(page, {
  aiA,
  aiB,
  axeViolations = [],
  keyboardWalk = true,
  scope = "main",
  probes = true,
  adjudicateSingles = true,
} = {}) {
  if (!aiB?.provider) {
    throw new Error("Cross-check needs a second AI provider. Configure the cross-check model in Settings.");
  }

  // ONE capture. Both agents judge identical evidence — otherwise agreement
  // between them would be meaningless.
  const ctx = await captureAuditContext(page, { axeViolations, keyboardWalk, scope, probes });

  const [a, b] = await Promise.all([judgeEvidence(aiA, ctx), judgeEvidence(aiB, ctx)]);

  // --- Reconcile: match A's findings against B's ---
  const matchedB = new Set();
  const consensus = [];
  const singlesA = [];

  for (const fa of a.findings) {
    const idx = b.findings.findIndex((fb, i) => !matchedB.has(i) && sameFinding(fa, fb));
    if (idx >= 0) {
      matchedB.add(idx);
      const fb = b.findings[idx];
      // Both agents saw it. Keep the richer description, and the harsher severity
      // (if the agents disagree on severity, err toward the higher one).
      const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      const worse = order[fa.severity] <= order[fb.severity] ? fa.severity : fb.severity;
      consensus.push({
        ...fa,
        severity: worse,
        description: (fa.description?.length ?? 0) >= (fb.description?.length ?? 0) ? fa.description : fb.description,
        wcag: [...new Set([...(fa.wcag ?? []), ...(fb.wcag ?? [])])],
        agreement: "consensus",
        agreedBy: ["A", "B"],
        confidence: 0.95,
      });
    } else {
      singlesA.push(fa);
    }
  }
  const singlesB = b.findings.filter((_, i) => !matchedB.has(i));

  // --- Adjudicate: each agent judges the OTHER's unmatched findings ---
  let adjUsageA = { inputTokens: 0, outputTokens: 0 };
  let adjUsageB = { inputTokens: 0, outputTokens: 0 };
  const resolved = [];

  if (adjudicateSingles && (singlesA.length || singlesB.length)) {
    const [verdictsOnA, verdictsOnB] = await Promise.all([
      adjudicate(aiB, ctx, singlesA),   // B judges A's singles
      adjudicate(aiA, ctx, singlesB),   // A judges B's singles
    ]);
    adjUsageB = verdictsOnA.__usage ?? adjUsageB;
    adjUsageA = verdictsOnB.__usage ?? adjUsageA;

    singlesA.forEach((f, i) => {
      const v = verdictsOnA.get(i);
      resolved.push({
        ...f,
        agreement: v?.verdict === "real" ? "confirmed" : "single",
        agreedBy: v?.verdict === "real" ? ["A", "B"] : ["A"],
        adjudication: v ? { by: "B", verdict: v.verdict, reason: v.reason } : null,
        confidence: v?.verdict === "real" ? 0.8 : 0.4,
      });
    });
    singlesB.forEach((f, i) => {
      const v = verdictsOnB.get(i);
      resolved.push({
        ...f,
        agreement: v?.verdict === "real" ? "confirmed" : "single",
        agreedBy: v?.verdict === "real" ? ["B", "A"] : ["B"],
        adjudication: v ? { by: "A", verdict: v.verdict, reason: v.reason } : null,
        confidence: v?.verdict === "real" ? 0.8 : 0.4,
      });
    });
  } else {
    singlesA.forEach((f) => resolved.push({ ...f, agreement: "single", agreedBy: ["A"], confidence: 0.4 }));
    singlesB.forEach((f) => resolved.push({ ...f, agreement: "single", agreedBy: ["B"], confidence: 0.4 }));
  }

  // Probe findings are measurements — they don't get an opinion, they get a fact.
  const probeStamped = ctx.probeFindings.map((f) => ({
    ...f,
    agreement: "deterministic",
    agreedBy: ["probe"],
    confidence: 1,
  }));

  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const tierOrder = { deterministic: 0, consensus: 1, confirmed: 2, single: 3 };
  const all = [...probeStamped, ...consensus, ...resolved].sort(
    (x, y) => tierOrder[x.agreement] - tierOrder[y.agreement] || order[x.severity] - order[y.severity]
  );

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of all) counts[f.severity]++;

  const trusted = all.filter((f) => f.agreement !== "single");

  const costA = estimateCost({
    provider: aiA.provider, model: aiA.model,
    inputTokens: a.usage.inputTokens + adjUsageA.inputTokens,
    outputTokens: a.usage.outputTokens + adjUsageA.outputTokens,
  });
  const costB = estimateCost({
    provider: aiB.provider, model: aiB.model,
    inputTokens: b.usage.inputTokens + adjUsageB.inputTokens,
    outputTokens: b.usage.outputTokens + adjUsageB.outputTokens,
  });
  const totalUsd =
    costA.usd === null || costB.usd === null ? null : Math.round((costA.usd + costB.usd) * 10000) / 10000;

  // Passes only survive if BOTH agents claim them — a pass one agent contradicts
  // is not a pass worth printing.
  const passes = a.passes.filter((pa) =>
    b.passes.some((pb) => normalize(pb.zone) === normalize(pa.zone))
  );

  return {
    url: ctx.evidence.url,
    title: ctx.evidence.title,
    generatedAt: new Date().toISOString(),
    mode: "cross-check",
    provider: `${aiA.provider}/${aiA.model} + ${aiB.provider}/${aiB.model}`,
    agentA: `${aiA.provider}/${aiA.model}`,
    agentB: `${aiB.provider}/${aiB.model}`,
    scope,
    findings: all,
    passes,
    counts,
    cost: {
      usd: totalUsd,
      inputTokens: costA.inputTokens + costB.inputTokens,
      outputTokens: costA.outputTokens + costB.outputTokens,
      breakdown: { agentA: costA, agentB: costB },
    },
    stats: {
      total: all.length,
      trusted: trusted.length,
      needsReview: all.length - trusted.length,
      tiers: {
        deterministic: probeStamped.length,
        consensus: consensus.length,
        confirmed: resolved.filter((f) => f.agreement === "confirmed").length,
        single: resolved.filter((f) => f.agreement === "single").length,
      },
      agentARaw: a.findings.length,
      agentBRaw: b.findings.length,
      // The headline honesty number: how often did two independent models
      // actually agree? A low number means treat the whole report with caution.
      agreementRate: a.findings.length + b.findings.length > 0
        ? Math.round((consensus.length * 2 / (a.findings.length + b.findings.length)) * 100)
        : 0,
      verified: all.filter((f) => f.evidenceStatus === "verified").length,
      unverified: all.filter((f) => f.evidenceStatus === "unverified").length,
      suppressedRules: ctx.suppress,
      standard: "WCAG 2.1 A/AA",
      keyboardWalkSteps: ctx.evidence.keyboardWalk?.length ?? 0,
      focusProbeChecked: ctx.probeStats.focusChecked,
      focusProbeMissing: ctx.probeStats.focusMissing,
      domTruncated: !!ctx.evidence.dom?.truncated,
      ariaTreeAvailable: !!ctx.evidence.ariaTree,
      screenshotIncluded: !!ctx.evidence.screenshot,
      fromProbes: probeStamped.length,
      fromAi: consensus.length + resolved.length,
      droppedAsScannerDuplicate: a.dropped.scannerDuplicate + b.dropped.scannerDuplicate,
      droppedAsProbeDuplicate: a.dropped.probeDuplicate + b.dropped.probeDuplicate,
      wcagRemappedFrom22: a.dropped.wcagRemappedFrom22 + b.dropped.wcagRemappedFrom22,
      droppedOutOfWcag21Scope: a.dropped.outOfWcag21Scope + b.dropped.outOfWcag21Scope,
    },
  };
}
