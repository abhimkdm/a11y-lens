// Prove maxPages does not truncate a URL list or a recorded replay.
import { createCrawler } from "/home/claude/a11y-lens-new/sidecar/crawler.mjs";
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};
function page(){ let cur="https://p.test/";
  return { url:()=>cur, async title(){return "T";}, async goto(u){cur=u;},
    async evaluate(fn){ return String(fn).includes("axe.run") ? {violations:[]} : null; },
    async waitForTimeout(){}, async waitForLoadState(){}, async screenshot(){return Buffer.from("x");},
    locator(){return {count:async()=>0, first(){return this;}};},
    getByRole(){return {count:async()=>0, first(){return this;}};},
    keyboard:{async press(){}}, context(){return{};}, mainFrame(){return{};}, on(){}, off(){} };
}
const base={ elementScreenshots:false, keyboardEvidence:false, interact:false, ai:null, aiAudit:false };

// 25 URLs, maxPages deliberately set to 3
{
  const c=createCrawler();
  const urls=Array.from({length:25},(_,i)=>`https://p.test/u${i}`);
  c.start(page(), { ...base, urlList:urls, maxPages:3 });
  await new Promise(r=>setTimeout(r,600));
  ck(c.state.pagesScanned.length===25,
     `URL list of 25 with maxPages=3 -> all 25 scanned (got ${c.state.pagesScanned.length}); the control is genuinely ignored`);
}

// open crawl: maxPages IS the bound
{
  const c=createCrawler();
  c.start(page(), { ...base, maxPages:4 });
  await new Promise(r=>setTimeout(r,600));
  ck(c.state.unitsTotal===4, `open crawl honours maxPages as its stop condition (unitsTotal=${c.state.unitsTotal})`);
}
console.log(P?"\nCONFIRMED":"\nMISMATCH"); process.exit(P?0:1);
