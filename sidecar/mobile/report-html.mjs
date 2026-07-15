// A11y Lens — Mobile HTML report.
//
// One self-contained .html file a tester can attach to an email or a ticket:
// no external assets, screenshots embedded as base64, opens in any browser.
// Handles BOTH shapes: a single-screen scan and a finished flow (which adds
// `steps` and per-finding `seenInSteps`).
//
// The trust chips carry over from the UI on purpose — a stakeholder reading
// this needs to know which findings are measured facts and which are AI
// judgements, and whether the AI's evidence was actually found in the tree.

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const IMPACT = ["critical", "serious", "moderate", "minor"];
const IMPACT_COLOR = { critical: "#ff5c6c", serious: "#ff9b4a", moderate: "#e6c04a", minor: "#5aa9ff" };

function chip(text, color, outline = true) {
  return `<span class="chip" style="border-color:${color};color:${color};${outline ? "" : `background:${color};color:#0b0e12;`}">${esc(text)}</span>`;
}

function findingHtml(f, isFlow) {
  const trust = f.measured
    ? chip("measured", "#7be8b0")
    : f.evidenceStatus === "verified"
      ? chip("evidence verified", "#7be8b0")
      : chip("unverified — confirm manually", "#ffb35c");

  const seen = isFlow && f.seenInSteps?.length
    ? `<span class="seen">seen in step${f.seenInSteps.length === 1 ? "" : "s"} ${f.seenInSteps.join(", ")}</span>`
    : "";

  return `
  <details class="finding" ${f.impact === "critical" ? "open" : ""}>
    <summary>
      ${chip(f.impact, IMPACT_COLOR[f.impact] ?? "#9aa7b4", false)}
      ${trust}
      <span class="ftitle">${esc(f.title)}</span>
      <span class="wcag">${esc((f.wcag ?? []).join(", ") || f.guideline || "")}</span>
      ${seen}
    </summary>
    <div class="fbody">
      <p>${esc(f.explanation)}</p>
      ${f.userImpact ? `<h4>User impact</h4><p>${esc(f.userImpact)}</p>` : ""}
      <h4>Evidence — from the platform accessibility tree</h4>
      <pre>${esc(f.evidence)}</pre>
      <h4>Fix</h4>
      <pre class="fix">${esc(f.fix)}</pre>
    </div>
  </details>`;
}

export function renderMobileReportHtml(result) {
  const isFlow = !!result.flow;
  const platformName = result.platform === "android" ? "Android" : "iOS";
  const title = isFlow
    ? `${esc(result.name)} — ${platformName} flow report`
    : `${platformName} screen report — ${esc(result.app?.package ?? result.device?.model ?? "device")}`;

  const total = IMPACT.reduce((n, l) => n + (result.counts?.[l] ?? 0), 0);
  const summaryChips = IMPACT
    .filter((l) => (result.counts?.[l] ?? 0) > 0)
    .map((l) => chip(`${result.counts[l]} ${l}`, IMPACT_COLOR[l]))
    .join(" ");

  const grouped = IMPACT
    .map((level) => {
      const list = (result.findings ?? []).filter((f) => f.impact === level);
      if (!list.length) return "";
      return `<h2 style="color:${IMPACT_COLOR[level]}">${level[0].toUpperCase() + level.slice(1)} (${list.length})</h2>
              ${list.map((f) => findingHtml(f, isFlow)).join("\n")}`;
    })
    .join("\n");

  const stepsHtml = isFlow
    ? `
    <h2>Journey — ${result.steps.length} step${result.steps.length === 1 ? "" : "s"}</h2>
    <p class="muted">${result.stats?.rawFindings ?? "?"} raw findings across all steps de-duplicated down to
      ${total} unique issue${total === 1 ? "" : "s"} — an issue on a shared component (tab bar, header)
      is counted once and tagged with every step it appears on.</p>
    <div class="steps">
      ${result.steps.map((s) => `
      <div class="step">
        <div class="stephead">
          <strong>${s.index}. ${esc(s.label)}</strong>
          <span class="muted">${esc(s.app?.package ?? "")} · ${new Date(s.timestamp).toLocaleTimeString()}</span>
          <span class="muted">${IMPACT.map((l) => s.counts[l] ? `${s.counts[l]} ${l[0].toUpperCase()}` : "").filter(Boolean).join(" · ") || "clean"} · ${s.newFindings} new</span>
          ${s.treeAvailable ? "" : chip("tree unavailable — measured checks skipped", "#ffb35c")}
        </div>
        ${s.screenshot ? `<img alt="Screenshot of step ${s.index}: ${esc(s.label)}" src="data:image/png;base64,${s.screenshot}">` : ""}
      </div>`).join("\n")}
    </div>`
    : (result.screenshot
        ? `<h2>Screen</h2><img class="single" alt="Screenshot of the scanned screen" src="data:image/png;base64,${result.screenshot}">`
        : "");

  const treeBanner = result.treeAvailable === false
    ? `<div class="banner warn"><strong>The accessibility tree could not be captured.</strong>
       Only the visual AI review ran — label and touch-target measurements were skipped.
       ${esc(result.treeWarning ?? "")}</div>`
    : "";

  const unverifiedBanner = (result.stats?.unverified ?? 0) > 0
    ? `<div class="banner warn">${result.stats.unverified} AI finding${result.stats.unverified === 1 ? "" : "s"} cite
       evidence that was <strong>not found</strong> in the captured accessibility tree. They are marked
       "unverified" below — confirm them manually before acting.</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px 20px 64px; background: #0b0e12; color: #c8d3de;
         font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 22px; color: #e8eef4; margin: 0 0 4px; }
  h2 { font-size: 15px; letter-spacing: .08em; text-transform: uppercase; margin: 32px 0 12px; color: #9aa7b4; }
  h4 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #9aa7b4; margin: 14px 0 4px; }
  p { margin: 6px 0; }
  .muted { color: #8a97a4; font-size: 13px; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 10px 0 4px; }
  .chip { display: inline-block; border: 1px solid; border-radius: 999px; padding: 1px 10px;
          font-size: 11.5px; font-weight: 700; white-space: nowrap; }
  .banner { border: 1px solid; border-radius: 10px; padding: 12px 14px; margin: 14px 0; font-size: 14px; }
  .banner.warn { border-color: rgba(255,179,92,.5); background: rgba(255,179,92,.08); color: #ffd9ad; }
  .finding { border: 1px solid rgba(154,167,180,.18); border-radius: 10px; margin: 8px 0; background: #10141a; }
  .finding summary { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; cursor: pointer;
                     padding: 10px 14px; list-style: none; }
  .finding summary::-webkit-details-marker { display: none; }
  .ftitle { font-weight: 600; color: #e8eef4; flex: 1; min-width: 200px; }
  .wcag, .seen { font-size: 12px; color: #8a97a4; white-space: nowrap; }
  .fbody { padding: 0 14px 14px; border-top: 1px solid rgba(154,167,180,.12); }
  pre { background: #0e1116; border: 1px solid rgba(154,167,180,.15); border-radius: 8px;
        padding: 10px 12px; font: 12.5px/1.5 "SF Mono", Consolas, monospace;
        white-space: pre-wrap; word-break: break-word; margin: 4px 0 10px; }
  pre.fix { border-color: rgba(123,232,176,.3); }
  .steps { display: grid; gap: 16px; }
  .step { border: 1px solid rgba(154,167,180,.18); border-radius: 10px; padding: 12px 14px; background: #10141a; }
  .stephead { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; margin-bottom: 8px; }
  img { max-width: 280px; border-radius: 8px; border: 1px solid rgba(154,167,180,.25); display: block; }
  img.single { margin-top: 8px; }
  .pass { color: #7be8b0; }
  footer { margin-top: 40px; font-size: 12px; color: #6b7885; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <div class="meta">
    ${chip(platformName, "#7be8b0")}
    ${result.device?.model ? chip(`${esc(result.device.model)}${result.device.release ? ` · ${platformName} ${esc(result.device.release)}` : ""}`, "#9aa7b4") : ""}
    ${result.app?.package ? chip(esc(result.app.package), "#9aa7b4") : ""}
    ${result.provider ? chip(`AI: ${esc(result.provider)}`, "#9aa7b4") : ""}
    <span class="muted">${new Date(result.timestamp).toLocaleString()}</span>
  </div>
  <p class="muted">Native ${platformName} accessibility scan — measured from the platform's own accessibility
  tree (what ${result.platform === "android" ? "TalkBack" : "VoiceOver"} sees), mapped to WCAG 2.1 A/AA via WCAG2ICT.
  ${result.stats?.fromMeasured ?? 0} measured finding${(result.stats?.fromMeasured ?? 0) === 1 ? "" : "s"},
  ${result.stats?.fromAi ?? 0} from AI review.</p>

  <div class="meta">${summaryChips || chip("no issues found", "#7be8b0")}</div>
  ${treeBanner}
  ${unverifiedBanner}

  ${grouped || "<p class='pass'>✓ Nothing failed the measured checks or the AI review on this screen.</p>"}

  ${(result.passes ?? []).length ? `<h2>What works</h2>${result.passes.map((p) => `<p class="pass">✓ ${esc(p)}</p>`).join("")}` : ""}

  ${stepsHtml}

  <footer>Generated by A11y Lens Mobile Scanner · ${new Date().toLocaleString()} ·
  Measured findings are read directly from the platform accessibility tree and cannot be hallucinated.
  AI findings are verified against that tree; anything unverifiable is flagged, not hidden.</footer>
</main>
</body>
</html>`;
}
