// A11y Lens security layer (Phase 15).
//
// 1. API-key vault: AES-256-GCM encryption at rest. The data key lives in
//    ~/.a11y-lens/.keyfile with 0600 permissions. In the packaged desktop
//    build this can be upgraded to the OS keychain via Tauri's keyring
//    plugin without changing this module's interface.
// 2. Sensitive-data masking: scrubs emails, card-like numbers, SSN-like
//    ids, bearer tokens, and password-field values from scan payloads
//    before they are persisted or sent to an AI provider.
// 3. Local processing mode: when enabled, only localhost providers
//    (Ollama) are allowed — nothing leaves the machine.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.A11Y_DATA_DIR || join(homedir(), ".a11y-lens");
mkdirSync(dir, { recursive: true });
const keyPath = join(dir, ".keyfile");

function dataKey() {
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, randomBytes(32));
    chmodSync(keyPath, 0o600);
  }
  return readFileSync(keyPath);
}

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(blob) {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ---- masking -----------------------------------------------------------
const MASKS = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[card-number]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\b(?:bearer|token|apikey|api_key|secret)[=:\s"']+[\w.\-]{8,}/gi, "[token]"],
  [/(value\s*=\s*")[^"]+("[^>]*type\s*=\s*"password")/gi, "$1[masked]$2"],
  [/(type\s*=\s*"password"[^>]*value\s*=\s*")[^"]+(")/gi, "$1[masked]$2"],
];

export function maskText(text) {
  let t = String(text);
  for (const [re, rep] of MASKS) t = t.replace(re, rep);
  return t;
}

export function maskScan(scan) {
  const clone = JSON.parse(JSON.stringify(scan));
  for (const v of clone.violations ?? [])
    for (const n of v.nodes ?? []) {
      if (n.html) n.html = maskText(n.html);
      if (n.failureSummary) n.failureSummary = maskText(n.failureSummary);
    }
  delete clone.screenshot; // screenshots can contain anything on screen
  return clone;
}

// ---- local processing enforcement ---------------------------------------
export function assertProviderAllowed(provider, localOnly) {
  if (localOnly && provider !== "ollama")
    throw new Error(
      `Local processing mode is on — provider "${provider}" is blocked. Use Ollama or disable local-only mode in Settings.`
    );
}
