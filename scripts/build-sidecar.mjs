// Compiles the Node sidecar into a single executable and drops it where Tauri's
// `externalBin` expects it: src-tauri/sidecar/a11y-sidecar-<target-triple><ext>
//
// Tauri resolves external binaries by appending the Rust target triple, so the
// filename must match exactly or the bundle silently ships without it.
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

const TRIPLES = {
  "win32-x64":   { triple: "x86_64-pc-windows-msvc",  pkg: "node22-win-x64",     ext: ".exe" },
  "darwin-arm64":{ triple: "aarch64-apple-darwin",    pkg: "node22-macos-arm64", ext: "" },
  "darwin-x64":  { triple: "x86_64-apple-darwin",     pkg: "node22-macos-x64",   ext: "" },
  "linux-x64":   { triple: "x86_64-unknown-linux-gnu",pkg: "node22-linux-x64",   ext: "" },
};

const key = `${process.platform}-${process.arch}`;
const t = TRIPLES[key];
if (!t) {
  console.error(`Unsupported platform: ${key}`);
  process.exit(1);
}

const outDir = join("src-tauri", "sidecar");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `a11y-sidecar-${t.triple}${t.ext}`);

console.log(`Building sidecar for ${t.triple} ...`);
// node:sqlite is built in, so there is no native .node addon to bundle — this is
// the whole reason the packaged sidecar is reliable.
execSync(
  `npx --yes @yao-pkg/pkg sidecar/server.mjs --targets ${t.pkg} --output "${outFile}"`,
  { stdio: "inherit" }
);

if (!existsSync(outFile)) {
  console.error("Sidecar build produced no output.");
  process.exit(1);
}
if (t.ext === "") chmodSync(outFile, 0o755);
console.log(`\nSidecar ready: ${outFile}`);
console.log("Tauri will bundle this automatically via externalBin.");
