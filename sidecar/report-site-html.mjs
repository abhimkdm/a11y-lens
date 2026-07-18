// A11y Lens — multi-page HTML report writer.
//
// Emits a small static site rather than one giant file:
//
//   index.html              hub: totals, links to every page report
//   executive-summary.html  overall risk, systemic themes, next steps
//   site-wide.html          chrome issues, reported ONCE with "affects N pages"
//   <page-slug>.html        page-specific findings, grouped and filterable
//
// Findings carry a stable id (AL-XXXXXXXX) so they can go straight into a ticket
// and still mean the same thing on the next run, and each one can expand to show
// the actual screenshot of the failing element.

const CSS = `
:root{
  --bg:#faf9f6; --panel:#fff; --panel2:#f7f6f3; --text:#1a1a1a; --muted:#5f5e5a; --faint:#888780;
  --line:rgba(0,0,0,.1); --line2:rgba(0,0,0,.2);
  --critical:#B91C1C; --serious:#E24B4A; --moderate:#EF9F27; --minor:#888780; --pass:#1B806A;
  --mono:"SF Mono",Monaco,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#1a1917; --panel:#1f1e1c; --panel2:#2a2927; --text:#f1efe8; --muted:#b4b2a9; --faint:#888780;
         --line:rgba(255,255,255,.12); --line2:rgba(255,255,255,.22);
         --critical:#F87171; --serious:#FB923C; --moderate:#FBBF24; --minor:#9CA3AF; --pass:#5EEAD4; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-size:16px;line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:1000px;margin:0 auto;padding:2rem 1.5rem 4rem}
h1{font-size:22px;font-weight:600;margin:0 0 4px}
.sub{font-size:14px;color:var(--muted);margin:0}
a{color:var(--text)}
.back{font-size:13px;margin:0 0 12px}
.back a{color:var(--muted);text-decoration:none}
.back a:hover{color:var(--text)}
.stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:1.25rem 0}
.stat-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.stat-card strong{display:block;font-size:1.5rem;line-height:1.1;font-weight:600;font-variant-numeric:tabular-nums}
.stat-card span{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:1rem 0}
.toolbar input,.toolbar select{background:var(--panel);border:1px solid var(--line2);border-radius:8px;
  color:var(--text);padding:7px 10px;font-size:13px;font-family:inherit}
.toolbar input{flex:1;min-width:200px}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pill{background:var(--panel);border:1px solid var(--line2);border-radius:999px;padding:5px 12px;
  font-size:12.5px;font-weight:600;cursor:pointer;color:var(--muted)}
.pill.on{color:var(--text);border-color:var(--text)}
.zone-header{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
  color:var(--faint);margin:22px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}
.card-top{display:flex;gap:10px;align-items:center;padding:13px 16px;cursor:pointer}
.id{font-family:var(--mono);font-size:11px;color:var(--faint);flex-shrink:0}
.title{font-weight:600;flex:1;min-width:0}
.prio{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
  border-radius:999px;padding:2px 9px;border:1px solid;flex-shrink:0}
.prio-critical{color:var(--critical);border-color:var(--critical)}
.prio-serious{color:var(--serious);border-color:var(--serious)}
.prio-moderate{color:var(--moderate);border-color:var(--moderate)}
.prio-minor{color:var(--minor);border-color:var(--minor)}
.tag{font-size:11px;color:var(--faint);border:1px solid var(--line);border-radius:5px;padding:2px 7px;flex-shrink:0}
.card-body{display:none;padding:0 16px 16px;border-top:1px solid var(--line)}
.card.open .card-body{display:block}
.card.open .chev{transform:rotate(180deg)}
.chev{color:var(--faint);transition:transform .15s;flex-shrink:0}
.dl dt{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);margin-top:14px}
.dl dd{margin:4px 0 0}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:10px;overflow:auto;
  font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.ev{display:block;font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--line);
  border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;color:var(--faint)}
pre.code{border-left:3px solid var(--serious)}
.shot{margin-top:8px}
.shot summary{cursor:pointer;font-size:12.5px;color:var(--muted);padding:4px 0}
.shot img{max-width:100%;border-radius:7px;border:1px solid var(--line);margin-top:6px;display:block}
.pagelist{display:grid;gap:8px;margin-top:10px}
.pagerow{display:flex;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);
  border-radius:10px;padding:13px 16px;text-decoration:none;color:var(--text)}
.pagerow:hover{border-color:var(--line2)}
.pagerow .t{flex:1;min-width:0}
.pagerow .t b{display:block;font-weight:600}
.pagerow .t span{font-size:12.5px;color:var(--muted)}
.dot{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;min-width:26px;text-align:right}
.theme{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:8px}
.theme b{display:block;margin-bottom:4px}
.theme p{margin:0;color:var(--muted);font-size:14px}
ol.steps{padding-left:20px}
ol.steps li{margin-bottom:8px}
.empty{color:var(--muted);padding:20px 0}
.affects{font-size:12px;color:var(--muted)}
`;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

const shell = (title, sub, body, back = true) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — A11y Lens</title><style>${CSS}</style></head>
<body><div class="page">
${back ? '<p class="back"><a href="index.html">&larr; All pages</a></p>' : ""}
<div class="page-header"><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div>
${body}
</div></body></html>`;

const statCards = (counts, extra = []) => `
<div class="stat-cards">
  ${extra.map((e) => `<div class="stat-card"><strong>${e.value}</strong><span>${esc(e.label)}</span></div>`).join("")}
  <div class="stat-card"><strong style="color:var(--critical)">${counts.critical}</strong><span>Critical</span></div>
  <div class="stat-card"><strong style="color:var(--serious)">${counts.serious}</strong><span>Serious</span></div>
  <div class="stat-card"><strong style="color:var(--moderate)">${counts.moderate}</strong><span>Moderate</span></div>
  <div class="stat-card"><strong style="color:var(--minor)">${counts.minor}</strong><span>Minor</span></div>
</div>`;

function findingCard(f) {
  const wcag = (f.wcag ?? []).join(", ");
  const affects =
    f.scope === "site-wide"
      ? `<span class="affects">Affects ${f.affectedPages.length} page${f.affectedPages.length === 1 ? "" : "s"}</span>`
      : "";

  const shots = (f.nodes ?? [])
    .map((n) => {
      const img = n.screenshot
        ? `<details class="shot"><summary>Show visual evidence</summary>
             <img src="data:image/jpeg;base64,${n.screenshot}" alt="Screenshot of the failing element, outlined on the page">
           </details>`
        : "";
      return `<div>
        <div class="affects" style="font-family:var(--mono);font-size:11.5px">${esc(n.target)}</div>
        <pre>${esc(n.html)}</pre>
        ${img}
      </div>`;
    })
    .join("");

  return `<div class="card" data-sev="${f.impact}" data-text="${esc((f.title + " " + f.rule + " " + wcag).toLowerCase())}">
    <div class="card-top" onclick="this.parentNode.classList.toggle('open')">
      <span class="id">${f.id}</span>
      <span class="prio prio-${f.impact}">${f.impact}</span>
      <span class="title">${esc(f.title)}</span>
      <span class="tag">${esc(f.rule)}</span>
      ${wcag ? `<span class="tag">WCAG ${esc(wcag)}</span>` : ""}
      <span class="tag">${f.occurrences}&times;</span>
      <span class="chev">&#9662;</span>
    </div>
    <div class="card-body">
      <dl class="dl">
        <dt>Description</dt><dd>${esc(f.description)}</dd>
        ${affects ? `<dt>Scope</dt><dd>${affects}</dd>` : ""}
        ${f.evidence ? `<dt>Evidence</dt><dd><code class="ev">${esc(String(f.evidence).slice(0, 500))}</code></dd>` : ""}
        ${f.recommendation ? `<dt>Recommendation</dt><dd>${esc(f.recommendation)}</dd>` : ""}
        ${f.codeExample ? `<dt>Code example</dt><dd><pre class="code">${esc(f.codeExample)}</pre></dd>` : ""}
        <dt>Failing elements (${f.occurrences} total, showing ${(f.nodes ?? []).length})</dt>
        <dd>${shots || "<em>No element detail captured.</em>"}</dd>
        ${f.helpUrl ? `<dt>Reference</dt><dd><a href="${esc(f.helpUrl)}" target="_blank" rel="noreferrer">Rule documentation</a></dd>` : ""}
      </dl>
    </div>
  </div>`;
}

const FILTER_JS = `
<script>
(function(){
  var q="", sev="all";
  function apply(){
    document.querySelectorAll(".card").forEach(function(c){
      var okSev = sev==="all" || c.dataset.sev===sev;
      var okQ = !q || c.dataset.text.indexOf(q)>-1;
      c.style.display = (okSev && okQ) ? "" : "none";
    });
    document.querySelectorAll("[data-zone]").forEach(function(z){
      var any = [].slice.call(z.querySelectorAll(".card")).some(function(c){return c.style.display!=="none"});
      z.style.display = any ? "" : "none";
    });
  }
  var s=document.getElementById("q");
  if(s) s.oninput=function(e){ q=e.target.value.toLowerCase(); apply(); };
  document.querySelectorAll(".pill").forEach(function(p){
    p.onclick=function(){
      document.querySelectorAll(".pill").forEach(function(x){x.classList.remove("on")});
      p.classList.add("on"); sev=p.dataset.sev; apply();
    };
  });
})();
</script>`;

// The pills filter finding CARDS, so they must count cards. Showing occurrence
// counts here (e.g. "Serious 14" next to "All 2") is just confusing.
const findingCounts = (findings) => {
  const c = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) c[f.impact]++;
  return c;
};

const toolbar = (counts, total) => `
<div class="toolbar">
  <input id="q" type="search" placeholder="Search findings, rules, WCAG criteria…" aria-label="Search findings">
  <div class="pills">
    <button class="pill on" data-sev="all">All ${total}</button>
    <button class="pill" data-sev="critical">Critical ${counts.critical}</button>
    <button class="pill" data-sev="serious">Serious ${counts.serious}</button>
    <button class="pill" data-sev="moderate">Moderate ${counts.moderate}</button>
    <button class="pill" data-sev="minor">Minor ${counts.minor}</button>
  </div>
</div>`;

export function buildSiteReport(dedup, summary, meta) {
  const files = {};
  const when = new Date(meta.generatedAt ?? Date.now()).toISOString();
  const sub = `${dedup.stats.pages} pages · ${dedup.stats.totalOccurrences} findings · Generated ${when}`;

  // --- index -------------------------------------------------------------
  const pageRows = dedup.byPage
    .slice()
    .sort((a, b) => a.score - b.score)
    .map(
      (p) => `<a class="pagerow" href="${p.slug}.html">
        <span class="t"><b>${esc(p.title)}</b>
          <span>${p.findings.length} finding${p.findings.length === 1 ? "" : "s"} · score ${p.score}/100</span></span>
        <span class="dot" style="color:var(--critical)">${p.counts.critical}</span>
        <span class="dot" style="color:var(--serious)">${p.counts.serious}</span>
        <span class="dot" style="color:var(--moderate)">${p.counts.moderate}</span>
      </a>`
    )
    .join("");

  files["index.html"] = shell(
    "AI powered accessibility findings",
    sub,
    `
${statCards(dedup.totals, [{ value: dedup.stats.totalOccurrences, label: "Findings" }])}
<div class="pagelist">
  <a class="pagerow" href="executive-summary.html">
    <span class="t"><b>Executive summary</b><span>Overall risk, systemic themes, and where to start</span></span>
  </a>
  <a class="pagerow" href="site-wide.html">
    <span class="t"><b>Site-wide chrome &amp; shared issues</b>
      <span>${dedup.stats.siteWideFindings} findings · reported once instead of ${dedup.stats.duplicatesCollapsed + dedup.stats.siteWideFindings} times</span></span>
  </a>
</div>
<div class="zone-header">Pages</div>
<div class="pagelist">${pageRows}</div>`,
    false
  );

  // --- executive summary --------------------------------------------------
  const s = summary ?? null;
  files["executive-summary.html"] = shell(
    "Executive summary",
    sub,
    s
      ? `
${statCards(dedup.totals, [{ value: dedup.stats.totalOccurrences, label: "Findings" }])}
<div class="zone-header">Overall assessment</div>
<p>${esc(s.overallAssessment)}</p>
${s.themes?.length ? `<div class="zone-header">Priority themes</div>
  ${s.themes.map((t) => `<div class="theme"><b>${esc(t.title)}</b><p>${esc(t.detail)}</p></div>`).join("")}` : ""}
${s.highestImpactPages?.length ? `<div class="zone-header">Highest-impact pages</div>
  ${s.highestImpactPages.map((p) => `<div class="theme"><b>${esc(p.page)}</b><p>${esc(p.why)}</p></div>`).join("")}` : ""}
${s.nextSteps?.length ? `<div class="zone-header">Recommended next steps</div>
  <ol class="steps">${s.nextSteps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
<p class="sub" style="margin-top:24px">Generated by ${esc(s.provider)}</p>`
      : `<p class="empty">No executive summary was generated. Configure an AI provider in Settings and re-run the report.</p>`
  );

  // --- site-wide ----------------------------------------------------------
  const swCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of dedup.siteWide) swCounts[f.impact] += f.occurrences;

  files["site-wide.html"] = shell(
    "Site-wide",
    `${dedup.stats.siteWideFindings} shared findings across ${dedup.stats.pages} pages · Generated ${when}`,
    `
<p class="sub" style="margin-bottom:8px">These fail on most pages — header, footer, navigation and other shared chrome.
Fixing one of these resolves it everywhere, which is why they are listed first and separately.
Reporting them per-page would have produced ${dedup.stats.duplicatesCollapsed} duplicate rows.</p>
${statCards(swCounts, [{ value: dedup.siteWide.length, label: "Findings" }])}
${toolbar(findingCounts(dedup.siteWide), dedup.siteWide.length)}
<div data-zone="site-wide">
  ${dedup.siteWide.map(findingCard).join("") || '<p class="empty">No site-wide issues found.</p>'}
</div>
${FILTER_JS}`
  );

  // --- per page -----------------------------------------------------------
  for (const p of dedup.byPage) {
    files[`${p.slug}.html`] = shell(
      p.title,
      `${p.findings.length} page-specific findings · score ${p.score}/100 · ${esc(p.url)}`,
      `
${statCards(p.counts, [{ value: p.findings.length, label: "Findings" }])}
<p class="sub">Site-wide chrome issues are reported on the
  <a href="site-wide.html">Site-wide page</a> and are not repeated here.</p>
${toolbar(findingCounts(p.findings), p.findings.length)}
<div data-zone="page">
  ${p.findings.map(findingCard).join("") || '<p class="empty">No page-specific findings. Check the Site-wide page for shared issues.</p>'}
</div>
${FILTER_JS}`
    );
  }

  return files;
}
