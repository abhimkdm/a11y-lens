import { BROWSERS, getBrowser, launchPlan, contextOptions, requiredDownloads, DEFAULT_BROWSER } from "../sidecar/browsers.mjs";
let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };

ck(Object.keys(BROWSERS).length === 5, "registry has chrome, edge, chromium, firefox, webkit");
ck(getBrowser("nope").id === DEFAULT_BROWSER, "unknown id falls back to the default rather than throwing");
ck(getBrowser("FIREFOX").id === "firefox", "ids are case-insensitive");

const edge = launchPlan("edge").plan;
ck(edge.length === 2 && /installed channel/.test(edge[0].describe), "Edge tries the installed channel first");
ck(edge[1].engine === "chromium", "…then degrades to the bundled engine instead of failing");

const wk = launchPlan("webkit").plan;
ck(wk.length === 1 && wk[0].engine === "webkit", "WebKit has no channel — bundled engine only");

ck(contextOptions("chrome").viewport === null, "Chromium keeps viewport:null (real window size)");
ck(contextOptions("firefox").viewport?.width === 1440, "Gecko gets an explicit viewport, where viewport:null is unreliable");
ck(contextOptions("webkit").viewport?.width === 1440, "WebKit likewise");

ck(JSON.stringify(requiredDownloads(["firefox"])) === '["firefox"]', "installing Firefox downloads only Firefox");
ck(requiredDownloads(["edge"]).includes("chromium"), "Edge still needs chromium as its fallback engine");
const all = requiredDownloads(["chrome", "edge", "firefox", "webkit"]);
ck(all.length === 3 && all.includes("chromium") && all.includes("firefox") && all.includes("webkit"),
   "all four browsers require exactly three engine downloads");

ck(/not Safari/i.test(BROWSERS.webkit.note), "WebKit entry states plainly that it is not Safari");
ck(/Full Keyboard Access/i.test(BROWSERS.webkit.note), "…and warns that WebKit tab order differs by default");

console.log(P ? "\nALL BROWSER TESTS PASSED" : "\nFAILED");
process.exit(P ? 0 : 1);
