// Bridge to the Node.js sidecar (Playwright + axe-core).
const BASE = "http://localhost:8787";

export const api = {
  openSession: (url?: string) =>
    fetch(`${BASE}/session/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => r.json()),
  status: () => fetch(`${BASE}/session/status`).then((r) => r.json()),
  quickScan: () => fetch(`${BASE}/scan/quick`, { method: "POST" }).then((r) => r.json()),
  keyboardScan: () => fetch(`${BASE}/scan/keyboard`, { method: "POST" }).then((r) => r.json()),

  showOverlay: (violations: unknown[]) =>
    fetch(`${BASE}/overlay/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ violations }),
    }).then((r) => r.json()),

  clearOverlay: () => fetch(`${BASE}/overlay/clear`, { method: "POST" }).then((r) => r.json()),

  showToolbar: () => fetch(`${BASE}/toolbar/show`, { method: "POST" }).then((r) => r.json()),
  hideToolbar: () => fetch(`${BASE}/toolbar/hide`, { method: "POST" }).then((r) => r.json()),

  fullScanStart: (maxPages: number, ai: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    fetch(`${BASE}/scan/full/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPages, ai }),
    }).then((r) => r.json()),

  fullScanStatus: () => fetch(`${BASE}/scan/full/status`).then((r) => r.json()),

  fullScanStop: () => fetch(`${BASE}/scan/full/stop`, { method: "POST" }).then((r) => r.json()),

  aiReport: (scan: unknown, ai: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    fetch(`${BASE}/report/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan, ai }),
    }).then((r) => r.json()),

  listSessions: () => fetch(`${BASE}/sessions`).then((r) => r.json()),
  getSession: (id: number) => fetch(`${BASE}/sessions/${id}`).then((r) => r.json()),
  saveSession: (scan: unknown) =>
    fetch(`${BASE}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan }),
    }).then((r) => r.json()),
  deleteSession: (id: number) =>
    fetch(`${BASE}/sessions/${id}`, { method: "DELETE" }).then((r) => r.json()),
  importSession: (scan: unknown) =>
    fetch(`${BASE}/sessions/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan }),
    }).then((r) => r.json()),
  compare: (prevId: number, currId: number) =>
    fetch(`${BASE}/compare`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prevId, currId }),
    }).then((r) => r.json()),

  getAiSettings: () => fetch(`${BASE}/settings/ai`).then((r) => r.json()),
  saveAiSettings: (cfg: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    fetch(`${BASE}/settings/ai`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }).then((r) => r.json()),
  getSecurity: () => fetch(`${BASE}/settings/security`).then((r) => r.json()),
  saveSecurity: (cfg: { localOnly?: boolean; masking?: boolean }) =>
    fetch(`${BASE}/settings/security`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }).then((r) => r.json()),
  auditLog: () => fetch(`${BASE}/audit`).then((r) => r.json()),
};
