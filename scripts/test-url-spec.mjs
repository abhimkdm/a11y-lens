import { generateSpec } from "/home/claude/a11y-lens-new/sidecar/playwright-gen.mjs";
import { templatize } from "/home/claude/a11y-lens-new/sidecar/url-template.mjs";
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};
const meta = templatize("https://app.test/customer/12345?tab=billing&utm_source=x");
const rec = { kind:"a11y-lens-recording", version:2, steps:[
  { i:0, type:"navigate", url:"https://app.test/customer/12345?tab=billing", manual:true, checkpoint:true, urlMeta: meta },
  { i:1, type:"click", target:{ name:"Pay now", selectors:[{by:"role",role:"button",name:"Pay now"}] } },
], checkpoints:[0] };
const out = generateSpec(rec, { name:"Billing" });
ck(out.code.includes("toHaveURL(new RegExp("), "generated spec asserts the URL by pattern");
ck(!out.code.includes("toBe('https://app.test/customer/12345"), "does NOT assert the literal URL with the recorded id");
ck(/\[\^\/\]\+/.test(out.code), "pattern wildcards the dynamic id segment");
console.log("\n--- excerpt ---");
console.log(out.code.split("\n").filter(l=>l.includes("goto")||l.includes("toHaveURL")||l.includes("Pay now")).join("\n"));
console.log(P?"\nPASSED":"\nFAILED"); process.exit(P?0:1);
