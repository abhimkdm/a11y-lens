import { create } from "zustand";

export type Severity = "critical" | "serious" | "moderate" | "minor";

export interface ViolationNode { target: string; html: string; failureSummary: string }
export interface Violation {
  id: string; impact: Severity; description: string; help: string;
  helpUrl: string; wcag: string[]; nodes: ViolationNode[];
}
export interface AiFix {
  rule: string; impact: Severity; title: string; explanation: string;
  html: string; react: string; angular: string;
}
export interface AiReport {
  executiveSummary: string; businessImpact: string;
  fixes: AiFix[]; quickWins: string[];
  generatedAt: string; provider: string;
}
export interface ScanResult {
  url: string; title: string; timestamp: string; score: number;
  counts: Record<Severity, number>;
  violations: Violation[];
  screenshot?: string;
  keyboardFindings?: { type: string; target: string; html: string }[];
  pages?: { url: string; title: string; score: number; violationRuleCount: number }[];
  aiReport?: AiReport;
}

interface AppState {
  sessionOpen: boolean;
  scanning: "idle" | "quick" | "full" | "keyboard";
  currentScan: ScanResult | null;
  history: ScanResult[];
  ignored: Record<string, { reason: string; expiry?: string }>;
  aiProvider: { provider: string; model: string; apiKey: string };
  setSessionOpen: (v: boolean) => void;
  setScanning: (v: AppState["scanning"]) => void;
  setScan: (r: ScanResult) => void;
  attachAiReport: (rep: AiReport) => void;
  ignoreRule: (ruleId: string, reason: string, expiry?: string) => void;
  unignoreRule: (ruleId: string) => void;
  setAiProvider: (p: Partial<AppState["aiProvider"]>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sessionOpen: false,
  scanning: "idle",
  currentScan: null,
  history: [],
  ignored: {},
  aiProvider: { provider: "ollama", model: "llama3.1", apiKey: "" },
  setSessionOpen: (v) => set({ sessionOpen: v }),
  setScanning: (v) => set({ scanning: v }),
  setScan: (r) => set((s) => ({ currentScan: r, history: [r, ...s.history].slice(0, 50) })),
  attachAiReport: (rep) =>
    set((s) => {
      if (!s.currentScan) return {};
      const updated = { ...s.currentScan, aiReport: rep };
      return { currentScan: updated, history: [updated, ...s.history.slice(1)] };
    }),
  ignoreRule: (ruleId, reason, expiry) =>
    set((s) => ({ ignored: { ...s.ignored, [ruleId]: { reason, expiry } } })),
  unignoreRule: (ruleId) =>
    set((s) => { const i = { ...s.ignored }; delete i[ruleId]; return { ignored: i }; }),
  setAiProvider: (p) => set((s) => ({ aiProvider: { ...s.aiProvider, ...p } })),
}));
