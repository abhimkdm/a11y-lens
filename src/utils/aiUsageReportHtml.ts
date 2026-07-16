import type { ScanResult } from "../store/useAppStore";

// Standalone "AI usage & cost" report for a web scan — a SEPARATE document from
// the interactive findings report (reportHtml.ts). Its reader is whoever signs
// off on the AI spend, not the developer fixing issues, so it answers exactly
// three questions: which model ran, how much context it consumed, and what that
// cost. Same visual identity as the findings report so the two read as a set.
//
// Renders a clear "no AI report" / "AI review not run" state rather than
// throwing, so the export button can always be offered.

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const fmt = (n: number | undefined) => Number(n ?? 0).toLocaleString("en-US");
const fmtUsd = (usd: number) => `$${usd.toFixed(4)}`;

export function buildAiUsageReport(s: ScanResult): string {
  const ai = s.aiReport;
  const usage = ai?.usage ?? { inputTokens: 0, outputTokens: 0 };
  const cost = ai?.cost;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const hasAi = !!ai && (totalTokens > 0 || (ai.fixes?.length ?? 0) > 0);
  const noUsage = !ai || totalTokens === 0;

  const provider = ai?.provider ?? "—";
  const scenarios = ai?.evidence?.scenarios ?? (s.pages?.length || 1);
  const imagesUsed = ai?.evidence?.imagesUsed ?? 0;

  const costHeadline =
    !cost ? "—"
      : cost.usd === null ? "Unpriced"
        : cost.usd === 0 ? "$0.00"
          : fmtUsd(cost.usd);

  const costSub =
    !cost ? "No AI report was generated for this scan."
      : cost.usd === null ? (cost.note ?? "This model has no local price — tokens are shown, cost is unknown.")
        : cost.usd === 0 ? (cost.note?.includes("local") ? "Local model — no API cost." : "No billable tokens.")
          : cost.pricedAs ? `Priced using published rates for ${esc(cost.pricedAs)}.` : "Estimated from published per-token rates.";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>A11y Lens — AI Usage & Cost — ${esc(s.title || s.url)}</title>
<style>
:root{--bg:#0E1116;--panel:#161C24;--text:#E9EEF5;--muted:#9AA7B4;
--accent:#8AC7FF;--pass:#7BE8B0;--warn:#FFB35C}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.55 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;padding:32px}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:30px 0 12px}
.muted{color:var(--muted)}
.head{background:var(--panel);border:1px solid #9aa7b422;border-radius:14px;padding:24px;margin-bottom:8px}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
.chip{border:1px solid #9aa7b44d;border-radius:999px;padding:2px 12px;font-size:12px;font-weight:600;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:6px 0}
.card{background:var(--panel);border:1px solid #9aa7b41f;border-radius:12px;padding:18px}
.card .n{font-size:28px;font-weight:700;letter-spacing:-.01em}
.card .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px}
.card.cost .n{color:var(--pass)}
.card.cost.unpriced .n{color:var(--warn);font-size:18px}
.card.cost .sub{font-size:12px;color:var(--muted);margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:6px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #9aa7b422}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tfoot td{font-weight:700;border-top:1px solid #9aa7b44d;border-bottom:none}
.banner{border:1px solid #ffb35c80;background:#ffb35c14;color:#ffd9ad;border-radius:10px;padding:12px 16px;margin:14px 0}
.foot{margin-top:34px;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
<div class="head">
  <h1>AI usage &amp; cost</h1>
  <div class="muted">${esc(s.title || s.url)}</div>
  <div class="meta">
    <span class="chip">${esc(provider)}</span>
    <span class="chip">${scenarios} scenario${scenarios === 1 ? "" : "s"} scanned</span>
    <span class="chip">${imagesUsed} image${imagesUsed === 1 ? "" : "s"} sent</span>
    <span class="muted">${ai?.generatedAt ? new Date(ai.generatedAt).toLocaleString() : new Date(s.timestamp).toLocaleString()}</span>
  </div>
</div>

<p class="muted">Token consumption and estimated API cost for generating the AI accessibility
report on this scan. Pricing is a local estimate from published per-model rates and can drift
from your actual invoice — treat it as directionally accurate, not a bill.</p>

${noUsage && !hasAi ? `<div class="banner"><strong>No AI report was generated for this scan.</strong>
There is no model usage or cost to report. Generate an AI report first, then export this document.</div>` : ""}
${noUsage && hasAi ? `<div class="banner"><strong>Token usage was not reported by the provider.</strong>
An AI report exists, but this provider returned no token counts, so consumption and cost can't be shown.</div>` : ""}

<div class="cards">
  <div class="card"><div class="n">${fmt(usage.inputTokens)}</div><div class="l">Input tokens</div></div>
  <div class="card"><div class="n">${fmt(usage.outputTokens)}</div><div class="l">Output tokens</div></div>
  <div class="card"><div class="n">${fmt(totalTokens)}</div><div class="l">Total tokens</div></div>
  <div class="card cost ${cost?.usd === null ? "unpriced" : ""}">
    <div class="n">${costHeadline}</div><div class="l">Estimated cost</div>
    <div class="sub">${esc(costSub)}</div>
  </div>
</div>

<h2>Breakdown</h2>
<table>
  <thead><tr><th>Item</th><th class="num">Input</th><th class="num">Output</th><th class="num">Total</th></tr></thead>
  <tbody>
    <tr><td>AI report generation${scenarios > 1 ? ` (${scenarios} scenarios, one request)` : ""}</td>
      <td class="num">${fmt(usage.inputTokens)}</td>
      <td class="num">${fmt(usage.outputTokens)}</td>
      <td class="num">${fmt(totalTokens)}</td></tr>
  </tbody>
  <tfoot><tr><td>Total</td><td class="num">${fmt(usage.inputTokens)}</td>
    <td class="num">${fmt(usage.outputTokens)}</td><td class="num">${fmt(totalTokens)}</td></tr></tfoot>
</table>

<h2>What this covers</h2>
<p class="muted">This figure is for the AI <em>report generation</em> pass only — the automated
axe-core scan, the keyboard/focus probes, and the measured checks run locally and cost nothing.
A single AI report is one request even when it reasons over ${scenarios} scanned
scenario${scenarios === 1 ? "" : "s"}, so cost scales with page complexity and screenshot count,
not linearly with pages.</p>

<div class="foot">Generated by A11y Lens · ${new Date().toLocaleString()} ·
Prices are a local estimate using published per-1M-token rates, not pulled from your provider's
billing API. Model rates change; verify against your provider's current pricing for budgeting.</div>
</div></body></html>`;
}
