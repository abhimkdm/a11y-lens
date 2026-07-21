// Realistic enterprise route scenarios for the dynamic URL layer.
import {
  templatize, classifySegment, isUnstableParam, expandTemplate, matchesTemplate,
  pathSimilarity, scoreUrlMatch, rebaseUrl, resolveNavigationTarget, createVariableStore,
} from "../sidecar/url-template.mjs";

let PASS = true;
const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) PASS = false; };
const eq = (a, b, m) => ck(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : `  (got ${JSON.stringify(a)})`}`);

console.log("— template generation —");
{
  const t = templatize("https://app.test/customer/12345?tab=billing&utm_source=mail&timestamp=99");
  eq(t.pathTemplate, "/customer/{customerId}", "numeric id named from its collection");
  eq(t.params, { customerId: "12345" }, "param captured");
  eq(t.query, { tab: "billing" }, "tracking + timestamp stripped, real query kept");
  ck(new RegExp(t.regexPattern).test("/customer/99999"), "regex matches a different id");
  ck(!new RegExp(t.regexPattern).test("/customer/123/edit"), "regex does not over-match deeper paths");
}
{
  const t = templatize("https://app.test/orders/ABC-123");
  eq(t.pathTemplate, "/orders/{orderId}", "alphanumeric order code detected");
}
{
  const t = templatize("https://app.test/products/987/details");
  eq(t.pathTemplate, "/products/{productId}/details", "mid-path id, trailing route word preserved");
}
{
  const t = templatize("https://app.test/users?page=2&sort=name&timestamp=123");
  eq(t.pathTemplate, "/users", "no params -> plain path");
  eq(t.query, { page: "2", sort: "name" }, "meaningful query preserved");
}
{
  const t = templatize("https://app.test/tenants/3f2504e0-4f89-11d3-9a0c-0305e82c3301/settings");
  eq(t.pathTemplate, "/tenants/{tenantUuid}/settings", "UUID detected and named");
}
{
  const t = templatize("https://app.test/ecare/settings/profile");
  eq(t.pathTemplate, "/ecare/settings/profile", "a route with no ids is left alone");
  ck(t.hasParams === false, "hasParams false for a static route");
}
{
  const t = templatize("https://app.test/a/1/b/2");
  eq(Object.keys(t.params), ["aId", "bId"], "two ids get distinct names from their parents");
}
{
  const t = templatize("https://app.test/report/2024-03-11");
  eq(t.pathTemplate, "/report/{date}", "date segment recognised");
}

console.log("\n— conservatism (false positives are worse than misses) —");
ck(classifySegment("details") === null, "'details' is a route word, not an id");
ck(classifySegment("v2") === null, "'v2' is not treated as an id");
ck(classifySegment("checkout") === null, "'checkout' left alone");
ck(classifySegment("12345") !== null, "'12345' is an id");
ck(isUnstableParam("utm_campaign") && isUnstableParam("sessionId") && isUnstableParam("token"), "unstable params recognised");
ck(!isUnstableParam("page") && !isUnstableParam("sort") && !isUnstableParam("tab"), "meaningful params kept");

console.log("\n— variables —");
{
  const vars = createVariableStore();
  const learned = vars.learnFrom("https://app.test/customer/9911/orders/A-7");
  eq(learned, { customerId: "9911", orderId: "A-7" }, "ids learned from a real navigation");
  eq(expandTemplate("/customer/{customerId}/orders/{orderId}", vars.all),
     "/customer/9911/orders/A-7", "later step reuses the captured ids");
  ck(expandTemplate("/customer/{customerId}/invoice/{invoiceId}", vars.all) === null,
     "refuses to build a URL with an unknown variable");
}

console.log("\n— navigation strategy —");
{
  const meta = templatize("https://dev.app.test/customer/12345?tab=billing");
  const vars = { customerId: "9911" };
  const t1 = resolveNavigationTarget(meta, { vars });
  ck(t1.url === "https://dev.app.test/customer/9911?tab=billing", "template + live variable beats the recorded id");
  eq(t1.strategy, "template+variables", "strategy reported");
  const t2 = resolveNavigationTarget(meta, { origin: "https://qa.app.test" });
  ck(t2.url.startsWith("https://qa.app.test/customer/"), "environment-aware: replays on qa unchanged");
  ck(matchesTemplate("https://app.test/customer/77777", meta), "validation is by template, not string equality");
  ck(!matchesTemplate("https://app.test/orders/77777", meta), "a genuinely different route does not match");
}
ck(rebaseUrl("https://dev.site.com/customer/123", "https://prod.site.com") === "https://prod.site.com/customer/123",
   "rebase swaps environment origin only");

console.log("\n— URL healing —");
{
  const recorded = { ...templatize("https://app.test/customer/12345"), routeName: "CustomerDetails", heading: "Customer details" };
  const renamed  = { ...templatize("https://app.test/customers/12345"), routeName: "CustomerDetails", heading: "Customer details" };
  const unrelated= { ...templatize("https://app.test/invoices/12345"), routeName: "InvoiceList", heading: "Invoices" };
  const s1 = scoreUrlMatch(recorded, renamed), s2 = scoreUrlMatch(recorded, unrelated);
  ck(s1 >= 70, `/customer -> /customers heals automatically (${s1}%)`);
  ck(s2 < 70, `an unrelated route stays below the floor (${s2}%)`);
  ck(s1 > s2, "renamed route scores above unrelated route");

  const noName = { ...templatize("https://app.test/customers/12345"), heading: "Customer details" };
  const s3 = scoreUrlMatch({ ...recorded, routeName: undefined }, noName);
  ck(s3 >= 70, `heals on template + heading alone when no route name exists (${s3}%)`);
}
ck(pathSimilarity("/customer/{id}", "/customers/{id}") > 0.9, "singular/plural rename recognised");
ck(pathSimilarity("/customer/{id}", "/billing/{id}") < 0.7, "different route word is not similar");

console.log(PASS ? "\nALL URL TESTS PASSED" : "\nSOME URL TESTS FAILED");
process.exit(PASS ? 0 : 1);
