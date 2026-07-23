// Screenshots: disk save + settle bounds + report inlining, through the REAL
// deduplicate() and buildSiteReport() so the shape is never guessed.
import { captureFullPageAnnotated, settleForCapture } from "../sidecar/element-shots.mjs";
import { deduplicate } from "../sidecar/report-site.mjs";
import { buildSiteReport } from "../sidecar/report-site-html.mjs";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let P = true; const ck = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) P = false; };
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==", "base64");
const dir = mkdtempSync(join(tmpdir(), "a11yshots-"));

function fakePage() {
  return {
    async evaluate(fn) { const s = String(fn); if (s.includes("scrollWidth")) return { w: 800, h: 1200 }; return null; },
    async screenshot() { return JPEG; }, async waitForLoadState() {}, async waitForTimeout() {},
  };
}

// 1 · settle is bounded and never throws
{
  const t0 = Date.now();
  await settleForCapture(fakePage(), { settleMs: 5, networkIdleMs: 30, maxScrollMs: 50 });
  ck(Date.now() - t0 < 1500, "settle returns quickly and is bounded");
  let threw = false;
  try { await settleForCapture({ async evaluate() { throw new Error("x"); }, async waitForLoadState() { throw new Error("x"); }, async waitForTimeout() {} }, {}); } catch { threw = true; }
  ck(!threw, "settle never throws — a shot is always attempted");
}

// 2 · disk save keeps base64 out of the result
{
  const r = await captureFullPageAnnotated(fakePage(), [], { settle: false, saveDir: dir, shotName: "shot_1" });
  ck(r.shotPath && existsSync(r.shotPath), "screenshot written to disk");
  ck(!r.pageShot, "disk mode does not also embed base64 (session stays small)");
  const r2 = await captureFullPageAnnotated(fakePage(), [], { settle: false });
  ck(r2.pageShot && !r2.shotPath, "no saveDir -> inline base64 (back-compatible)");
}

// 3 · report inlines a DISK-backed shot, through the real pipeline
{
  const shot = await captureFullPageAnnotated(fakePage(), [], { settle: false, saveDir: dir, shotName: "shot_2" });
  const pages = [{
    url: "https://h/x", title: "T", score: 80,
    violations: [{
      id: "image-alt", impact: "serious", description: "Image missing alt", help: "Images must have alt text", wcag: ["1.1.1"],
      nodes: [{ target: "img", html: "<img>", box: { x: 10, y: 10, w: 100, h: 40 }, shotKey: "/x||T", page: "/x", shotTitle: "T", callout: 1 }],
    }],
  }];
  const pageShots = { "/x||T": { shotPath: shot.shotPath, w: 800, h: 1200 } };
  const dedup = deduplicate(pages);
  const files = buildSiteReport(dedup, null, { generatedAt: Date.now() }, pageShots);
  const html = Object.values(files).join("\n");
  ck(html.includes("data:image/jpeg;base64,/9j/"), "report inlined the disk shot as portable base64");

  // missing file -> finding kept, no crash
  let crashed = false;
  try {
    const bad = { "/x||T": { shotPath: join(dir, "gone.jpg"), w: 800, h: 1200 } };
    buildSiteReport(deduplicate(pages), null, { generatedAt: Date.now() }, bad);
  } catch { crashed = true; }
  ck(!crashed, "a missing shot file does not crash report generation");
}

rmSync(dir, { recursive: true, force: true });
console.log(P ? "\nALL SCREENSHOT TESTS PASSED" : "\nSOME FAILED");
process.exit(P ? 0 : 1);
