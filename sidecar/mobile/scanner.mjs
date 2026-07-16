// A11y Lens — Mobile scanner.
//
// Deliberately mirrors the web engine's SHAPE without sharing its code:
//
//   measured tier  — deterministic rules against the platform accessibility tree
//   AI tier        — a vision model reviews the screenshot + hierarchy for what
//                    measurement cannot judge, and must cite verbatim evidence
//                    from the tree, which we then verify
//
// What it does NOT do is pretend to be the web scanner. There is no axe-core, no
// DOM, no CSS selector, no crawler. Those concepts do not exist on a native app,
// and a finding phrased in their terms would be nonsense.
import { aiStructured, aiChat } from "../ai.mjs";
import { parseAiJson } from "../json-repair.mjs";
import { estimateCost } from "../cost.mjs";
import {
  androidHierarchy, androidScreenshot, androidDeviceInfo, androidForegroundApp,
  iosHierarchy, iosScreenshot, iosDeviceInfo, ToolMissingError,
} from "./device.mjs";
import { parseAndroidHierarchy, parseIosHierarchy, runMobileRules, hierarchyToText, TARGET_MIN } from "./rules.mjs";

const MOBILE_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          impact: { type: "string", enum: ["critical", "serious", "moderate", "minor"] },
          explanation: { type: "string" },
          userImpact: { type: "string" },
          fix: { type: "string", description: "Concrete platform code, not a WCAG paraphrase." },
          evidence: { type: "string", description: "VERBATIM text copied from the supplied accessibility tree." },
          wcag: { type: "array", items: { type: "string" } },
        },
        required: ["title", "impact", "explanation", "userImpact", "fix", "evidence", "wcag"],
      },
    },
    passes: { type: "array", items: { type: "string" } },
  },
  required: ["findings", "passes"],
};

const normalize = (s) =>
  String(s ?? "").replace(/[\u2018\u2019\u201C\u201D]/g, '"').replace(/\s+/g, " ").toLowerCase().trim();

const GENERIC = new Set([
  "button", "label", "text", "view", "element", "elements", "clickable", "focusable",
  "disabled", "enabled", "true", "false", "name", "none", "null", "frame", "bounds",
  "android", "widget", "layout", "image", "screen", "user", "with", "that", "this",
]);

function distinctiveTokens(s) {
  const out = new Set();
  const str = String(s ?? "");
  for (const m of str.matchAll(/"([^"]{3,})"/g)) out.add(normalize(m[1]));
  for (const m of normalize(str).matchAll(/([a-z0-9_.\-æøå]{5,})/g)) {
    if (!GENERIC.has(m[1])) out.add(m[1]);
  }
  return [...out].filter((t) => t.length >= 4 && !GENERIC.has(t));
}

// Same principle as the web engine: the model is asked for a verbatim quote, and
// we check it actually copied one. A finding we can't trace back to the tree is
// flagged, not silently trusted.
function verifyEvidence(evidence, haystack) {
  const e = normalize(evidence);
  if (!e || e.length < 6) return false;
  if (haystack.includes(e)) return true;
  return distinctiveTokens(evidence).some((t) => haystack.includes(t));
}

function buildPrompt(platform, info, app, treeText, measured) {
  const isAndroid = platform === "android";
  const min = TARGET_MIN[platform];

  return `You are a senior accessibility specialist reviewing a NATIVE ${isAndroid ? "Android" : "iOS"} app screen.

This is a native application. There is no DOM, no HTML, no CSS. Do not refer to web concepts, ARIA attributes, or CSS selectors — they do not exist here. Write fixes in ${isAndroid ? "Android (Kotlin/XML/Compose)" : "iOS (Swift/SwiftUI/UIKit)"} terms.

SCREEN
  Device: ${info.model ?? "unknown"} · ${isAndroid ? "Android" : "iOS"} ${info.release ?? "?"}
  App: ${app ? `${app.package}${app.activity ? ` / ${app.activity}` : ""}` : "unknown"}

ACCESSIBILITY TREE — captured live from the device. This is what ${isAndroid ? "TalkBack" : "VoiceOver"} sees:
${treeText}

ALREADY MEASURED DETERMINISTICALLY — these are in the report already. DO NOT re-report them:
${measured.length ? measured.map((f) => `  - ${f.title}`).join("\n") : "  (none)"}

You have the screenshot too. Where the screenshot and the tree DISAGREE — something that looks like a heading but is announced as plain text, a control that looks selected but exposes no state, a group of items that reads as one blob — that disagreement is the most valuable thing you can report.

REPORT WHAT MEASUREMENT CANNOT JUDGE:
- Whether accessible names are MEANINGFUL, not merely present ("Button", "Image", "More", "Tap here")
- Reading order: does ${isAndroid ? "TalkBack swipe order" : "VoiceOver swipe order"} follow the visual layout?
- Grouping: are related items announced as one unit, or as a stream of disconnected fragments?
- State exposure: selected tabs, expanded sections, toggle on/off, loading — is it announced?
- ${isAndroid ? "Headings: is android:accessibilityHeading set on section titles?" : "Traits: are .header / .selected / .button traits applied correctly?"}
- Information conveyed by colour, icon shape or position alone
- Dynamic Type / font scaling: will this layout survive at 200% text size?
- Custom gestures and controls with no accessible equivalent
- Error messages: are they specific, and are they announced?

EVIDENCE — THE RULE THAT MATTERS
Every finding must quote a VERBATIM line from the accessibility tree above. Copy it character for character. Never paraphrase into the evidence field, never invent an element. If you cannot copy a real line, do not write the finding.

WCAG
Cite WCAG 2.1 Level A/AA criteria only, as applied to native software via WCAG2ICT. Never cite WCAG 2.2 criteria. Touch target size has NO WCAG 2.1 AA criterion — the platform guideline is ${min}${isAndroid ? "dp" : "pt"}, and that has already been measured; do not re-report it.

Also record 1-3 honest passes — things that genuinely work. Skip them if nothing does.`;
}

export async function scanMobile({ platform, deviceId, ai, aiReview = true }) {
  const isAndroid = platform === "android";

  // --- capture -------------------------------------------------------------
  const info = isAndroid ? await androidDeviceInfo(deviceId) : await iosDeviceInfo(deviceId);
  const screenshot = isAndroid ? await androidScreenshot(deviceId) : await iosScreenshot(deviceId);
  const app = isAndroid ? await androidForegroundApp(deviceId).catch(() => null) : null;

  let nodes = [];
  let treeAvailable = true;
  let treeWarning = null;

  try {
    if (isAndroid) {
      nodes = parseAndroidHierarchy(await androidHierarchy(deviceId));
    } else {
      const { tree } = await iosHierarchy(deviceId);
      nodes = parseIosHierarchy(tree);
    }
  } catch (e) {
    if (e instanceof ToolMissingError || e.code === "TOOL_MISSING") {
      // Be explicit rather than quietly producing a weaker scan. Without the
      // element tree we cannot measure labels or target sizes at all — only the
      // AI/visual tier survives, and the user needs to know that.
      treeAvailable = false;
      treeWarning = e.hint ?? e.message;
    } else {
      throw e;
    }
  }

  // --- measured tier -------------------------------------------------------
  const measured = treeAvailable
    ? runMobileRules(nodes, platform, info ?? {})
    : { findings: [], counts: { critical: 0, serious: 0, moderate: 0, minor: 0 }, stats: {} };

  // --- AI tier -------------------------------------------------------------
  let aiFindings = [];
  let passes = [];
  const warnings = [];
  let usage = { inputTokens: 0, outputTokens: 0 };

  if (aiReview && ai?.provider) {
    const treeText = treeAvailable
      ? hierarchyToText(nodes, platform)
      : "  (unavailable — the accessibility tree could not be captured on this setup)";

    const haystack = normalize(treeText);
    const prompt = buildPrompt(platform, info ?? {}, app, treeText, measured.findings);

    try {
      const raw = await aiStructured(ai, {
        system: "You are a senior native-app accessibility specialist. You never invent elements, and you never describe a native app in web terms.",
        user: prompt,
        images: screenshot ? [screenshot] : [],
        schema: MOBILE_SCHEMA,
        maxTokens: 6000,
      });
      usage = raw.__usage ?? usage;

      aiFindings = (raw.findings ?? [])
        .filter((f) => f && f.title)
        .map((f) => ({
          rule: "ai-review",
          impact: ["critical", "serious", "moderate", "minor"].includes(f.impact) ? f.impact : "moderate",
          title: String(f.title).slice(0, 160),
          explanation: String(f.explanation ?? "").slice(0, 900),
          userImpact: String(f.userImpact ?? "").slice(0, 700),
          fix: String(f.fix ?? "").slice(0, 900),
          evidence: String(f.evidence ?? "").slice(0, 600),
          wcag: Array.isArray(f.wcag) ? f.wcag.map(String).slice(0, 4) : [],
          evidenceStatus: verifyEvidence(f.evidence ?? "", haystack) ? "verified" : "unverified",
          source: "ai",
        }));
      passes = (raw.passes ?? []).map(String).slice(0, 5);
    } catch (e) {
      warnings.push({
        stage: "ai",
        message: `AI review failed: ${String(e.message ?? e)}. The measured findings below are unaffected.`,
        detail: e.stack,
      });
    }
  }

  const findings = [
    ...measured.findings.map((f) => ({ ...f, evidenceStatus: "verified", measured: true })),
    ...aiFindings,
  ];

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) counts[f.impact]++;

  const unverified = aiFindings.filter((f) => f.evidenceStatus === "unverified").length;
  if (unverified) {
    warnings.push({
      stage: "evidence",
      message: `${unverified} AI finding${unverified === 1 ? "" : "s"} cite evidence not found in the accessibility tree. Flagged unverified — confirm before acting.`,
      detail: null,
    });
  }

  // No AI call happened either because aiReview was off or no provider was
  // configured — nothing to price, and estimateCost(0,0) against an unknown
  // model would print a confusing "no local price" note for a $0 request.
  const cost = (aiReview && ai?.provider)
    ? estimateCost({ provider: ai.provider, model: ai.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
    : { usd: 0, inputTokens: 0, outputTokens: 0, note: "AI review was not run" };

  return {
    platform,
    deviceId,
    device: info,
    app,
    timestamp: new Date().toISOString(),
    screenshot,
    findings,
    passes,
    counts,
    warnings,
    treeAvailable,
    treeWarning,
    provider: ai?.provider ? `${ai.provider}/${ai.model}` : null,
    usage,
    cost,
    stats: {
      ...measured.stats,
      fromMeasured: measured.findings.length,
      fromAi: aiFindings.length,
      verified: findings.filter((f) => f.evidenceStatus === "verified").length,
      unverified,
    },
  };
}
