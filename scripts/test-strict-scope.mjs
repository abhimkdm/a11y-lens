// Strict scope: nothing outside /ecare/* is scanned — entry point, redirects, links.
import { createCrawler } from "../sidecar/crawler.mjs";
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};

function makePage(startPath, redirects={}) {
  let cur = "https://portal.test" + startPath;
  return {
    url:()=>cur, async title(){return "P";},
    async goto(u){ const p=new URL(u).pathname; cur = redirects[p] ? "https://portal.test"+redirects[p] : u; },
    async evaluate(fn){ const s=String(fn);
      if(s.includes("axe.run")) return {violations:[]};
      if(s.includes('role="tab"')||s.includes("nav button"))
        return [{text:"Invoices",href:"/ecare/finance/1",tag:"a"},{text:"Promo",href:"/promo",tag:"a"}];
      return []; },
    async waitForTimeout(){}, async waitForLoadState(){}, async goBack(){},
    async screenshot(){return Buffer.from("x");},
    locator(){return {count:async()=>0, first(){return this;}};},
    getByRole(){return {count:async()=>0, first(){return this;}};},
    getByText(){return { first(){return { async click(){}, async waitFor(){} }; } };},
    keyboard:{async press(){}}, context(){return {};}, mainFrame(){return {};}, on(){}, off(){},
  };
}
const base={ elementScreenshots:false, keyboardEvidence:false, interact:false, ai:{provider:null}, aiAudit:false, templateCoverage:false };

// 1 · entry point OUT of scope -> refuse, scan nothing
{
  const c=createCrawler();
  c.start(makePage("/"), { ...base, maxPages:5, scope:["/ecare/*"] });
  await new Promise(r=>setTimeout(r,400)); c.stop();
  ck(c.state.pagesScanned.length===0, `entry "/" with scope /ecare/* -> 0 scanned (got ${c.state.pagesScanned.length})`);
  ck(/outside the path scope/i.test(c.state.error||""), "clear error explaining the entry page is out of scope");
}

// 2 · entry IN scope, a discovered /promo link is not followed
{
  const c=createCrawler();
  c.start(makePage("/ecare"), { ...base, maxPages:6, scope:["/ecare"] });
  await new Promise(r=>setTimeout(r,700)); c.stop();
  const paths=c.state.pagesScanned.map(p=>{try{return new URL(p.url).pathname;}catch{return p.url;}});
  ck(paths.length>0 && paths.every(p=>p.startsWith("/ecare")), "only /ecare pages scanned: "+JSON.stringify(paths));
  ck(!paths.some(p=>p.startsWith("/promo")), "the out-of-scope /promo link was never scanned");
}

// 3 · URL-list entry that REDIRECTS out of scope is not scanned
{
  const c=createCrawler();
  const urls=["/ecare/a","/ecare/b"].map(p=>"https://portal.test"+p);
  // /ecare/b bounces to /promo
  c.start(makePage("/ecare", { "/ecare/b":"/promo" }), { ...base, urlList:urls, scope:["/ecare"] });
  await new Promise(r=>setTimeout(r,500)); c.stop();
  const paths=c.state.pagesScanned.map(p=>{try{return new URL(p.url).pathname;}catch{return p.url;}});
  ck(!paths.some(p=>p.startsWith("/promo")), "redirect from /ecare/b to /promo was NOT scanned");
  ck(paths.includes("/ecare/a"), "/ecare/a still scanned normally");
}

// 4 · no scope set -> unchanged (scans "/" fine)
{
  const c=createCrawler();
  c.start(makePage("/"), { ...base, maxPages:1 });
  await new Promise(r=>setTimeout(r,300)); c.stop();
  ck(c.state.pagesScanned.length===1 && !c.state.error, "no scope -> entry page scanned as before (no regression)");
}
console.log(P?"\nALL STRICT-SCOPE TESTS PASSED":"\nFAILED"); process.exit(P?0:1);
