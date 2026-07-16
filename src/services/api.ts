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

// The packaged app spawns the sidecar at launch, but Node + Express take a
// moment to bind the port. Without waiting, the first render races the boot and
// every screen shows "can't reach the sidecar" for a second or two — which is
// indistinguishable from a real failure.
export async function waitForSidecar(timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/session/status`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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
    urlList?: string[],
    interaction?: { interact: boolean; allowMutations: boolean; valueProfile?: unknown }
  ) =>
    req(`${BASE}/scan/full/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxPages, ai, urlList,
        interact: interaction?.interact ?? false,
        allowMutations: interaction?.allowMutations ?? false,
        valueProfile: interaction?.valueProfile ?? null,
      }),
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

  siteReport: (scan: unknown, ai: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    req(`${BASE}/report/site`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan, ai }),
    }),

  // --- Mobile scanner (separate engine from the web scanner) ---
  mobileToolchain: () => req(`${BASE}/mobile/toolchain`),
  mobileDevices: () => req(`${BASE}/mobile/devices`),
  mobileBoot: (platform: "android" | "ios", id: string) =>
    req(`${BASE}/mobile/boot`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, id }),
    }),
  mobileScan: (
    platform: "android" | "ios",
    deviceId: string,
    ai: { provider: string; model: string; apiKey: string; baseUrl?: string },
    aiReview = true
  ) =>
    req(`${BASE}/mobile/scan`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, deviceId, ai, aiReview }),
    }),

  mobileApps: (platform: "android" | "ios", deviceId: string, includeSystem = false) =>
    req(`${BASE}/mobile/apps?platform=${platform}&deviceId=${encodeURIComponent(deviceId)}&all=${includeSystem ? 1 : 0}`),
  mobileLaunch: (platform: "android" | "ios", deviceId: string, appId: string) =>
    req(`${BASE}/mobile/launch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, deviceId, appId }),
    }),

  mobileFlowStatus: () => req(`${BASE}/mobile/flow/status`),
  mobileFlowStart: (platform: "android" | "ios", deviceId: string, name: string) =>
    req(`${BASE}/mobile/flow/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, deviceId, name }),
    }),
  mobileFlowStep: (
    ai: { provider: string; model: string; apiKey: string; baseUrl?: string },
    label: string,
    aiReview = true
  ) =>
    req(`${BASE}/mobile/flow/step`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai, label, aiReview }),
    }),
  mobileFlowStop: () => req(`${BASE}/mobile/flow/stop`, { method: "POST" }),
  mobileFlowCancel: () => req(`${BASE}/mobile/flow/cancel`, { method: "POST" }),

  mobileReportHtml: (result: unknown, filename?: string) =>
    req(`${BASE}/mobile/report/html`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, filename }),
    }),

  mobileAiUsageReportHtml: (result: unknown, filename?: string) =>
    req(`${BASE}/mobile/report/ai-usage/html`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, filename }),
    }),

  browserStatus: () => req(`${BASE}/browser/status`),
  browserInstall: () => req(`${BASE}/browser/install`, { method: "POST" }),
  browserInstallStatus: () => req(`${BASE}/browser/install/status`),

  crawlStart: (opts: {
    source: "crawl" | "sitemap" | "list";
    rootUrl?: string; sitemapUrl?: string; urls?: string[];
    name?: string; maxPages?: number; maxDepth?: number;
  }) =>
    req(`${BASE}/crawl/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  crawlStatus: () => req(`${BASE}/crawl/status`),
  crawlStop: () => req(`${BASE}/crawl/stop`, { method: "POST" }),
  crawlList: () => req(`${BASE}/crawls`),
  crawlGet: (id: number) => req(`${BASE}/crawls/${id}`),
  crawlDelete: (id: number) => req(`${BASE}/crawls/${id}`, { method: "DELETE" }),
  crawlSetEnabled: (id: number, urls: string[], enabled: boolean) =>
    req(`${BASE}/crawls/${id}/urls`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, enabled }),
    }),
  crawlRecrawl: (id: number, urls?: string[]) =>
    req(`${BASE}/crawls/${id}/recrawl`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    }),
  crawlExport: (id: number) => req(`${BASE}/crawls/${id}/export`),
  crawlImport: (config: unknown) =>
    req(`${BASE}/crawls/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),

  getLogs: (limit = 200) => req(`${BASE}/logs?limit=${limit}`),
  clearLogs: () => req(`${BASE}/logs`, { method: "DELETE" }),
  logToServer: (entry: { level: string; source: string; message: string; detail?: string; context?: unknown }) =>
    req(`${BASE}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    }),
};
