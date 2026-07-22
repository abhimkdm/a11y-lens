// Scope applied by the REAL crawler: a start at /ecare must not follow a /login link.
import { createCrawler } from "../sidecar/crawler.mjs";
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};

// Page offers links to BOTH an in-scope and an out-of-scope path.
function page(){
  let cur="https://portal.test/ecare";
  return {
    url:()=>cur, async title(){return "P";}, async goto(u){cur=u;},
    async evaluate(fn){
      const s=String(fn);
      if(s.includes("axe.run")) return {violations:[]};
      if(s.includes('role="tab"') || s.includes("nav button")){
        return [
          { text:"Invoices", href:"/ecare/finance/1/invoices", tag:"a" },
          { text:"Log out",  href:"/login", tag:"a" },
          { text:"Shop",     href:"/shop/kurv", tag:"a" },
        ];
      }
      return [];
    },
    async waitForTimeout(){}, async waitForLoadState(){}, async goBack(){},
    async screenshot(){return Buffer.from("x");},
    locator(){return {count:async()=>0, first(){return this;}};},
    getByRole(){return {count:async()=>0, first(){return this;}};},
    getByText(){return { first(){return { async click(){}, async waitFor(){} }; } };},
    keyboard:{async press(){}}, context(){return {};}, mainFrame(){return {};}, on(){}, off(){},
  };
}
const base={ elementScreenshots:false, keyboardEvidence:false, interact:false, ai:{provider:null}, aiAudit:false, templateCoverage:false };

// crawl with scope /ecare
{
  const c=createCrawler();
  c.start(page(), { ...base, maxPages:6, scope:["/ecare"] });
  await new Promise(r=>setTimeout(r,700)); c.stop();
  const paths=c.state.pagesScanned.map(p=>{ try { return new URL(p.url).pathname; } catch { return p.url; } });
  ck(paths.every(p=>p.startsWith("/ecare")), "every scanned page is under /ecare: "+JSON.stringify(paths));
  ck(!paths.some(p=>p.startsWith("/login")||p.startsWith("/shop")), "no /login or /shop page was scanned");
}

// URL list with scope: out-of-scope entries dropped
{
  const c=createCrawler();
  const urls=["/ecare/a","/ecare/b","/login","/shop/x"].map(p=>"https://portal.test"+p);
  c.start(page(), { ...base, urlList:urls, scope:["/ecare"] });
  await new Promise(r=>setTimeout(r,500)); c.stop();
  const n=c.state.pagesScanned.length;
  ck(n===2, `URL list of 4 with scope /ecare -> 2 scanned (got ${n})`);
}
console.log(P?"\nSCOPE CRAWL TESTS PASSED":"\nFAILED"); process.exit(P?0:1);
