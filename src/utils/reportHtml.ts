import type { ScanResult } from "../store/useAppStore";

// Interactive standalone HTML report — filterable by severity, searchable,
// expandable issue cards. Opens in any browser, no dependencies.
export function buildHtmlReport(s: ScanResult): string {
  const data = JSON.stringify({
    url: s.url, title: s.title, timestamp: s.timestamp, score: s.score,
    counts: s.counts, violations: s.violations, aiReport: s.aiReport ?? null,
    expertAudit: s.expertAudit ?? null,
    screenshot: s.screenshot ?? null,
  }).replace(/</g, "\\u003c");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>A11y Lens Report — ${escapeHtml(s.title || s.url)}</title>
<style>
:root{--bg:#0E1116;--panel:#161C24;--text:#E9EEF5;--muted:#9AA7B4;
--critical:#FF7B7B;--serious:#FFB35C;--moderate:#FFD966;--minor:#8AC7FF;--pass:#7BE8B0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.55 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;padding:32px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}
.muted{color:var(--muted)}.wrap{max-width:960px;margin:0 auto}
.head{display:flex;gap:28px;align-items:center;background:var(--panel);
border:1px solid #9aa7b422;border-radius:14px;padding:24px;margin-bottom:20px}
.ring{position:relative;width:120px;height:120px;flex:none}
.ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:30px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}
.filters button{background:#0E1116;color:var(--muted);border:1px solid #9aa7b433;
border-radius:999px;padding:6px 14px;cursor:pointer;font-weight:600}
.filters button.on{color:var(--text);border-color:var(--minor)}
input[type=search]{flex:1;min-width:220px;background:#0E1116;border:1px solid #9aa7b433;
border-radius:999px;color:var(--text);padding:6px 14px}
details{background:var(--panel);border:1px solid #9aa7b41f;border-radius:12px;
margin-bottom:10px;overflow:hidden}
summary{display:flex;gap:12px;align-items:center;padding:14px 18px;cursor:pointer;list-style:none}
summary::-webkit-details-marker{display:none}
.pill{font-size:12px;font-weight:700;text-transform:capitalize;border-radius:999px;
padding:2px 10px;border:1px solid}
.body{padding:0 18px 16px}
pre{background:#0E1116;border:1px solid #9aa7b422;border-radius:8px;padding:10px;
overflow:auto;font:12.5px/1.5 "IBM Plex Mono",monospace;white-space:pre-wrap}
a{color:var(--minor)}
button:focus-visible,summary:focus-visible{outline:2px solid var(--minor);outline-offset:2px}
</style></head><body><div class="wrap">
<div class="head">
  <div class="ring"><svg viewBox="0 0 120 120" width="120" height="120">
    <circle cx="60" cy="60" r="50" fill="none" stroke="#9aa7b426" stroke-width="9"/>
    <circle id="arc" cx="60" cy="60" r="50" fill="none" stroke-width="9" stroke-linecap="round"
      transform="rotate(-90 60 60)"/></svg><b id="scoreNum"></b></div>
  <div><h1 id="t"></h1><div class="muted" id="sub"></div><div class="muted" id="cts"></div></div>
</div>
<div class="filters">
  <input type="search" id="q" placeholder="Search rules, selectors, WCAG…" aria-label="Search issues">
  <button data-f="critical">critical</button><button data-f="serious">serious</button>
  <button data-f="moderate">moderate</button><button data-f="minor">minor</button>
</div>
<div id="shot"></div>
<div id="expert"></div>
<div id="ai"></div>
<div id="list"></div></div>
<script>
const D=${data};const col={critical:"#FF7B7B",serious:"#FFB35C",moderate:"#FFD966",minor:"#8AC7FF"};
document.getElementById("t").textContent=D.title||D.url;
document.getElementById("sub").textContent=D.url+" · "+new Date(D.timestamp).toLocaleString();
document.getElementById("cts").textContent=Object.entries(D.counts).map(([k,v])=>k+" "+v).join("  ·  ");
document.getElementById("scoreNum").textContent=D.score;
const arc=document.getElementById("arc"),c=2*Math.PI*50;
arc.setAttribute("stroke",D.score>=90?"#7BE8B0":D.score>=70?"#FFD966":"#FF7B7B");
arc.setAttribute("stroke-dasharray",c);arc.setAttribute("stroke-dashoffset",c*(1-D.score/100));
if(D.screenshot){
  document.getElementById("shot").innerHTML =
    '<details style="margin-bottom:14px"><summary><strong>Page screenshot</strong>'+
    '<span class="muted" style="margin-left:auto">visual evidence at scan time</span></summary>'+
    '<div class="body"><img src="data:image/jpeg;base64,'+D.screenshot+'" '+
    'alt="Screenshot of the scanned page" style="max-width:100%;border-radius:8px;border:1px solid #9aa7b433"></div></details>';
}
if(D.expertAudit){
  const E=D.expertAudit, x=document.getElementById("expert");
  x.innerHTML='<details open style="margin-bottom:14px"><summary><strong>AI Expert Audit</strong>'+
  '<span class="muted" style="margin-left:auto">'+esc(E.provider)+' · '+E.stats.verified+'/'+E.stats.total+' evidence-verified</span></summary>'+
  '<div class="body"><p class="muted">Findings automated scanners structurally cannot detect. '+
  'Each finding is checked against the captured DOM / accessibility tree / keyboard walk: '+
  '<strong>verified</strong> = the quote was found verbatim; <strong>unverified</strong> = confirm manually.</p>'+
  E.findings.map(f=>'<div style="margin-bottom:14px"><span class="pill" style="color:'+col[f.severity]+';border-color:'+col[f.severity]+'55;background:'+col[f.severity]+'18">'+f.severity+'</span> '+
  '<span class="pill" style="color:'+(f.evidenceStatus==="verified"?"#7BE8B0":"#FFB35C")+';border-color:'+(f.evidenceStatus==="verified"?"#7BE8B0":"#FFB35C")+'55">'+f.evidenceStatus+'</span> '+
  '<strong>'+esc(f.title)+'</strong> <span class="muted">'+esc(f.zone)+' · '+esc((f.wcag||[]).join(", "))+'</span>'+
  '<p>'+esc(f.description)+'</p><p class="muted">Impact: '+esc(f.userImpact)+'</p>'+
  '<pre>EVIDENCE: '+esc(f.evidence)+'</pre><pre>FIX: '+esc(f.fix)+'</pre></div>').join("")+
  (E.passes && E.passes.length ? '<div class="muted">What works</div>'+E.passes.map(p=>'<p>\u2713 <strong>'+esc(p.zone)+':</strong> '+esc(p.message)+'</p>').join("") : "")+
  '</div></details>';
}
if(D.aiReport){
  const a=document.getElementById("ai");
  a.innerHTML='<details open style="margin-bottom:14px"><summary><strong>AI Report</strong>'+
  '<span class="muted" style="margin-left:auto">'+esc(D.aiReport.provider)+'</span></summary>'+
  '<div class="body"><div class="muted">Executive summary</div><p>'+esc(D.aiReport.executiveSummary)+'</p>'+
  '<div class="muted">Business impact</div><p>'+esc(D.aiReport.businessImpact)+'</p>'+
  (D.aiReport.quickWins?.length?'<div class="muted">Quick wins</div><p>'+D.aiReport.quickWins.map(esc).join("<br>")+'</p>':"")+
  '<div class="muted">Developer fixes</div>'+
  D.aiReport.fixes.map(f=>'<div style="margin-bottom:16px"><strong>'+esc(f.title)+'</strong> <span class="muted">('+f.rule+")</span>"+
  (f.evidenceStatus ? ' <span class="pill" style="color:'+(f.evidenceStatus==="verified"?"#7BE8B0":"#FFB35C")+';border-color:'+(f.evidenceStatus==="verified"?"#7BE8B0":"#FFB35C")+'55">'+f.evidenceStatus+'</span>' : '')+
  (f.scenario ? ' <span class="muted">'+esc(f.scenario)+'</span>' : '')+
  '<p>'+esc(f.explanation)+'</p>'+
  (f.evidence ? '<div class="muted">Evidence'+(f.selector?' \u00b7 '+esc(f.selector):'')+'</div><pre>'+esc(f.evidence)+'</pre>' : '')+
  (f.screenshot ? '<details style="margin:6px 0"><summary style="cursor:pointer;font-size:12.5px;color:var(--minor)">Show visual evidence</summary><img src="data:image/jpeg;base64,'+f.screenshot+'" alt="Screenshot of the failing element" style="max-width:100%;border-radius:6px;border:1px solid #9aa7b433;margin-top:6px"></details>' : '')+
  '<pre>HTML:  '+esc(f.html)+'\\n\\nReact: '+esc(f.react)+'\\n\\nAngular: '+esc(f.angular)+'</pre></div>').join("")+
  '</div></details>';
}
const active=new Set();let q="";
function render(){
  const list=document.getElementById("list");list.innerHTML="";
  D.violations.filter(v=>(!active.size||active.has(v.impact))&&
    (!q||JSON.stringify(v).toLowerCase().includes(q))).forEach(v=>{
    const d=document.createElement("details");
    d.innerHTML='<summary><span class="pill" style="color:'+col[v.impact]+';border-color:'+col[v.impact]+'55;background:'+col[v.impact]+'18">'+v.impact+'</span><strong>'+esc(v.help)+'</strong><span class="muted" style="margin-left:auto">'+v.nodes.length+' · '+(v.wcag.join(", ")||"best practice")+'</span></summary>'+
    '<div class="body"><p>'+esc(v.description)+'</p>'+
    v.nodes.map(n=>'<div><div class="muted" style="font-size:12px">'+esc(n.target)+'</div><pre>'+esc(n.html)+'</pre>'+
    '<div class="muted" style="font-size:12px;margin-bottom:6px">'+esc(n.failureSummary||"")+'</div>'+
    (n.screenshot
      ? '<details style="margin:0 0 12px"><summary style="padding:6px 0;font-size:12px;color:var(--minor)">Show visual evidence</summary>'+
        '<img src="data:image/jpeg;base64,'+n.screenshot+'" alt="Screenshot of the failing element, outlined on the page" '+
        'style="max-width:100%;border-radius:6px;border:1px solid #9aa7b433;margin-top:6px">'+
        '<div class="muted" style="font-size:11px;margin-top:4px">The failing element is outlined in its severity colour.</div></details>'
      : '')+
    '</div>').join("")+
    '<a href="'+v.helpUrl+'" target="_blank" rel="noreferrer">Rule documentation</a></div>';
    list.appendChild(d);
  });
  if(!list.children.length)list.innerHTML='<p class="muted">No issues match the current filters.</p>';
}
function esc(s){return String(s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]))}
document.querySelectorAll(".filters button").forEach(b=>b.onclick=()=>{
  const f=b.dataset.f;active.has(f)?active.delete(f):active.add(f);
  b.classList.toggle("on");render();});
document.getElementById("q").oninput=e=>{q=e.target.value.toLowerCase();render()};
render();
</script></body></html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
}
