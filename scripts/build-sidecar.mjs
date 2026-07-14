// Prepares the sidecar for bundling into the Tauri installer.
//
// WHY NOT A SINGLE-FILE EXE (pkg / SEA):
// Playwright cannot survive it. pkg packs your code into a virtual snapshot
// filesystem, but playwright-core does runtime lookups for real files
// (browsers.json, its driver scripts). Inside the snapshot those paths don't
// exist, and the sidecar dies on launch with MODULE_NOT_FOUND. This was verified
// by compiling and running it — not assumed.
//
// WHAT WE DO INSTEAD:
//   1. Ship a real Node runtime as the Tauri "sidecar" binary (renamed
//      a11y-node so we can safely kill only OUR orphans, never the user's).
//   2. Ship the sidecar source + a production-only node_modules as Tauri
//      resources.
//   3. Rust spawns:  a11y-node <resources>/sidecar/server.mjs
//
// Bigger installer, but it actually runs — which beats a smaller one that
// doesn't.
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, copyFileSync, existsSync, chmodSync } from "node:fs";
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

console.log("1/4  Staging sidecar source...");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "sidecar"), { recursive: true });
cpSync("sidecar", join(STAGE, "sidecar"), { recursive: true });

console.log("2/4  Installing production dependencies...");
// Only what the sidecar actually needs at runtime. Keeping this list explicit
// stops the installer quietly ballooning with dev tooling.
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: "a11y-lens-sidecar",
      private: true,
      type: "module",
      dependencies: {
        express: "^4.21.2",
        cors: "^2.8.5",
        "axe-core": "^4.10.2",
        playwright: "^1.49.0",
      },
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
  source  : ${STAGE}/  (bundled as a Tauri resource)

Tauri will bundle both. At launch the app runs:
  a11y-node  <resources>/sidecar/server.mjs

NOTE: Playwright's Chromium is NOT bundled (browser binaries can't be). The app
installs it on first run, or ship it via your deployment tooling.
`);
