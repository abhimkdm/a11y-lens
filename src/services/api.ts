// Bridge to the Node.js sidecar (Playwright + axe-core).
const BASE = "http://localhost:8787";

// "TypeError: Failed to fetch" from the browser gives no useful detail —
// translate it into something actionable before it reaches the UI.
async function req(url: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return {
      ok: false,
      error: "Can't reach the automation sidecar at localhost:8787. Start it with `npm run sidecar` in a separate terminal, then try again.",
    };
  }
  return res.json();
}

export const api = {
  openSession: (url?: string) =>
    req(`${BASE}/session/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  status: () => req(`${BASE}/session/status`),

  recordStart: () => req(`${BASE}/record/start`, { method: "POST" }),
  recordStop: () => req(`${BASE}/record/stop`, { method: "POST" }),
  recordStatus: () => req(`${BASE}/record/status`),
  quickScan: () => req(`${BASE}/scan/quick`, { method: "POST" }),
  keyboardScan: () => req(`${BASE}/scan/keyboard`, { method: "POST" }),

  showOverlay: (violations: unknown[]) =>
    req(`${BASE}/overlay/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ violations }),
    }),

  clearOverlay: () => req(`${BASE}/overlay/clear`, { method: "POST" }),

  showToolbar: () => req(`${BASE}/toolbar/show`, { method: "POST" }),
  hideToolbar: () => req(`${BASE}/toolbar/hide`, { method: "POST" }),

  fullScanStart: (
    maxPages: number,
    ai: { provider: string; model: string; apiKey: string; baseUrl?: string },
    urlList?: string[]
  ) =>
    req(`${BASE}/scan/full/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPages, ai, urlList }),
    }),

  fullScanStatus: () => req(`${BASE}/scan/full/status`),

  fullScanStop: () => req(`${BASE}/scan/full/stop`, { method: "POST" }),

  aiReport: (scan: unknown, ai: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    req(`${BASE}/report/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan, ai }),
    }),

  listSessions: () => req(`${BASE}/sessions`),
  getSession: (id: number) => req(`${BASE}/sessions/${id}`),
  saveSession: (scan: unknown) =>
    req(`${BASE}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan }),
    }),
  updateSession: (id: number, scan: unknown) =>
    req(`${BASE}/sessions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan }),
    }),

  exportFile: (filename: string, content: string) =>
    req(`${BASE}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content }),
    }),

  deleteSession: (id: number) =>
    req(`${BASE}/sessions/${id}`, { method: "DELETE" }),
  importSession: (scan: unknown) =>
    req(`${BASE}/sessions/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan }),
    }),
  compare: (prevId: number, currId: number) =>
    req(`${BASE}/compare`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prevId, currId }),
    }),

  expertAudit: (
    ai: { provider: string; model: string; apiKey: string; baseUrl?: string },
    axeViolations: unknown[],
    opts: {
      scope?: "main" | "chrome" | "all";
      probes?: boolean;
      keyboardWalk?: boolean;
      mode?: "single" | "cross-check";
    } = {}
  ) =>
    req(`${BASE}/audit/expert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ai,
        axeViolations,
        scope: opts.scope ?? "main",
        probes: opts.probes !== false,
        keyboardWalk: opts.keyboardWalk !== false,
        mode: opts.mode ?? "single",
      }),
    }),

  getCrossCheckSettings: () => req(`${BASE}/settings/ai/crosscheck`),
  saveCrossCheckSettings: (cfg: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    req(`${BASE}/settings/ai/crosscheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),

  getAiSettings: () => req(`${BASE}/settings/ai`),
  getAiProviderDefaults: () => req(`${BASE}/settings/ai/providers`),
  testAiConnection: (cfg: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    req(`${BASE}/settings/ai/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  saveAiSettings: (cfg: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    req(`${BASE}/settings/ai`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  getSecurity: () => req(`${BASE}/settings/security`),
  saveSecurity: (cfg: { localOnly?: boolean; masking?: boolean; storeScreenshots?: boolean }) =>
    req(`${BASE}/settings/security`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  auditLog: () => req(`${BASE}/audit`),
};
