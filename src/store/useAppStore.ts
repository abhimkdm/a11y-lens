import { create } from "zustand";

export type Severity = "critical" | "serious" | "moderate" | "minor";

export interface ViolationNode {
  target: string;
  html: string;
  failureSummary: string;
  screenshot?: string | null;              // base64 JPEG of the failing element, highlighted
  screenshotSkipped?: "budget" | "not-found" | "capture-failed" | null;
  elementTiny?: boolean;                   // 0x0 / 1x1 element — a crop would be meaningless
}
export interface Violation {
  id: string; impact: Severity; description: string; help: string;
  helpUrl: string; wcag: string[]; nodes: ViolationNode[];
}
export interface AiFix {
  rule: string; impact: Severity; title: string; explanation: string;
  html: string; react: string; angular: string;
  selector?: string;
  evidence?: string;
  evidenceStatus?: "verified" | "unverified";
  scenario?: string | null;
  screenshot?: string | null;
  measured?: boolean;          // deterministic keyboard/focus probe — not an AI opinion
  wcag?: string[];
}
export interface AiReport {
  executiveSummary: string; businessImpact: string;
  fixes: AiFix[]; quickWins: string[];
  generatedAt: string; provider: string;
  evidence?: {
    scenarios: number; imagesUsed: number; verified: number; unverified: number;
    keyboardMeasured?: number; focusIndicatorsMissing?: number; focusableTraced?: number;
  };
}
export type Agreement = "consensus" | "confirmed" | "single" | "deterministic";
export interface ExpertFinding {
  zone: string; title: string; severity: Severity;
  description: string; userImpact: string; fix: string;
  evidence: string; wcag: string[];
  evidenceStatus: "verified" | "unverified";
  source?: "probe" | "ai";
  outOfScopeWcag?: string[];
  agreement?: Agreement;
  agreedBy?: string[];
  confidence?: number;
  adjudication?: { by: string; verdict: string; reason: string } | null;
}
export interface ExpertPass { zone: string; message: string }
export interface ExpertAudit {
  url: string; title: string; generatedAt: string; provider: string;
  findings: ExpertFinding[];
  passes: ExpertPass[];
  counts: Record<Severity, number>;
  durationMs?: number;
  scope?: string;
  mode?: "single" | "cross-check";
  agentA?: string;
  agentB?: string;
  cost?: { usd: number | null; inputTokens: number; outputTokens: number; note?: string; pricedAs?: string };
  stats: {
    total: number; verified: number; unverified: number;
    fromProbes?: number; fromAi?: number;
    suppressedRules: string[]; droppedAsScannerDuplicate: number;
    keyboardWalkSteps: number; domTruncated: boolean;
    ariaTreeAvailable: boolean; screenshotIncluded: boolean;
    focusProbeChecked?: number; focusProbeMissing?: number;
    standard?: string;
    wcagRemappedFrom22?: number;
    droppedOutOfWcag21Scope?: number;
    trusted?: number;
    needsReview?: number;
    agreementRate?: number;
    agentARaw?: number;
    agentBRaw?: number;
    tiers?: { deterministic: number; consensus: number; confirmed: number; single: number };
  };
}

export interface ScanResult {
  id?: number;                 // SQLite session id, set once persisted
  url: string; title: string; timestamp: string; score: number;
  counts: Record<Severity, number>;
  violations: Violation[];
  screenshot?: string;
  keyboardFindings?: { type: string; target: string; html: string }[];
  pages?: { url: string; title: string; score: number; violationRuleCount: number }[];
  aiReport?: AiReport;
  expertAudit?: ExpertAudit;
}

interface AppState {
  sessionOpen: boolean;
  scanning: "idle" | "quick" | "full" | "keyboard";
  currentScan: ScanResult | null;
  history: ScanResult[];
  ignored: Record<string, { reason: string; expiry?: string }>;
  aiProvider: { provider: string; model: string; apiKey: string; baseUrl: string };
  // A curated page set handed over from Crawl Explorer to Scan Center.
  pendingUrlList: string[] | null;
  applicationUrl: string;
  setSessionOpen: (v: boolean) => void;
  setScanning: (v: AppState["scanning"]) => void;
  setScan: (r: ScanResult) => void;
  setScanId: (id: number) => void;
  attachAiReport: (rep: AiReport) => void;
  attachExpertAudit: (a: ExpertAudit) => void;
  ignoreRule: (ruleId: string, reason: string, expiry?: string) => void;
  unignoreRule: (ruleId: string) => void;
  setAiProvider: (p: Partial<AppState["aiProvider"]>) => void;
  setPendingUrlList: (urls: string[] | null) => void;
  setApplicationUrl: (url: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sessionOpen: false,
  scanning: "idle",
  currentScan: null,
  history: [],
  ignored: {},
  aiProvider: { provider: "ollama", model: "llama3.1", apiKey: "", baseUrl: "" },
  pendingUrlList: null,
  applicationUrl: "https://",
  setSessionOpen: (v) => set({ sessionOpen: v }),
  setScanning: (v) => set({ scanning: v }),
  setScan: (r) => set((s) => ({ currentScan: r, history: [r, ...s.history].slice(0, 50) })),
  setScanId: (id) =>
    set((s) => {
      if (!s.currentScan) return {};
      const updated = { ...s.currentScan, id };
      return { currentScan: updated, history: [updated, ...s.history.slice(1)] };
    }),
  attachAiReport: (rep) =>
    set((s) => {
      if (!s.currentScan) return {};
      const updated = { ...s.currentScan, aiReport: rep };
      return { currentScan: updated, history: [updated, ...s.history.slice(1)] };
    }),
  attachExpertAudit: (a) =>
    set((s) => {
      if (!s.currentScan) return {};
      const updated = { ...s.currentScan, expertAudit: a };
      return { currentScan: updated, history: [updated, ...s.history.slice(1)] };
    }),
  ignoreRule: (ruleId, reason, expiry) =>
    set((s) => ({ ignored: { ...s.ignored, [ruleId]: { reason, expiry } } })),
  unignoreRule: (ruleId) =>
    set((s) => { const i = { ...s.ignored }; delete i[ruleId]; return { ignored: i }; }),
  setAiProvider: (p) => set((s) => ({ aiProvider: { ...s.aiProvider, ...p } })),
  setPendingUrlList: (urls) => set({ pendingUrlList: urls }),
  setApplicationUrl: (url) => set({ applicationUrl: url }),
}));
