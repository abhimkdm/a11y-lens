// A11y Lens — Mobile flow scanning.
//
// A "flow" is a user journey scanned one screen at a time: the tester navigates
// the app by hand (login → search → checkout), pressing "Scan step" on each
// screen. The value over N separate scans is DEDUPLICATION: a broken tab bar
// appears on every screen of a flow, and without cross-step dedup the report
// says "40 issues" when the truth is "8 issues, one of them on every screen".
//
// This mirrors what the Chrome-extension version of A11y Lens did for web flow
// sessions, rebuilt for native findings (there is no CSS selector to key on, so
// the identity of a finding is its rule + the evidence text, which carries the
// platform element identifiers — resource-ids on Android, labels/types on iOS).
//
// Only ONE flow can be active at a time — same single-session model as the rest
// of the sidecar.
import { scanMobile } from "./scanner.mjs";

let active = null;

const normalize = (s) =>
  String(s ?? "").replace(/[\u2018\u2019\u201C\u201D]/g, '"').replace(/\s+/g, " ").toLowerCase().trim();

// Identity of a finding across steps. Measured findings key on rule + evidence
// (which quotes the offending elements verbatim). AI findings have no stable
// element identity, so they key on rule + title — two steps where the model
// reports "Reading order jumps past the price" are the same issue.
function findingKey(f) {
  const body = f.measured ? f.evidence : f.title;
  return `${f.rule}|${normalize(body).slice(0, 240)}`;
}

export function flowStatus() {
  if (!active) return { active: false };
  return {
    active: true,
    name: active.name,
    platform: active.platform,
    deviceId: active.deviceId,
    startedAt: active.startedAt,
    steps: active.steps.map(stepSummary),
    uniqueFindings: active.merged.size,
  };
}

function stepSummary(s) {
  return {
    index: s.index,
    label: s.label,
    app: s.app,
    timestamp: s.timestamp,
    counts: s.counts,
    newFindings: s.newFindings,
  };
}

export function startFlow({ platform, deviceId, name }) {
  if (active) {
    throw new Error(`A flow ("${active.name}") is already running. Finish or cancel it first.`);
  }
  active = {
    name: name?.trim() || `Flow ${new Date().toLocaleString()}`,
    platform,
    deviceId,
    startedAt: new Date().toISOString(),
    steps: [],
    merged: new Map(), // findingKey -> { finding, seenInSteps: [] }
    device: null,
    provider: null,
    warnings: [],
  };
  return flowStatus();
}

export function cancelFlow() {
  const was = active?.name ?? null;
  active = null;
  return { cancelled: true, name: was };
}

/**
 * Scan the CURRENT screen as the next step of the active flow.
 * The scan itself is exactly a single-screen scanMobile() — same measured tier,
 * same AI tier, same evidence verification. The flow layer only adds identity.
 */
export async function flowStep({ ai, aiReview = true, label } = {}) {
  if (!active) throw new Error("No flow is running. Start one first.");

  const result = await scanMobile({
    platform: active.platform,
    deviceId: active.deviceId,
    ai,
    aiReview,
  });

  const index = active.steps.length + 1;
  let newFindings = 0;

  for (const f of result.findings) {
    const key = findingKey(f);
    const existing = active.merged.get(key);
    if (existing) {
      if (!existing.seenInSteps.includes(index)) existing.seenInSteps.push(index);
      // An element count can grow between screens (more unlabeled buttons of the
      // same kind) — keep the worst observation.
      if ((f.elements ?? 0) > (existing.finding.elements ?? 0)) existing.finding = f;
    } else {
      active.merged.set(key, { finding: f, seenInSteps: [index] });
      newFindings++;
    }
  }

  active.device = result.device ?? active.device;
  active.provider = result.provider ?? active.provider;
  for (const w of result.warnings ?? []) active.warnings.push({ ...w, step: index });

  active.steps.push({
    index,
    label: label?.trim() || result.app?.package || `Step ${index}`,
    app: result.app,
    timestamp: result.timestamp,
    screenshot: result.screenshot,
    counts: result.counts,
    treeAvailable: result.treeAvailable,
    treeWarning: result.treeWarning,
    newFindings,
    stats: result.stats,
  });

  return { step: stepSummary(active.steps[active.steps.length - 1]), status: flowStatus() };
}

/**
 * Finish the flow and return ONE combined result in the same shape as a single
 * scan — so the UI, the session store, and the HTML report all handle it with
 * the same code — plus `steps` and per-finding `seenInSteps`.
 */
export function stopFlow() {
  if (!active) throw new Error("No flow is running.");
  if (!active.steps.length) {
    active = null;
    throw new Error("The flow had no steps — nothing to report. Flow discarded.");
  }

  const findings = [...active.merged.values()]
    .map(({ finding, seenInSteps }) => ({ ...finding, seenInSteps: [...seenInSteps].sort((a, b) => a - b) }))
    .sort((a, b) => impactRank(a.impact) - impactRank(b.impact));

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) counts[f.impact]++;

  const fromMeasured = findings.filter((f) => f.measured).length;
  const fromAi = findings.length - fromMeasured;
  const unverified = findings.filter((f) => f.evidenceStatus === "unverified").length;
  const totalRaw = active.steps.reduce(
    (n, s) => n + s.counts.critical + s.counts.serious + s.counts.moderate + s.counts.minor, 0);

  const result = {
    flow: true,
    name: active.name,
    platform: active.platform,
    deviceId: active.deviceId,
    device: active.device,
    app: active.steps[0].app,
    timestamp: new Date().toISOString(),
    startedAt: active.startedAt,
    screenshot: active.steps[0].screenshot,
    steps: active.steps.map((s) => ({ ...s })), // screenshots included, for the report
    findings,
    passes: [],
    counts,
    warnings: active.warnings,
    treeAvailable: active.steps.some((s) => s.treeAvailable),
    treeWarning: active.steps.find((s) => s.treeWarning)?.treeWarning ?? null,
    provider: active.provider,
    stats: {
      fromMeasured,
      fromAi,
      verified: findings.length - unverified,
      unverified,
      stepsScanned: active.steps.length,
      rawFindings: totalRaw,
      deduplicated: totalRaw - findings.length,
    },
  };

  active = null;
  return result;
}

function impactRank(i) {
  return { critical: 0, serious: 1, moderate: 2, minor: 3 }[i] ?? 4;
}
