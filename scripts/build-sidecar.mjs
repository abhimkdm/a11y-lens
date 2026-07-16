// Prepares the sidecar for bundling into the Tauri installer.
//
// WHY NOT A SINGLE-FILE EXE (pkg / SEA):
// Playwright cannot survive it. pkg packs your code into a virtual snapshot
// filesystem, but playwright-core does runtime lookups for real files
// (browsers.json, its driver scripts). Inside the snapshot those paths don't
// exist, and the sidecar dies on launch with MODULE_NOT_FOUND. This was verified
// by compiling and running it — not assumed.
//
// WHAT WE DO:
//   1. Ship a real Node runtime as the Tauri "sidecar" binary (renamed
//      a11y-node so we can safely kill only OUR orphans, never the user's).
//   2. Bundle ALL first-party sidecar code (server, crawler, reports, AI layer,
//      mobile engine — everything under sidecar/) into ONE minified,
//      name-mangled file via esbuild, instead of shipping ~25 readable .mjs
//      source files as Tauri resources. Comments, identifiers, and structure
//      are gone from the shipped artifact; only playwright and axe-core stay
//      as real, separately installed packages (see WHAT STAYS EXTERNAL below).
//   3. Rust spawns:  a11y-node <resources>/sidecar/server.mjs   (unchanged —
//      same path, same filename, same ESM format, so tauri.conf.json and
//      main.rs need no edits for this change.)
//
// Bigger installer than a bare exe would be, but it actually runs — which
// beats a smaller one that doesn't.
//
// WHAT STAYS EXTERNAL (and why it must):
//   playwright / playwright-core — resolves its browser driver relative to its
//     own package layout; inlining it breaks driver discovery. It's also
//     reached via a SEPARATE runtime require_("playwright") call in
//     browser-setup.mjs (createRequire, not a literal `require`), which
//     esbuild's bundler cannot see or rewrite regardless of external config —
//     so it must exist as a real installed package either way.
//   axe-core — not imported by esbuild at all. server.mjs and crawler.mjs load
//     it via readFileSync(require.resolve("axe-core/axe.min.js")) through a
//     LOCAL `require` built with createRequire, which is invisible to esbuild's
//     static import graph. Must be a real installed package or the bundle dies
//     on first scan with MODULE_NOT_FOUND. (Found by booting the bundle, not
//     assumed — same failure mode as playwright above, different symptom.)
//   node:sqlite / better-sqlite3 (db.mjs) — same createRequire pattern.
//     node:sqlite is a Node built-in (needs nothing shipped). better-sqlite3 is
//     the pre-Node-22.5 fallback and is NOT a project dependency any more (not
//     in package.json) — this build already requires Node >= 22.5 for the
//     runtime it ships, so that branch is unreachable in the packaged app and
//     is deliberately left unshipped rather than force-installing a native
//     module nothing here declares as a dependency.
//
// HONESTY NOTE: minification makes JavaScript impractical to read, not
// impossible. That's the same bar Electron apps like VS Code ship at.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const TRIPLES = {
  "win32-x64":    { triple: "x86_64-pc-windows-msvc",   ext: ".exe" },
  "darwin-arm64": { triple: "aarch64-apple-darwin",     ext: "" },
  "darwin-x64":   { triple: "x86_64-apple-darwin",      ext: "" },
  "linux-x64":    { triple: "x86_64-unknown-linux-gnu", ext: "" },
};

const key = `${process.platform}-${process.arch}`;
const t = TRIPLES[key];
if (!t) { console.error(`Unsupported platform: ${key}`); process.exit(1); }

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Node >= 22.5 required (this build ships YOUR Node as the runtime, and node:sqlite needs 22.5+). Found ${process.versions.node}`);
  process.exit(1);
}

const STAGE = "dist-sidecar";
const BIN_DIR = join("src-tauri", "sidecar");
const ENTRY = join("sidecar", "server.mjs");
const OUT_FILE = join(STAGE, "sidecar", "server.mjs");

// True esbuild externals (left as real `import` statements in the bundle).
const EXTERNALS = ["playwright", "playwright-core"];
// Never seen by esbuild's import graph (reached via createRequire at runtime),
// but must exist in dist-sidecar/node_modules or the bundle dies on first use.
const RUNTIME_ONLY_DEPS = ["axe-core"];

console.log("1/4  Bundling sidecar source (esbuild, minified)...");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "sidecar"), { recursive: true });

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  platform: "node",
  format: "esm",           // keeps the .mjs extension honest — nothing else changes
  target: "node20",
  minify: true,            // whitespace + identifiers + syntax
  sourcemap: false,        // a shipped source map would undo the point of this step
  legalComments: "none",
  metafile: true,
  external: EXTERNALS,
  // Node ESM has no global `require`. server.mjs and friends build their own via
  // createRequire, so this banner is a safety net only — for any bundled CJS
  // dependency that references a free `require` esbuild didn't fully resolve.
  // NOTE: do NOT pair this with `define: { require: ... }` — that rewrites
  // `require` calls INSIDE bundled CommonJS deps before esbuild resolves them,
  // silently dropping their whole dependency subtree. (Found the hard way: the
  // bundle shrank by ~800 KB and express's own deps had vanished.)
  banner: {
    js: 'import{createRequire as __a11yCreateRequire}from"node:module";var require=globalThis.require??__a11yCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});

const kb = (statSync(OUT_FILE).size / 1024).toFixed(0);
console.log(`     ${Object.keys(result.metafile.inputs).length} source files inlined → ${kb} KB`);

console.log("2/4  Installing runtime dependencies (not inlined)...");
// Only what the bundle actually needs present as real packages: esbuild
// externals (playwright) plus the createRequire-only deps (axe-core) esbuild
// can't see. Pinned from the root package.json so this can't silently drift
// from what's actually installed and tested.
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
const pin = (name) => rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name] ?? "latest";
const shipped = [...new Set([...EXTERNALS.filter((n) => n !== "playwright-core"), ...RUNTIME_ONLY_DEPS])];

writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: "a11y-lens-sidecar",
      private: true,
      type: "module",
      description: "Bundled A11y Lens automation sidecar. Generated file — do not edit.",
      dependencies: Object.fromEntries(shipped.sort().map((n) => [n, pin(n)])),
    },
    null,
    2
  )
);
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: STAGE, stdio: "inherit" });

console.log("3/4  Copying the Node runtime as the sidecar binary...");
mkdirSync(BIN_DIR, { recursive: true });
const nodeOut = join(BIN_DIR, `a11y-node-${t.triple}${t.ext}`);
copyFileSync(process.execPath, nodeOut);   // Node is MIT-licensed; redistribution is fine
if (t.ext === "") chmodSync(nodeOut, 0o755);

console.log("4/4  Done.");
if (!existsSync(nodeOut)) { console.error("Failed to stage the Node runtime."); process.exit(1); }
console.log(`
  runtime : ${nodeOut}
  bundle  : ${OUT_FILE}  (minified, ${kb} KB — was ~25 readable source files)
  deps    : ${STAGE}/node_modules/  (${shipped.join(", ")})

Tauri will bundle both. At launch the app runs:
  a11y-node  <resources>/sidecar/server.mjs

NOTE: Playwright's Chromium is NOT bundled (browser binaries can't be). The app
installs it on first run, or ship it via your deployment tooling.
`);
