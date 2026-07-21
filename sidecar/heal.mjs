// Self-healing selectors.
//
// When every recorded selector for a step is dead, the step is NOT necessarily
// impossible — the control is usually still on the page, just re-wrapped,
// re-classed or moved. This module finds it again.
//
// Two stages, cheap first:
//
//   1. LOCAL fingerprint match (free, ~20ms). Every interactive element on the
//      page is scored against the recorded fingerprint — role, accessible name,
//      text, tag, section heading, sibling labels, position. This resolves the
//      large majority of breakages without a single token.
//   2. AI healing, ONLY if the best local score is below the confidence floor.
//      The model gets the fingerprint plus a compact list of candidates and picks
//      one. Gating on confidence is what keeps healing affordable: AI never runs
//      on a page that healed itself.
//
// Nothing here mutates the page. It returns a selector for the caller to use.

import { aiStructured } from "./ai.mjs";

export const CONFIDENCE_FLOOR = 70;   // below this, ask a model

// Pull every plausible interactive candidate, with the same shape as a recorded
// fingerprint so the two can be compared field by field.
const COLLECT = `(() => {
  function clean(s){ return (s||'').replace(/\\s+/g,' ').trim(); }
  function nameOf(el){
    var al = el.getAttribute('aria-label'); if(clean(al)) return clean(al);
    var lb = el.getAttribute('aria-labelledby');
    if(lb){ var t=lb.split(/\\s+/).map(function(id){var r=document.getElementById(id);return r?r.textContent:'';}).join(' '); if(clean(t)) return clean(t); }
    if(el.id){ try{ var l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(l&&clean(l.textContent)) return clean(l.textContent);}catch(e){} }
    var w = el.closest ? el.closest('label') : null; if(w&&clean(w.textContent)) return clean(w.textContent);
    var ph = el.getAttribute('placeholder'); if(clean(ph)) return clean(ph);
    return clean(el.textContent).slice(0,60);
  }
  function roleOf(el){
    var r=el.getAttribute('role'); if(r) return r.split(/\\s+/)[0];
    var t=el.tagName.toLowerCase();
    if(t==='a'&&el.hasAttribute('href')) return 'link';
    if(t==='button') return 'button';
    if(t==='select') return 'combobox';
    if(t==='textarea') return 'textbox';
    if(t==='input'){ var ty=(el.getAttribute('type')||'text').toLowerCase();
      if(ty==='checkbox')return 'checkbox'; if(ty==='radio')return 'radio';
      if(ty==='submit'||ty==='button'||ty==='image')return 'button'; return 'textbox'; }
    return '';
  }
  function visible(el){
    var r=el.getBoundingClientRect();
    if(r.width<2||r.height<2) return false;
    var st=getComputedStyle(el);
    return st.visibility!=='hidden' && st.display!=='none' && st.opacity!=='0';
  }
  function cssPath(el){
    var parts=[],node=el;
    while(node&&node.nodeType===1&&node.tagName.toLowerCase()!=='html'&&parts.length<8){
      var sel=node.tagName.toLowerCase();
      var p=node.parentNode;
      if(p&&p.children){var same=[];for(var i=0;i<p.children.length;i++){if(p.children[i].tagName===node.tagName)same.push(p.children[i]);}
        if(same.length>1) sel+=':nth-of-type('+(same.indexOf(node)+1)+')';}
      parts.unshift(sel); node=node.parentNode;
    }
    return parts.join(' > ');
  }
  function axChain(el){
    var out=[], node=el.parentElement, hops=0;
    while(node&&hops<8){ var r=roleOf(node);
      if(r&&r!=='none'&&r!=='presentation'){ var n=nameOf(node); out.unshift(n?r+':'+n.slice(0,32):r); if(out.length>=4)break; }
      node=node.parentElement; hops++; }
    return out;
  }
  function axStates(el){
    var st={};
    if(el.disabled===true||el.getAttribute('aria-disabled')==='true') st.disabled=true;
    var e=el.getAttribute('aria-expanded'); if(e!==null) st.expanded=e==='true';
    var c=el.getAttribute('aria-checked'); if(c!==null) st.checked=c==='true';
    else if(typeof el.checked==='boolean'&&(el.type==='checkbox'||el.type==='radio')) st.checked=el.checked;
    return st;
  }
  var SEL='a,button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio],[onclick],[tabindex]';
  var out=[], seen=0;
  var els=document.querySelectorAll(SEL);
  for(var i=0;i<els.length && out.length<180;i++){
    var el=els[i];
    if(!visible(el)) continue;
    var parent=el.parentElement;
    var sibs=[];
    if(parent){for(var j=0;j<parent.children.length&&sibs.length<6;j++){var c=parent.children[j];
      if(c===el)continue; var n=nameOf(c)||clean(c.textContent); if(n)sibs.push(n.slice(0,40));}}
    var idx=0; if(parent){for(var k=0;k<parent.children.length;k++){if(parent.children[k]===el){idx=k;break;}}}
    var section='';
    var sec=el.closest('section,[role=region],[role=dialog],main,form,nav,header,footer');
    if(sec){var h=sec.querySelector('h1,h2,h3,legend,[role=heading]');
      section=h?clean(h.textContent).slice(0,60):(sec.getAttribute('aria-label')||sec.tagName.toLowerCase());}
    out.push({
      i: out.length,
      tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el),
      text: clean(el.textContent).slice(0,60),
      parentText: parent?clean(parent.textContent).slice(0,90):'',
      section: section, siblings: sibs, index: idx,
      type: el.getAttribute('type')||'', href: el.getAttribute('href')||'',
      testid: el.getAttribute('data-testid')||el.getAttribute('data-ai')||el.getAttribute('data-test')||'',
      ax: { chain: axChain(el), states: axStates(el) },
      css: cssPath(el)
    });
  }
  return out;
})()`;

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function textScore(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.75;
  const aw = new Set(a.split(" ").filter((w) => w.length > 2));
  const bw = new Set(b.split(" ").filter((w) => w.length > 2));
  if (!aw.size || !bw.size) return 0;
  let hit = 0;
  for (const w of aw) if (bw.has(w)) hit++;
  return hit / Math.max(aw.size, bw.size);
}

// Weighted match. The weights encode what actually survives a redesign:
// a control's accessible name and role are far more durable than its position.
export function scoreCandidate(fp, cand) {
  if (!fp) return 0;
  let score = 0, max = 0;
  const add = (w, v) => { max += w; score += w * v; };

  add(30, textScore(fp.name, cand.name));
  add(20, textScore(fp.text, cand.text));
  add(12, fp.role && cand.role ? (fp.role === cand.role ? 1 : 0) : 0);
  add(6,  fp.tag && cand.tag ? (fp.tag === cand.tag ? 1 : 0) : 0);
  add(10, textScore(fp.section, cand.section));
  add(8,  textScore(fp.parentText, cand.parentText));

  // sibling overlap — the neighbourhood a control sits in
  const fs = (fp.siblings || []).map(norm).filter(Boolean);
  const cs = new Set((cand.siblings || []).map(norm).filter(Boolean));
  add(8, fs.length ? fs.filter((x) => cs.has(x)).length / fs.length : 0);

  // Accessibility-tree chain. The a11y tree survives re-wraps and class renames
  // that destroy a CSS path, so a matching ancestor chain is strong evidence this
  // is the same control in the same place in the app's structure.
  const fc = (fp.ax && fp.ax.chain) || [];
  const cc = new Set(((cand.ax && cand.ax.chain) || []).map(norm));
  add(10, fc.length ? fc.map(norm).filter((x) => cc.has(x)).length / fc.length : 0);

  add(3, fp.type && cand.type ? (fp.type === cand.type ? 1 : 0) : 0);
  add(3, fp.href && cand.href ? (norm(fp.href) === norm(cand.href) ? 1 : 0) : 0);
  // position is worth almost nothing on its own — it is the tiebreaker only
  add(2, typeof fp.index === "number" && typeof cand.index === "number"
        ? (fp.index === cand.index ? 1 : Math.max(0, 1 - Math.abs(fp.index - cand.index) / 8)) : 0);

  return max ? Math.round((score / max) * 100) : 0;
}

export function bestLocalMatch(fp, candidates) {
  let best = null;
  for (const c of candidates) {
    const confidence = scoreCandidate(fp, c);
    if (!best || confidence > best.confidence) best = { candidate: c, confidence };
  }
  return best;
}

// Turn a healed candidate into a locator description replay can use. Prefers the
// same durable tiers as the recorder, so a healed step is no more brittle than a
// freshly recorded one.
export function candidateToSelector(c) {
  if (c.testid) return { by: "testid", attr: "data-testid", value: c.testid };
  if (c.role && c.name) return { by: "role", role: c.role, name: c.name };
  if (c.name) return { by: "text", value: c.name };
  if (c.text) return { by: "tagText", tag: c.tag, value: c.text };
  return { by: "css", value: c.css };
}

// Minimal locator builder for a remembered selector (mirrors replay's locatorFor).
function locatorFromSelector(page, sel) {
  if (!sel || !sel.by) return null;
  switch (sel.by) {
    case "testid": return page.locator(`[${sel.attr || "data-testid"}="${String(sel.value).replace(/(["\\])/g, "\\$1")}"]`).first();
    case "role":   return (sel.name ? page.getByRole(sel.role, { name: sel.name }) : page.getByRole(sel.role)).first();
    case "text":   return page.getByText(sel.value, { exact: true }).first();
    case "tagText":return page.locator(sel.tag || "*", { hasText: sel.value }).first();
    default:       return page.locator(sel.value).first();
  }
}

const AI_SCHEMA = {
  type: "object",
  properties: {
    index: { type: "integer" },
    confidence: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["index", "confidence"],
};

// Heal one dead target. Returns { selector, confidence, healedBy, candidate } or null.
export async function healTarget(page, target, {
  ai = null, floor = CONFIDENCE_FLOOR, onLog = () => {}, memory = null, origin = "",
} = {}) {
  const fp = target && target.fingerprint;
  if (!fp) return null;

  // Memory first. If this control was healed before, reuse the mapping — no page
  // scan, no scoring, no model. This is what makes the tool cheaper the longer
  // it is used rather than paying the same diagnosis cost every run.
  if (memory && memory.enabled) {
    const known = memory.recall(origin, fp);
    if (known) {
      try {
        const probe = locatorFromSelector(page, known.selector);
        if (probe && await probe.count() > 0 && await probe.isVisible({ timeout: 500 }).catch(() => false)) {
          memory.confirm(origin, fp);
          onLog(`Reused a remembered fix for "${fp.name || fp.text}" → "${known.now}" (learned ${known.hits}x, no AI).`);
          return { selector: known.selector, confidence: known.confidence, healedBy: "memory",
                   candidate: { name: known.now, text: known.now }, fromMemory: true };
        }
        // Remembered, but the page has moved on again — drop it and re-diagnose.
        memory.forget(origin, fp);
        onLog(`Remembered fix for "${fp.name || fp.text}" no longer resolves — re-healing.`);
      } catch { memory.forget(origin, fp); }
    }
  }

  let candidates = [];
  try { candidates = await page.evaluate(COLLECT); } catch { return null; }
  if (!candidates.length) return null;

  const best = bestLocalMatch(fp, candidates);
  if (best && best.confidence >= floor) {
    onLog(`Healed "${fp.name || fp.text || fp.tag}" locally (confidence ${best.confidence}%) — no AI needed.`);
    memory?.remember?.(origin, fp, {
      selector: candidateToSelector(best.candidate), confidence: best.confidence,
      healedBy: "fingerprint", was: fp.name || fp.text, now: best.candidate.name || best.candidate.text,
    });
    return {
      selector: candidateToSelector(best.candidate),
      confidence: best.confidence,
      healedBy: "fingerprint",
      candidate: best.candidate,
    };
  }

  // Below the floor: this is the only situation that justifies a model call.
  if (!ai || !ai.provider) {
    if (best) onLog(`Best local match for "${fp.name || fp.text}" was only ${best.confidence}% — below the ${floor}% floor, and no AI provider is configured.`);
    return best && best.confidence >= 45
      ? { selector: candidateToSelector(best.candidate), confidence: best.confidence, healedBy: "fingerprint-weak", candidate: best.candidate }
      : null;
  }

  const shortlist = [...candidates]
    .map((c) => ({ c, s: scoreCandidate(fp, c) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 25)
    .map(({ c, s }) => ({ index: c.i, role: c.role, name: c.name, text: c.text, section: c.section, tag: c.tag, localScore: s }));

  onLog(`Local match only ${best ? best.confidence : 0}% — asking the model to identify "${fp.name || fp.text || fp.tag}".`);
  try {
    const data = await aiStructured(ai, {
      system:
        "You repair a broken UI automation step. The recorded element could not be found because the page changed. " +
        "Given the recorded element's fingerprint and a list of interactive elements currently on the page, choose the ONE " +
        "that is the same control. Judge by purpose and label, not position. If none is the same control, return index -1. " +
        "confidence is 0-100: how sure you are it is the SAME control, not merely a similar one.",
      user: JSON.stringify({ recorded: fp, candidates: shortlist }, null, 1),
      schema: AI_SCHEMA,
      maxTokens: 500,
    });
    const idx = Number(data?.index);
    const conf = Math.max(0, Math.min(100, Number(data?.confidence) || 0));
    if (!Number.isInteger(idx) || idx < 0) { onLog("Model found no matching control."); return null; }
    const chosen = candidates.find((c) => c.i === idx);
    if (!chosen) return null;
    onLog(`AI healed "${fp.name || fp.text}" → "${chosen.name || chosen.text}" (confidence ${conf}%).`);
    memory?.remember?.(origin, fp, {
      selector: candidateToSelector(chosen), confidence: conf, healedBy: "ai",
      was: fp.name || fp.text, now: chosen.name || chosen.text,
    });
    return { selector: candidateToSelector(chosen), confidence: conf, healedBy: "ai", candidate: chosen, reason: data?.reason };
  } catch (e) {
    onLog(`AI healing failed: ${String(e.message ?? e).slice(0, 120)}`);
    return null;
  }
}
