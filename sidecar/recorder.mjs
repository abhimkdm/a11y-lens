import { templatize } from "./url-template.mjs";

// A11y Lens path recorder (v2 — action capture).
//
// v1 recorded only the ORDERED LIST OF URLs a QA person visited. That is fine
// for a classic multi-page site, but it cannot reproduce a journey on a SPA
// (like the ecare portal) where "add to cart" or "open account" changes the
// view WITHOUT changing the URL. There is nothing to `goto`.
//
// v2 records the ACTIONS themselves — click / fill / select / check / press —
// each with a RANKED SELECTOR CHAIN so replay can find the element again even
// after a redesign. The ranking is deliberate and mirrors Playwright codegen:
//
//     data-testid  ->  role + accessible name  ->  label / placeholder / text
//                  ->  stable #id  ->  scoped CSS path  ->  XPath (last resort)
//
// Two properties fall out of this that matter for an ACCESSIBILITY tool:
//   1. A well-built accessible app is also the most replay-stable one, because
//      `getByRole(name)` just works when roles and names are correct. Selector
//      robustness and accessibility are the SAME property.
//   2. When replay is forced all the way down to the XPath tier, the element
//      had no test id, no role, no accessible name and no usable text — a
//      brittle step AND an accessibility smell. Replay surfaces it as a finding
//      (see replay.mjs) instead of silently limping along.
//
// SECRETS NEVER TOUCH DISK. Password fields, one-time codes, card/CVV/SSN-like
// fields are recorded as { masked: true } with NO value, honouring the app's
// "your credentials never leave the browser" promise. Replay reuses the already
// authenticated session, so masked steps are simply skipped.

// ---------------------------------------------------------------------------
// In-page capture script. Injected via context.addInitScript (runs before page
// scripts on every document) AND evaluated once for the document already open
// when recording starts. It is intentionally dependency-free: plain DOM only.
// It posts each captured step to Node through the exposed __a11yRecordStep
// binding; the Node side ignores everything unless recording is active, so the
// listeners are harmless when idle and survive across SPA navigations.
// ---------------------------------------------------------------------------
export const CAPTURE_SRC = `(() => {
  if (window.__A11Y_REC_INSTALLED) return;
  window.__A11Y_REC_INSTALLED = true;

  // Recorded events: click, change, and Enter/Escape only.
  // NOT recorded: mouseover/mousemove/hover, scroll, focus. They are high-volume,
  // rarely intentional, and replaying them adds fragility without adding coverage.
  var MASK_RE = /pass|passwd|password|otp|cvv|cvc|ccv|card|cardnum|creditcard|ssn|sin|secret|token|pin|securitycode|authcode/i;
  var AUTOCOMPLETE_MASK = { 'current-password':1,'new-password':1,'one-time-code':1,'cc-number':1,'cc-csc':1,'cc-exp':1,'cc-exp-month':1,'cc-exp-year':1 };

  function clean(s){ return (s || '').replace(/\\s+/g,' ').trim().slice(0,120); }
  function attr(el,a){ return (el && el.getAttribute) ? el.getAttribute(a) : null; }

  function accName(el){
    if(!el || el.nodeType!==1) return '';
    var lb = attr(el,'aria-labelledby');
    if(lb){
      var t = lb.split(/\\s+/).map(function(id){ var r=document.getElementById(id); return r?r.textContent:''; }).join(' ');
      if(clean(t)) return clean(t);
    }
    var al = attr(el,'aria-label'); if(clean(al)) return clean(al);
    if(el.id){
      try { var lab = document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(lab && clean(lab.textContent)) return clean(lab.textContent); } catch(e){}
    }
    var wrap = el.closest ? el.closest('label') : null;
    if(wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if(tag==='img'){ var alt=attr(el,'alt'); if(clean(alt)) return clean(alt); }
    if(tag==='input'){
      var ph=attr(el,'placeholder'); if(clean(ph)) return clean(ph);
      var v=attr(el,'value'); var ty=(attr(el,'type')||'').toLowerCase();
      if((ty==='submit'||ty==='button')&&clean(v)) return clean(v);
    }
    var role0 = attr(el,'role');
    if(tag==='button'||tag==='a'||role0==='button'||role0==='link'){ if(clean(el.textContent)) return clean(el.textContent); }
    var title=attr(el,'title'); if(clean(title)) return clean(title);
    if(clean(el.textContent) && clean(el.textContent).length<=60) return clean(el.textContent);
    return '';
  }

  function role(el){
    var r = attr(el,'role'); if(r) return r.split(/\\s+/)[0];
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if(tag==='a' && el.hasAttribute('href')) return 'link';
    if(tag==='button') return 'button';
    if(tag==='select') return 'combobox';
    if(tag==='textarea') return 'textbox';
    if(tag==='input'){
      var t=(attr(el,'type')||'text').toLowerCase();
      if(t==='checkbox') return 'checkbox';
      if(t==='radio') return 'radio';
      if(t==='submit'||t==='button'||t==='image'||t==='reset') return 'button';
      if(t==='search') return 'searchbox';
      return 'textbox';
    }
    if(el.isContentEditable) return 'textbox';
    return '';
  }

  function stableId(el){
    var id = el.id; if(!id) return null;
    if(id.length>40) return null;
    if(/\\d{4,}/.test(id)) return null;              // counters / timestamps
    if(/[0-9a-f]{8,}/i.test(id)) return null;        // hashes / uuids
    if(/^(:r|ember\\d|react-|mui-|radix-|headlessui-|aria-|downshift-)/i.test(id)) return null; // framework-generated
    if(/-\\d{2,}$/.test(id)) return null;            // trailing index
    return id;
  }

  function uniqueCss(sel){ try { return document.querySelectorAll(sel).length===1; } catch(e){ return false; } }

  function cssPath(el){
    var parts=[]; var node=el;
    while(node && node.nodeType===1 && node.tagName.toLowerCase()!=='html'){
      var sid=stableId(node);
      if(sid){ try { parts.unshift('#'+CSS.escape(sid)); } catch(e){ parts.unshift('#'+sid); } break; }
      var sel=node.tagName.toLowerCase();
      var parent=node.parentNode;
      if(parent && parent.children){
        var same=[]; for(var i=0;i<parent.children.length;i++){ if(parent.children[i].tagName===node.tagName) same.push(parent.children[i]); }
        if(same.length>1) sel+=':nth-of-type('+(same.indexOf(node)+1)+')';
      }
      parts.unshift(sel);
      node=node.parentNode;
    }
    return parts.join(' > ');
  }

  function xPath(el){
    var parts=[]; var node=el;
    while(node && node.nodeType===1 && node.tagName.toLowerCase()!=='html'){
      var ix=1, sib=node.previousElementSibling;
      while(sib){ if(sib.tagName===node.tagName) ix++; sib=sib.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase()+'['+ix+']');
      node=node.parentNode;
    }
    return '/html/'+parts.join('/');
  }

  function selectorsFor(el){
    var out=[];
    var testAttrs=['data-testid','data-test-id','data-test','data-qa','data-cy'];
    for(var i=0;i<testAttrs.length;i++){
      var a=testAttrs[i]; var v=attr(el,a);
      if(v){ var css='['+a+'="'+String(v).replace(/(["\\\\])/g,'\\\\$1')+'"]'; out.push({by:'testid',attr:a,value:v,unique:uniqueCss(css)}); }
    }
    var r=role(el), n=accName(el);
    if(r && n) out.push({by:'role',role:r,name:n});
    var tag=el.tagName?el.tagName.toLowerCase():'';
    if(tag==='input'||tag==='textarea'||tag==='select'){
      if(n) out.push({by:'label',value:n});
      var ph=attr(el,'placeholder'); if(clean(ph)) out.push({by:'placeholder',value:clean(ph)});
    } else if((tag==='button'||tag==='a'||r==='button'||r==='link') && n && n.length<=60){
      out.push({by:'text',value:n});
    }
    var sid=stableId(el);
    if(sid){ var idsel; try { idsel='#'+CSS.escape(sid); } catch(e){ idsel='#'+sid; } out.push({by:'css',value:idsel,unique:uniqueCss(idsel)}); }

    // Text tier. A clickable <div>/<span> with no role and no accessible name
    // would otherwise fall straight to a positional CSS path, which is exactly
    // what breaks after a redesign ("div:nth-of-type(3)"). Its visible text is
    // usually the most durable thing about it.
    var own = clean(el.textContent);
    if(own && own.length <= 60){
      out.push({by:'tagText', tag:tag, value:own});   // scoped to the tag = fewer collisions
      out.push({by:'text',    value:own});
    }

    // Stable-looking classes only: skip CSS-module/utility hashes, which change
    // on every build and are worse than useless as an identity.
    var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/) : [];
    var good = [];
    for(var ci=0; ci<cls.length && good.length<2; ci++){
      var cn = cls[ci];
      if(!cn || cn.length>34) continue;
      if(/\d{3,}/.test(cn)) continue;              // counters
      if(/[0-9a-f]{6,}/i.test(cn)) continue;        // hashes
      if(/^(css-|sc-|jsx-|_|makeStyles|Mui[A-Z].*-)/.test(cn)) continue; // generated
      good.push(cn);
    }
    if(good.length){
      var csel = tag + '.' + good.map(function(c){ try { return CSS.escape(c); } catch(e){ return c; } }).join('.');
      out.push({by:'css', value:csel, unique:uniqueCss(csel)});
    }

    var cp=cssPath(el); if(cp) out.push({by:'css',value:cp,unique:uniqueCss(cp)});
    out.push({by:'xpath',value:xPath(el)});
    return out;
  }

  var ACTIONABLE='a,button,input,select,textarea,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio],[contenteditable=""],[contenteditable=true],[tabindex]';
  function actionable(el){ if(!el||!el.closest) return el; return el.closest(ACTIONABLE) || el; }

  function masked(el){
    var type=(attr(el,'type')||'').toLowerCase();
    if(type==='password') return true;
    var ac=(attr(el,'autocomplete')||'').toLowerCase();
    if(AUTOCOMPLETE_MASK[ac]) return true;
    var hay=[el.name,el.id,attr(el,'aria-label'),attr(el,'placeholder'),attr(el,'name')].filter(Boolean).join(' ');
    if(MASK_RE.test(hay)) return true;
    return false;
  }

  // Menu ancestors whose HOVER reveals this element.
  //
  // Hover itself is deliberately NOT recorded as a step: mousemove/mouseover fire
  // constantly, would bloat the recording with noise, and are not user INTENT.
  // But a submenu item often does not exist in the DOM until its parent is
  // hovered, so we record how to REVEAL the target and let replay hover only when
  // it actually needs to.
  function revealFor(el){
    var out=[], node=el, hops=0;
    while(node && node.parentElement && hops<6){
      var parent=node.parentElement;
      var menuish = parent.matches && (parent.matches('[aria-haspopup],[role=menu],[role=menubar],[role=navigation],nav,li,.dropdown,.menu,.submenu') );
      if(menuish){
        // the trigger is the first labelled control in this container that is NOT
        // an ancestor of our target
        var cands = parent.querySelectorAll('a,button,[role=button],[role=menuitem],summary,[aria-haspopup]');
        for(var i=0;i<cands.length && out.length<3;i++){
          var c=cands[i];
          if(c===el || c.contains(el)) continue;
          var n=accName(c); if(!n) continue;
          var r=role(c);
          if(r && n){ out.push({by:'role', role:r, name:n}); }
          break;
        }
      }
      node=parent; hops++;
    }
    return out;
  }

    // DOM fingerprint — the identity a healer can match against when EVERY recorded
  // selector is dead. Deliberately structural + semantic, never positional-only:
  // parent context and sibling labels survive a class rename or a re-wrap, which
  // is precisely when a CSS path stops working.
  function axChain(el){
    var out=[], node=el.parentElement, hops=0;
    while(node && hops<8){
      var r=role(node);
      if(r && r!=='none' && r!=='presentation'){
        var n=accName(node);
        out.unshift(n ? r+':'+n.slice(0,32) : r);
        if(out.length>=4) break;
      }
      node=node.parentElement; hops++;
    }
    return out;
  }

  function axStates(el){
    var st={};
    if(el.disabled===true || el.getAttribute('aria-disabled')==='true') st.disabled=true;
    var exp=attr(el,'aria-expanded'); if(exp!==null) st.expanded=exp==='true';
    var chk=attr(el,'aria-checked'); if(chk!==null) st.checked=chk==='true';
    else if(typeof el.checked==='boolean' && (el.type==='checkbox'||el.type==='radio')) st.checked=el.checked;
    var sel2=attr(el,'aria-selected'); if(sel2!==null) st.selected=sel2==='true';
    var lvl=attr(el,'aria-level'); if(lvl) st.level=parseInt(lvl,10)||undefined;
    return st;
  }

  function fingerprint(el){
    var parent = el.parentElement;
    var sibs = [];
    if(parent){
      for(var i=0;i<parent.children.length && sibs.length<6;i++){
        var c=parent.children[i];
        if(c===el) continue;
        var n=accName(c)||clean(c.textContent);
        if(n) sibs.push(n.slice(0,40));
      }
    }
    var idx=0;
    if(parent){ for(var j=0;j<parent.children.length;j++){ if(parent.children[j]===el){ idx=j; break; } } }
    var section='';
    var sec = el.closest ? el.closest('section,[role=region],[role=dialog],main,form,nav,header,footer') : null;
    if(sec){
      var h = sec.querySelector('h1,h2,h3,legend,[role=heading]');
      section = h ? clean(h.textContent).slice(0,60) : (sec.getAttribute('aria-label')||sec.tagName.toLowerCase());
    }
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      role: role(el),
      name: accName(el),
      text: clean(el.textContent).slice(0,60),
      parentText: parent ? clean(parent.textContent).slice(0,90) : '',
      section: section,
      siblings: sibs,
      index: idx,
      type: attr(el,'type')||'',
      href: attr(el,'href')||'',
      page: location.pathname,
      // Accessibility-tree identity. The a11y tree changes far less often than the
      // DOM: a re-wrap or class rename leaves role/name/state intact, so this is
      // the strongest signal a healer has after the accessible name itself.
      ax: { chain: axChain(el), states: axStates(el) }
    };
  }

  function describe(el){
    var t = clean(el.textContent);
    return {
      selectors:selectorsFor(el), reveal:revealFor(el),
      role:role(el), name:accName(el),
      tag:el.tagName?el.tagName.toLowerCase():'',
      text: t ? t.slice(0,80) : '',                 // for readable failure messages
      testid: attr(el,'data-testid') || attr(el,'data-test') || attr(el,'data-qa') || null,
      fingerprint: fingerprint(el),                 // used by the healer
    };
  }
  // React Router context, when the app exposes it. A route NAME is the most
  // durable navigation target there is — it survives the path itself being
  // renamed — so we take it when we can get it and fall back to the URL when not.
  function routerInfo(){
    try {
      var out = {};
      // Router libraries commonly leave the matched route on the history state,
      // or expose it via a data attribute the app sets.
      var st = window.history && window.history.state;
      if(st && typeof st === 'object'){
        if(st.routeName) out.routeName = String(st.routeName).slice(0,80);
        if(st.key) out.historyKey = String(st.key).slice(0,40);
      }
      var el = document.querySelector('[data-route-name],[data-route],[data-page-name]');
      if(el) out.routeName = out.routeName || (el.getAttribute('data-route-name')||el.getAttribute('data-route')||el.getAttribute('data-page-name'));
      var h1 = document.querySelector('h1,[role=heading][aria-level="1"]');
      if(h1) out.heading = clean(h1.textContent).slice(0,80);
      out.title = clean(document.title).slice(0,80);
      return out;
    } catch(e){ return {}; }
  }

  function send(step){ try { if(window.__a11yRecordStep) window.__a11yRecordStep(step); } catch(e){} }

  // Expose router context to the Node side for navigation steps.
  window.__a11yRouteInfo = routerInfo;

  document.addEventListener('click', function(e){
    if(!e.isTrusted) return;
    var el=actionable(e.target); if(!el) return;
    var tag=el.tagName?el.tagName.toLowerCase():'';
    // checkbox/radio state is captured on 'change'; a click that only toggles them is noise
    if(tag==='input'){ var t=(attr(el,'type')||'').toLowerCase(); if(t==='checkbox'||t==='radio') return; }
    send({ type:'click', target:describe(el), button:e.button||0, ts:Date.now() });
  }, true);

  document.addEventListener('change', function(e){
    if(!e.isTrusted) return;
    var el=e.target; if(!el||el.nodeType!==1) return;
    var tag=el.tagName?el.tagName.toLowerCase():'';
    if(tag==='select'){
      var opts=Array.prototype.slice.call(el.selectedOptions||[]);
      send({ type:'select', target:describe(el), values:opts.map(function(o){return o.value;}), labels:opts.map(function(o){return clean(o.textContent);}), ts:Date.now() });
      return;
    }
    if(tag==='input'){
      var type=(attr(el,'type')||'text').toLowerCase();
      if(type==='checkbox'||type==='radio'){ send({ type:el.checked?'check':'uncheck', target:describe(el), ts:Date.now() }); return; }
      if(type==='file'){ send({ type:'upload', target:describe(el), masked:true, note:'file inputs cannot be replayed automatically', ts:Date.now() }); return; }
      if(masked(el)){ send({ type:'fill', target:describe(el), masked:true, ts:Date.now() }); return; }
      send({ type:'fill', target:describe(el), value:el.value, ts:Date.now() });
      return;
    }
    if(tag==='textarea'){
      if(masked(el)){ send({ type:'fill', target:describe(el), masked:true, ts:Date.now() }); return; }
      send({ type:'fill', target:describe(el), value:el.value, ts:Date.now() });
      return;
    }
    if(el.isContentEditable){ send({ type:'fill', target:describe(el), value:clean(el.textContent), ts:Date.now() }); }
  }, true);

  document.addEventListener('keydown', function(e){
    if(!e.isTrusted) return;
    if(e.key!=='Enter' && e.key!=='Escape') return;
    var el = actionable(e.target) || document.activeElement;
    // Enter inside a plain text input usually submits the form; record it as a press
    send({ type:'press', key:e.key, target: (el && el.nodeType===1) ? describe(el) : null, ts:Date.now() });
  }, true);
})();`;

export function createRecorder() {
  const state = {
    active: false,
    startedAt: null,
    startUrl: null,
    origin: null,
    entries: [],  // checkpoint URLs, kept for UI compatibility: { url, title, timestamp }
    steps: [],    // ordered actions
  };

  let navListener = null;
  let boundPage = null;
  let lastActionTs = 0;
  const boundContexts = new WeakSet();

  function pushEntry(url, title) {
    const last = state.entries[state.entries.length - 1];
    if (last && last.url === url) return;
    state.entries.push({ url, title: title ?? "", timestamp: new Date().toISOString() });
    if (state.entries.length > 300) state.entries.shift();
  }

  function pushStep(step) {
    step.i = state.steps.length;
    state.steps.push(step);
    if (["click", "fill", "select", "check", "uncheck", "press", "upload"].includes(step.type)) {
      lastActionTs = Date.now();
    }
    if (state.steps.length > 2000) state.steps.shift(); // runaway guard
  }

  async function ensureBindings(ctx, page) {
    if (!boundContexts.has(ctx)) {
      // exposeBinding throws if the name is already bound on this context; the
      // WeakSet guard makes start/stop/start on the same context idempotent.
      await ctx.exposeBinding("__a11yRecordStep", (_src, step) => {
        if (state.active && step && typeof step === "object") pushStep(step);
      });
      await ctx.addInitScript(CAPTURE_SRC); // future documents in this context
      boundContexts.add(ctx);
    }
    await page.evaluate(CAPTURE_SRC).catch(() => {}); // the document already open now
  }

  async function start(page) {
    if (!page) throw new Error("No browser session. Open one first.");
    if (state.active) throw new Error("Already recording.");
    const ctx = page.context();

    state.active = true;
    state.startedAt = new Date().toISOString();
    state.entries = [];
    state.steps = [];
    boundPage = page;
    lastActionTs = 0;

    await ensureBindings(ctx, page);

    const initialUrl = page.url();
    if (/^https?:/.test(initialUrl)) {
      const title = await page.title().catch(() => "");
      state.startUrl = initialUrl;
      try { state.origin = new URL(initialUrl).origin; } catch { /* ignore */ }
      pushEntry(initialUrl, title);
      // First navigate is always "manual" — replay must goto it to reach the start.
      const meta0 = templatize(initialUrl);
      pushStep({ type: "navigate", url: initialUrl, title, manual: true, checkpoint: true, ts: Date.now(),
                 urlMeta: { ...meta0, heading: title } });
    }

    listener_setup: {
      navListener = async (frame) => {
        try {
          if (frame !== boundPage.mainFrame()) return; // ignore iframe navigations
          const url = frame.url();
          if (!/^https?:/.test(url)) return;
          const title = await boundPage.title().catch(() => "");
          pushEntry(url, title);
          // If this navigation closely followed a recorded action, it was CAUSED
          // by that action — replay will reach it by re-doing the action, so it
          // must NOT goto (that would double-navigate / break SPA state). If it
          // did not follow an action, the user typed a URL or reloaded → goto.
          const caused = (Date.now() - lastActionTs) < 2000;
          // Abstract the URL so replay does not depend on this session's ids.
          const meta = templatize(url);
          const route = await boundPage.evaluate(() => (window.__a11yRouteInfo ? window.__a11yRouteInfo() : {})).catch(() => ({}));
          pushStep({
            type: "navigate", url, title, manual: !caused, caused, checkpoint: true, ts: Date.now(),
            urlMeta: { ...meta, routeName: route?.routeName, heading: route?.heading || title },
          });
        } catch { /* page may be tearing down mid-event */ }
      };
      boundPage.on("framenavigated", navListener);
    }
  }

  function stop() {
    if (boundPage && navListener) boundPage.off("framenavigated", navListener);
    state.active = false;
    navListener = null;
    // If the journey ended on an interaction (e.g. a modal opened without a URL
    // change), make that final state a checkpoint so replay scans it too.
    const last = state.steps[state.steps.length - 1];
    if (last && last.type !== "navigate") last.checkpoint = true;
    boundPage = null;
    return state.entries;
  }

  // Versioned, self-describing export. Secrets are already absent (masked steps
  // never carried a value), so this is always safe to write to disk.
  function toJSON() {
    return {
      version: 2,
      kind: "a11y-lens-recording",
      createdAt: state.startedAt,
      startUrl: state.startUrl,
      origin: state.origin,
      steps: state.steps.map((s) => ({ ...s })),
      checkpoints: state.steps.filter((s) => s.checkpoint).map((s) => s.i),
      entries: state.entries, // legacy URL list, for humans / v1 fallback
    };
  }

  return { state, start, stop, toJSON };
}
