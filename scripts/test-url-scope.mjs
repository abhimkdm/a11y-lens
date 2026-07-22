import { createScope } from "../sidecar/url-scope.mjs";
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};
const H="https://portal.test";

console.log("— /ecare keeps the crawl in ECare —");
{
  const s=createScope(["/ecare"]);
  ck(s.allows(`${H}/ecare`), "/ecare itself allowed");
  ck(s.allows(`${H}/ecare/finance/5070001077/invoices`), "deep /ecare path allowed");
  ck(s.allows(`${H}/ecare/products/2f2cd71e-uuid/change-subscription`), "dynamic-id /ecare path allowed");
  ck(s.allows(`${H}/ecare?tab=billing`), "query string ignored for scope");
  ck(!s.allows(`${H}/login`), "/login rejected — no more scanning the auth page 37x");
  ck(!s.allows(`${H}/shop/kurv`), "/shop rejected");
  ck(!s.allows(`${H}/ecarehub`), "/ecarehub NOT treated as under /ecare (the classic prefix bug)");
  ck(!s.allows(`${H}/mit-yousee`), "sibling portal rejected");
}

console.log("\n— explicit globs mean the same —");
for (const pat of ["/ecare/*","/ecare/**"]) {
  const s=createScope([pat]);
  ck(s.allows(`${H}/ecare/finance`) && s.allows(`${H}/ecare`), `${pat} allows /ecare and below`);
  ck(!s.allows(`${H}/shop`), `${pat} still rejects /shop`);
}

console.log("\n— mid-path wildcard —");
{
  const s=createScope(["/shop/*/details"]);
  ck(s.allows(`${H}/shop/123/details`), "/shop/123/details matches");
  ck(s.allows(`${H}/shop/abc/details`), "/shop/abc/details matches");
  ck(!s.allows(`${H}/shop/123/reviews`), "/shop/123/reviews does not match");
  ck(!s.allows(`${H}/shop/123/details/extra`), "* is one segment, not across");
}

console.log("\n— exclusions always win —");
{
  const s=createScope(["/ecare","!/ecare/logout","!/ecare/**/print"]);
  ck(s.allows(`${H}/ecare/finance`), "included path allowed");
  ck(!s.allows(`${H}/ecare/logout`), "excluded /ecare/logout rejected even though under /ecare");
  ck(!s.allows(`${H}/ecare/finance/print`), "excluded ** pattern rejected");
}

console.log("\n— multiple includes, and no-scope —");
{
  const s=createScope(["/ecare","/shop/kurv"]);
  ck(s.allows(`${H}/ecare/x`) && s.allows(`${H}/shop/kurv`), "either include matches");
  ck(!s.allows(`${H}/shop/tv`), "outside both rejected");
}
{
  const s=createScope([]);
  ck(!s.active && s.allows(`${H}/anything`), "empty scope = allow everything (unchanged behaviour)");
}
{
  const s=createScope("/ecare, !/ecare/admin");   // string form
  ck(s.allows(`${H}/ecare/x`) && !s.allows(`${H}/ecare/admin`), "comma-string form parses");
}
console.log(P?"\nALL SCOPE TESTS PASSED":"\nSOME SCOPE TESTS FAILED"); process.exit(P?0:1);
