// A11y Lens — Mobile device layer.
//
// This is a SEPARATE engine from the web scanner and shares nothing with it.
// A native app has no DOM, no CSS selector, no <a href>. Playwright, axe-core,
// the crawler and the overlay are all meaningless here, and pretending otherwise
// would produce confident nonsense.
//
// What we drive instead:
//   Android — adb (Android SDK platform-tools). Works on Windows, macOS, Linux.
//   iOS     — xcrun simctl (Xcode). macOS ONLY, and there is no way around that:
//             the iOS Simulator does not exist on Windows.
//
// Every external command is wrapped so a missing toolchain produces a sentence a
// person can act on ("Android SDK platform-tools not found — install it and add
// adb to PATH"), not a spawn ENOENT stack trace.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const EXEC_OPTS = { timeout: 20000, maxBuffer: 32 * 1024 * 1024 };

export class ToolMissingError extends Error {
  constructor(tool, hint) {
    super(`${tool} not found. ${hint}`);
    this.tool = tool;
    this.hint = hint;
    this.code = "TOOL_MISSING";
  }
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await exec(cmd, args, { ...EXEC_OPTS, ...opts });
    return stdout;
  } catch (e) {
    if (e.code === "ENOENT") {
      if (cmd === "adb") {
        throw new ToolMissingError(
          "adb",
          "Install Android SDK platform-tools and make sure adb is on your PATH."
        );
      }
      if (cmd === "xcrun") {
        throw new ToolMissingError("xcrun", "Install Xcode and its Command Line Tools.");
      }
      throw new ToolMissingError(cmd, "Command not found on PATH.");
    }
    throw e;
  }
}

/** Raw bytes (screenshots) rather than text. */
async function runBinary(cmd, args) {
  try {
    const { stdout } = await exec(cmd, args, { ...EXEC_OPTS, encoding: "buffer" });
    return stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new ToolMissingError(cmd, "Command not found on PATH.");
    throw e;
  }
}

export const isMac = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Toolchain probe — answers "what can this machine actually do?" up front,
// instead of letting the user click Scan and hit a wall.
// ---------------------------------------------------------------------------
export async function toolchainStatus() {
  const out = {
    android: { available: false, version: null, hint: null },
    ios: {
      available: false,
      version: null,
      // Not a limitation of ours. Apple does not ship the iOS Simulator for Windows.
      hint: isMac ? null : "iOS scanning requires macOS with Xcode. The iOS Simulator does not exist on Windows or Linux.",
    },
    platform: process.platform,
  };

  try {
    const v = await run("adb", ["version"]);
    out.android.available = true;
    out.android.version = (v.split("\n")[0] || "").trim();
  } catch (e) {
    out.android.hint = e.hint ?? String(e.message ?? e);
  }

  if (isMac) {
    try {
      const v = await run("xcrun", ["simctl", "help"]);
      out.ios.available = /simctl/i.test(v);
      const xv = await run("xcodebuild", ["-version"]).catch(() => "");
      out.ios.version = (xv.split("\n")[0] || "").trim() || null;
    } catch (e) {
      out.ios.hint = e.hint ?? String(e.message ?? e);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------
export async function listAndroidDevices() {
  const out = await run("adb", ["devices", "-l"]);
  const devices = [];
  for (const line of out.split("\n").slice(1)) {
    const t = line.trim();
    if (!t || !/\bdevice\b/.test(t)) continue;
    const [id] = t.split(/\s+/);
    const model = /model:(\S+)/.exec(t)?.[1] ?? null;
    devices.push({
      id,
      platform: "android",
      name: model ? model.replace(/_/g, " ") : id,
      kind: /^emulator-/.test(id) ? "emulator" : "device",
      state: "booted",
    });
  }
  return devices;
}

export async function listAndroidEmulators() {
  // `emulator -list-avds` lives in the SDK's emulator/ dir, which is often not on
  // PATH even when adb is. Failing here is not fatal — a physical device or an
  // already-running emulator still works.
  try {
    const out = await run("emulator", ["-list-avds"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean)
      .map((name) => ({ id: name, name, platform: "android", kind: "avd", state: "shutdown" }));
  } catch {
    return [];
  }
}

export async function bootAndroidEmulator(avd) {
  // Detached: the emulator runs for minutes and must outlive this request.
  const { spawn } = await import("node:child_process");
  const child = spawn("emulator", ["-avd", avd], { detached: true, stdio: "ignore" });
  child.unref();
  return { started: true, avd };
}

/** UI hierarchy — the Android equivalent of the accessibility tree. */
export async function androidHierarchy(deviceId) {
  const args = deviceId ? ["-s", deviceId] : [];
  // `exec-out` streams to stdout instead of writing a file to the device and
  // pulling it back — fewer moving parts, and no litter left on the device.
  const xml = await run("adb", [...args, "exec-out", "uiautomator", "dump", "/dev/tty"]);
  const start = xml.indexOf("<?xml");
  const end = xml.lastIndexOf(">");
  if (start === -1) throw new Error("uiautomator returned no hierarchy. Is the screen on and unlocked?");
  return xml.slice(start, end + 1);
}

export async function androidScreenshot(deviceId) {
  const args = deviceId ? ["-s", deviceId] : [];
  const buf = await runBinary("adb", [...args, "exec-out", "screencap", "-p"]);
  return buf.toString("base64");
}

export async function androidDeviceInfo(deviceId) {
  const args = deviceId ? ["-s", deviceId] : [];
  const get = async (prop) => (await run("adb", [...args, "shell", "getprop", prop])).trim();
  const size = await run("adb", [...args, "shell", "wm", "size"]).catch(() => "");
  const density = await run("adb", [...args, "shell", "wm", "density"]).catch(() => "");
  return {
    model: await get("ro.product.model").catch(() => "unknown"),
    release: await get("ro.build.version.release").catch(() => "unknown"),
    sdk: await get("ro.build.version.sdk").catch(() => "unknown"),
    // Density matters: touch targets are specified in dp, and dp = px / (dpi/160).
    // Get this wrong and every target-size finding is wrong.
    screen: /(\d+)x(\d+)/.exec(size)?.slice(1, 3).map(Number) ?? null,
    densityDpi: Number(/(\d+)/.exec(density)?.[1] ?? 160),
  };
}

export async function androidForegroundApp(deviceId) {
  const args = deviceId ? ["-s", deviceId] : [];
  const out = await run("adb", [...args, "shell", "dumpsys", "window", "windows"]).catch(() => "");
  const m = /mCurrentFocus=.*?\s([\w.]+)\/([\w.$]+)/.exec(out);
  return m ? { package: m[1], activity: m[2] } : null;
}

// ---------------------------------------------------------------------------
// iOS (macOS only)
// ---------------------------------------------------------------------------
function assertMac() {
  if (!isMac) {
    throw new ToolMissingError(
      "iOS Simulator",
      "iOS scanning requires macOS with Xcode. Apple does not ship the iOS Simulator for Windows or Linux."
    );
  }
}

export async function listIosSimulators() {
  assertMac();
  const out = await run("xcrun", ["simctl", "list", "devices", "--json"]);
  const data = JSON.parse(out);
  const devices = [];
  for (const [runtime, list] of Object.entries(data.devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false) continue;
      devices.push({
        id: d.udid,
        platform: "ios",
        name: d.name,
        kind: "simulator",
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " "),
        state: (d.state || "").toLowerCase(),   // booted | shutdown
      });
    }
  }
  return devices;
}

export async function bootIosSimulator(udid) {
  assertMac();
  await run("xcrun", ["simctl", "boot", udid]).catch((e) => {
    // Already booted is a success, not a failure.
    if (!/current state: Booted/i.test(String(e.stderr ?? e.message ?? ""))) throw e;
  });
  await run("open", ["-a", "Simulator"]).catch(() => {});
  return { started: true, udid };
}

export async function iosScreenshot(udid) {
  assertMac();
  const buf = await runBinary("xcrun", ["simctl", "io", udid || "booted", "screenshot", "-"]);
  return buf.toString("base64");
}

/**
 * iOS accessibility hierarchy.
 *
 * Honest limitation: `simctl` cannot dump the accessibility tree. Apple exposes it
 * through XCUITest (in-process, needs a test target) or through `idb`, Meta's iOS
 * Development Bridge, which is what everyone actually uses for this.
 *
 * So: if idb is installed we get a real element tree. If not, we say so plainly
 * and fall back to screenshot-only — which still supports the AI/visual tier, but
 * NOT the deterministic label/target-size checks that need element geometry.
 * Claiming otherwise would be the worst kind of lie for an accessibility tool.
 */
export async function iosHierarchy(udid) {
  assertMac();
  try {
    const out = await run("idb", ["ui", "describe-all", "--udid", udid || ""]);
    return { tree: JSON.parse(out), source: "idb" };
  } catch (e) {
    if (e.code === "TOOL_MISSING" || e.code === "ENOENT") {
      throw new ToolMissingError(
        "idb",
        "The iOS accessibility tree needs Meta's idb (`brew tap facebook/fb && brew install idb-companion && pip install fb-idb`). " +
          "Without it, iOS scanning can still capture screenshots for the AI review, but the deterministic label and touch-target checks cannot run."
      );
    }
    throw e;
  }
}

export async function iosDeviceInfo(udid) {
  assertMac();
  const out = await run("xcrun", ["simctl", "list", "devices", "--json"]);
  const data = JSON.parse(out);
  for (const [runtime, list] of Object.entries(data.devices ?? {})) {
    const d = list.find((x) => x.udid === udid);
    if (d) {
      return {
        model: d.name,
        release: runtime.replace("com.apple.CoreSimulator.SimRuntime.iOS-", "").replace(/-/g, "."),
        state: d.state,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// App launcher
// ---------------------------------------------------------------------------

/**
 * Installed apps on an Android device.
 * `pm list packages -3` = user-installed only (the apps people actually test).
 * With includeSystem, everything is listed and system packages are marked so the
 * UI can sort the noise (com.android.*) to the bottom.
 */
export function parseAndroidPackageList(out) {
  return out.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length).trim())
    .filter(Boolean);
}

export async function listAndroidApps(deviceId, { includeSystem = false } = {}) {
  const args = deviceId ? ["-s", deviceId] : [];
  const parse = parseAndroidPackageList;

  const user = new Set(parse(await run("adb", [...args, "shell", "pm", "list", "packages", "-3"])));
  let all = user;
  if (includeSystem) {
    all = new Set(parse(await run("adb", [...args, "shell", "pm", "list", "packages"])));
  }

  return [...all]
    .map((pkg) => ({ id: pkg, name: pkg, kind: user.has(pkg) ? "user" : "system" }))
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "user" ? -1 : 1));
}

/**
 * Launch an Android app by package name via monkey with the LAUNCHER category —
 * the one launch method that needs no activity name and works on every API level.
 */
export async function launchAndroidApp(deviceId, pkg) {
  if (!/^[\w.]+$/.test(String(pkg))) throw new Error(`Invalid package name: ${pkg}`);
  const args = deviceId ? ["-s", deviceId] : [];
  const out = await run("adb", [...args, "shell", "monkey", "-p", pkg,
                                "-c", "android.intent.category.LAUNCHER", "1"]);
  if (/no activities found/i.test(out) || /aborted/i.test(out)) {
    throw new Error(`Could not launch ${pkg} — it has no launcher activity, or the package name is wrong.`);
  }
  return { launched: true, app: pkg };
}

/**
 * Installed apps on an iOS simulator.
 * `simctl listapps` prints an OLD-STYLE plist (not JSON, and simctl has no JSON
 * flag for this subcommand), so this parses it line by line: `key = value;`
 * pairs accumulate into a block, and a block is committed when its closing `};`
 * arrives. Good enough because the three keys we need are always flat scalars.
 */
export function parseIosAppList(out) {
  const apps = [];
  let current = {};
  for (const line of out.split("\n")) {
    const kv = /^\s*(\w+)\s*=\s*(.+?);\s*$/.exec(line);
    if (kv) {
      current[kv[1]] = kv[2].replace(/^"|"$/g, "");
      continue;
    }
    if (/^\s*};\s*$/.test(line)) {
      if (current.CFBundleIdentifier) {
        apps.push({
          id: current.CFBundleIdentifier,
          name: current.CFBundleDisplayName || current.CFBundleName || current.CFBundleIdentifier,
          kind: current.ApplicationType === "User" ? "user" : "system",
        });
      }
      current = {};
    }
  }
  return apps;
}

export async function listIosApps(udid, { includeSystem = false } = {}) {
  assertMac();
  const out = await run("xcrun", ["simctl", "listapps", udid]);
  return parseIosAppList(out)
    .filter((a) => includeSystem || a.kind === "user")
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "user" ? -1 : 1));
}

export async function launchIosApp(udid, bundleId) {
  assertMac();
  if (!/^[\w.\-]+$/.test(String(bundleId))) throw new Error(`Invalid bundle id: ${bundleId}`);
  await run("xcrun", ["simctl", "launch", udid, bundleId]);
  return { launched: true, app: bundleId };
}

// ---------------------------------------------------------------------------
export async function listAllDevices() {
  const out = { android: [], ios: [], errors: [] };

  try {
    out.android = [...(await listAndroidDevices()), ...(await listAndroidEmulators())];
  } catch (e) {
    out.errors.push({ platform: "android", message: e.hint ?? String(e.message ?? e) });
  }

  if (isMac) {
    try {
      out.ios = await listIosSimulators();
    } catch (e) {
      out.errors.push({ platform: "ios", message: e.hint ?? String(e.message ?? e) });
    }
  } else {
    out.errors.push({
      platform: "ios",
      message: "iOS scanning requires macOS with Xcode. The iOS Simulator does not exist on this platform.",
    });
  }

  return out;
}
