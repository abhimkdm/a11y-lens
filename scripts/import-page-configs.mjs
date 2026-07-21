#!/usr/bin/env node
// Import Playwright-style page configs into A11y Lens.
//
// Converts a folder of `page-configs/*.ts` (each exporting `pages: PageConfig[]`
// with a url and a list of states, where each state has Playwright actions) into:
//
//   1. a URL list       -> "Upload URL list (.json)" for a Full Scan
//   2. A11y Lens recordings -> "Import recording" + "Replay & scan", which also
//      audits every interaction-revealed STATE the configs describe
//
// Why both: the URL list gets you scanning in a minute, but it only ever sees each
// page's default state. The recordings carry the actions, so the drawers, filters
// and modals those configs open get audited too — which is where most real defects
// live and is the reason those states were written down in the first place.
//
// Usage:
//   node scripts/import-page-configs.mjs <page-configs-dir> [--out DIR] [--base https://host]

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { templatize } from "../sidecar/url-template.mjs";

const require_ = createRequire(import.meta.url);

const args = process.argv.slice(2);
const srcDir = resolve(args[0] || "page-configs");
const outDir = resolve(argVal("--out") || "a11y-lens-import");
const baseUrl = (argVal("--base") || "").replace(/\/$/, "");
function argVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

if (!existsSync(srcDir)) { console.error(`No such directory: ${srcDir}`); process.exit(1); }

// ---- load the TS configs -------------------------------------------------
// They are plain data modules, so transpiling with esbuild is far more reliable
// than pattern-matching the source — template literals, imported constants and
// nested actions all resolve exactly as the original test suite sees them.
let esbuild;
try { esbuild = require_("esbuild"); }
catch { console.error("esbuild is required (it ships with vite). Run this from the A11y Lens repo root."); process.exit(1); }

const files = readdirSync(srcDir).filter((f) => /\.[cm]?ts$/.test(f) && !/^(types|constants)\./.test(f));
if (!files.length) { console.error(`No config files found in ${srcDir}`); process.exit(1); }

// Bundle one entry at a time: esbuild requires an outdir for multiple inputs, and
// we want in-memory output so nothing is written to the caller's tree.
const allPages = [];
for (const f of files) {
  try {
    const built = esbuild.buildSync({
      entryPoints: [join(srcDir, f)],
      bundle: true, write: false, format: "esm", platform: "node",
      target: "node18", logLevel: "silent",
    });
    const text = built.outputFiles[0].text;
    const url = "data:text/javascript;base64," + Buffer.from(text).toString("base64");
    const mod = await import(url);
    const pages = mod.pages ?? mod.default ?? [];
    for (const p of pages) allPages.push({ ...p, __file: f });
  } catch (e) {
    console.warn(`  ! skipped ${f}: ${String(e.message ?? e).slice(0, 90)}`);
  }
}

if (!allPages.length) { console.error("Loaded no pages — check the config format."); process.exit(1); }

// ---- Playwright selector -> A11y Lens ranked selector chain --------------
// Their selectors are Playwright syntax. Mapping them onto the same ranked tiers
// A11y Lens records means an imported step is no more brittle than a recorded one,
// and a config that only offers a CSS path is flagged rather than silently trusted.
function toSelectorChain(sel) {
  const s = String(sel || "").trim();
  const chain = [];
  if (!s) return chain;

  // text=Foo  /  text="Foo"
  let m = s.match(/^text=["']?(.+?)["']?$/i);
  if (m) { chain.push({ by: "text", value: m[1] }); return chain; }

  // role=button[name="Foo"]
  m = s.match(/^role=([a-z]+)\[name=["'](.+?)["']\]/i);
  if (m) { chain.push({ by: "role", role: m[1], name: m[2] }); return chain; }

  // [data-testid="x"]
  m = s.match(/\[data-(testid|test-id|test|qa|ai)=["'](.+?)["']\]/i);
  if (m) chain.push({ by: "testid", attr: `data-${m[1]}`, value: m[2] });

  // tag.class:has-text("Foo")  -> text is the durable half, CSS the fallback
  m = s.match(/^(.*?):has-text\(["'](.+?)["']\)\s*$/i);
  if (m) {
    const tag = (m[1].match(/^([a-z]+)/i) || [])[1] || "*";
    chain.push({ by: "tagText", tag, value: m[2] });
    chain.push({ by: "text", value: m[2] });
    if (m[1]) chain.push({ by: "css", value: m[1] });
    return chain;
  }

  // aria-label="Foo"
  m = s.match(/\[aria-label=["'](.+?)["']\]/i);
  if (m) chain.push({ by: "role", role: "button", name: m[1] });

  chain.push({ by: "css", value: s });
  return chain;
}

const ACTION_MAP = { click: "click", fill: "fill", type: "fill", select: "select", check: "check", press: "press" };

// ---- build the artefacts -------------------------------------------------
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "recordings"), { recursive: true });

const urls = [];
const recordings = [];
let stateCount = 0, actionCount = 0, cssOnly = 0, needsLogin = 0;

for (const page of allPages) {
  const rawUrl = String(page.url || "");
  if (!rawUrl) continue;
  const full = baseUrl && rawUrl.startsWith("/") ? baseUrl + rawUrl : rawUrl;
  urls.push(full);
  if (page.requiresLogin) needsLogin++;

  const meta = templatize(full.startsWith("http") ? full : `https://placeholder.invalid${full}`);
  const steps = [];
  let i = 0;
  const checkpoints = [];

  steps.push({
    i: i++, type: "navigate", url: full, title: page.name, manual: true, checkpoint: true,
    urlMeta: { ...meta, heading: page.name },
  });
  checkpoints.push(0);

  for (const state of page.states ?? []) {
    stateCount++;
    // A non-sequential page returns to its URL before each state, exactly as the
    // original runner does — otherwise state N+1 starts from state N's leftovers.
    if (!page.sequential && (state.actions?.length) && steps.length > 1) {
      steps.push({ i: i++, type: "navigate", url: full, title: page.name, manual: true, urlMeta: { ...meta, heading: page.name } });
    }
    for (const a of state.actions ?? []) {
      const type = ACTION_MAP[a.type];
      if (!type) continue;                       // wait / waitForSelector / pause: replay settles on its own
      actionCount++;
      const chain = toSelectorChain(a.selector);
      if (chain.length && chain.every((c) => c.by === "css")) cssOnly++;
      const step = {
        i: i++, type,
        target: {
          selectors: chain,
          name: (chain.find((c) => c.name || c.value)?.name) || (chain.find((c) => c.by === "text" || c.by === "tagText")?.value) || "",
          tag: "", role: "", text: "",
        },
      };
      if (type === "fill") step.value = a.value ?? "";
      if (type === "select") step.values = [a.value ?? ""];
      if (type === "press") { step.key = a.key ?? "Enter"; delete step.target; }
      steps.push(step);
    }
    // Each named state is a checkpoint — that is where a scan should happen.
    if (steps.length) {
      const last = steps[steps.length - 1];
      last.checkpoint = true;
      if (!checkpoints.includes(last.i)) checkpoints.push(last.i);
    }
  }

  const slug = String(page.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const recording = {
    version: 2, kind: "a11y-lens-recording",
    createdAt: new Date().toISOString(),
    name: page.name,
    startUrl: full,
    origin: baseUrl || null,
    requiresLogin: !!page.requiresLogin,
    steps, checkpoints,
    entries: [{ url: full, title: page.name }],
  };
  recordings.push({ slug, recording });
  writeFileSync(join(outDir, "recordings", `${slug}.json`), JSON.stringify(recording, null, 2));
}

writeFileSync(join(outDir, "urls.json"), JSON.stringify({ urls }, null, 2));

const summary = {
  source: srcDir,
  pages: allPages.length,
  urls: urls.length,
  states: stateCount,
  actions: actionCount,
  requiresLogin: needsLogin,
  cssOnlySelectors: cssOnly,
  recordings: recordings.length,
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\nImported from ${srcDir}`);
console.log(`  pages ................ ${summary.pages}`);
console.log(`  URLs ................. ${summary.urls}`);
console.log(`  states ............... ${summary.states}`);
console.log(`  actions converted .... ${summary.actions}`);
console.log(`  need login ........... ${summary.requiresLogin}`);
console.log(`  CSS-only selectors ... ${summary.cssOnly ?? cssOnly}  (no role/text to fall back on)`);
console.log(`\nWrote:`);
console.log(`  ${join(outDir, "urls.json")}          -> Upload URL list (.json)`);
console.log(`  ${join(outDir, "recordings")}/*.json  -> Import recording, then Replay & scan`);
