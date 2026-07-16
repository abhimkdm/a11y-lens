// A11y Lens — AI generation cost report (mobile).
//
// A SEPARATE document from the findings report (report-html.mjs): this one is
// for the person paying the AI bill, not the person fixing the accessibility
// issues. It answers three questions a manager actually asks after seeing an
// "AI-powered" line item: which model ran, how much context did it consume,
// and what did that cost (or would have cost, on a paid provider).
//
// Works for both a single scan and a finished flow — a flow shows one row per
// step plus a total, a single scan shows one row.
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
const fmtUsd = (usd) => usd === null || usd === undefined ? null : `$${usd.toFixed(4)}`;

function costCell(cost) {
  if (!cost) return "—";
  if (cost.usd === 0) return `<span class="free">$0.00${cost.note?.includes("local") ? " · local model" : ""}</span>`;
  if (cost.usd === null) return `<span class="unknown">unpriced${cost.note ? ` — ${esc(cost.note)}` : ""}</span>`;
  return `<span class="usd">${fmtUsd(cost.usd)}</span>${cost.pricedAs ? ` <span class="muted">(priced as ${esc(cost.pricedAs)})</span>` : ""}`;
}

export function renderMobileAiUsageReportHtml(result) {
  const isFlow = !!result.flow;
  const platformName = result.platform === "android" ? "Android" : "iOS";
  const title = isFlow
    ? `AI usage & cost — ${esc(result.name)} (${platformName} flow)`
    : `AI usage & cost — ${platformName} screen scan`;

  const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const noAiRun = !result.provider || totalTokens === 0;

  const rows = isFlow
    ? (result.steps ?? []).map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(s.label)}</td>
        <td class="num">${fmt(s.usage?.inputTokens)}</td>
        <td class="num">${fmt(s.usage?.outputTokens)}</td>
        <td class="num">${fmt((s.usage?.inputTokens ?? 0) + (s.usage?.outputTokens ?? 0))}</td>
      </tr>`).join("")
    : `
      <tr>
        <td>1</td>
        <td>${esc(result.app?.package ?? result.device?.model ?? "Screen")}</td>
        <td class="num">${fmt(usage.inputTokens)}</td>
        <td class="num">${fmt(usage.outputTokens)}</td>
        <td class="num">${fmt(totalTokens)}</td>
      </tr>`;

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
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; color: #e8eef4; margin: 0 0 4px; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; margin: 28px 0 10px; color: #9aa7b4; }
  .muted { color: #8a97a4; font-size: 13px; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 10px 0 4px; }
  .chip { display: inline-block; border: 1px solid; border-radius: 999px; padding: 1px 10px;
          font-size: 11.5px; font-weight: 700; white-space: nowrap; border-color: #9aa7b4; color: #9aa7b4; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
  .card { border: 1px solid rgba(154,167,180,.18); border-radius: 12px; padding: 16px; background: #10141a; }
  .card .num { font-size: 26px; font-weight: 700; color: #e8eef4; }
  .card .lbl { font-size: 12px; color: #8a97a4; text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; }
  .card.cost .num { color: #7be8b0; }
  .card.cost.unpriced .num { color: #ffb35c; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(154,167,180,.14); }
  th { color: #8a97a4; font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; color: #e8eef4; border-top: 1px solid rgba(154,167,180,.3); border-bottom: none; }
  .usd { color: #7be8b0; font-weight: 700; }
  .free { color: #7be8b0; font-weight: 700; }
  .unknown { color: #ffb35c; }
  .banner { border: 1px solid rgba(255,179,92,.5); background: rgba(255,179,92,.08); color: #ffd9ad;
            border-radius: 10px; padding: 12px 14px; margin: 14px 0; font-size: 14px; }
  footer { margin-top: 32px; font-size: 12px; color: #6b7885; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <div class="meta">
    <span class="chip">${platformName}</span>
    ${result.device?.model ? `<span class="chip">${esc(result.device.model)}${result.device.release ? ` · ${platformName} ${esc(result.device.release)}` : ""}</span>` : ""}
    ${result.provider ? `<span class="chip">${esc(result.provider)}</span>` : ""}
    <span class="muted">${new Date(result.timestamp).toLocaleString()}</span>
  </div>
  <p class="muted">Token consumption and estimated API cost for the AI review portion of this
  ${isFlow ? `flow ("${esc(result.name)}", ${result.steps?.length ?? 0} steps)` : "scan"}.
  Pricing is a local estimate from published per-model rates and can drift from your actual
  invoice — treat it as directionally accurate, not a bill.</p>

  ${noAiRun ? `<div class="banner"><strong>AI review was not run.</strong> ${esc(result.cost?.note ?? "Only the measured (non-AI) checks executed for this result, so there is no model usage or cost to report.")}</div>` : ""}

  <div class="cards">
    <div class="card"><div class="num">${fmt(usage.inputTokens)}</div><div class="lbl">Input tokens</div></div>
    <div class="card"><div class="num">${fmt(usage.outputTokens)}</div><div class="lbl">Output tokens</div></div>
    <div class="card"><div class="num">${fmt(totalTokens)}</div><div class="lbl">Total tokens</div></div>
    <div class="card cost ${result.cost?.usd === null ? "unpriced" : ""}">
      <div class="num">${result.cost?.usd === null ? "Unpriced" : result.cost?.usd === 0 ? "$0.00" : fmtUsd(result.cost?.usd)}</div>
      <div class="lbl">Estimated cost</div>
    </div>
  </div>

  <h2>Request breakdown</h2>
  <table>
    <thead><tr><th>#</th><th>${isFlow ? "Step" : "Screen"}</th><th class="num">Input</th><th class="num">Output</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td class="num">${fmt(usage.inputTokens)}</td><td class="num">${fmt(usage.outputTokens)}</td><td class="num">${fmt(totalTokens)}</td></tr></tfoot>
  </table>

  <h2>Estimated cost</h2>
  <p>${costCell(result.cost)}</p>

  <footer>Generated by A11y Lens Mobile Scanner · ${new Date().toLocaleString()} ·
  Prices are a local estimate (see sidecar/cost.mjs) using published per-1M-token rates and are
  not pulled from your provider's billing API.</footer>
</main>
</body>
</html>`;
}
