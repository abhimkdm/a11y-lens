import { Box, Stack, Typography, LinearProgress } from "@mui/material";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import VerifiedUserIcon from "@mui/icons-material/VerifiedUser";
import TouchAppIcon from "@mui/icons-material/TouchApp";
import VisibilityIcon from "@mui/icons-material/Visibility";
import LayersIcon from "@mui/icons-material/Layers";
import type { ReactNode } from "react";

// Live "agents at work" panel shown during a Full / AI Full scan. It is driven
// by the REAL scan status log — each agent lights up when its own work shows up
// in the log — so the animation reflects what the pipeline is actually doing,
// not a decorative loop. Only the agents that this run enabled are shown.

type Log = { msg: string };

type AgentKey = "crawler" | "axe" | "interact" | "reviewer" | "dedupe";

const AGENTS: { key: AgentKey; label: string; color: string; icon: ReactNode; re: RegExp }[] = [
  { key: "crawler",  label: "Crawler",     color: "#38bdf8", icon: <TravelExploreIcon fontSize="small" />, re: /scanning:|exploring|navigat|checkpoint|page \d/i },
  { key: "axe",      label: "axe-core",    color: "#34d399", icon: <VerifiedUserIcon fontSize="small" />,  re: /scanning:|scanned|violation|axe/i },
  { key: "interact", label: "Interaction", color: "#fbbf24", icon: <TouchAppIcon fontSize="small" />,      re: /interaction pass|found \d+ candidate|could not activate|interaction:|operate gear|opening/i },
  { key: "reviewer", label: "AI Reviewer", color: "#a78bfa", icon: <VisibilityIcon fontSize="small" />,    re: /ai audit|ai review|ai expert|auditing/i },
  { key: "dedupe",   label: "Dedupe",      color: "#fb7185", icon: <LayersIcon fontSize="small" />,        re: /dedup|grouping|merg(e|ing) finding|clustered/i },
];

// Strip terminal colour codes that leak into log lines (…Call log: ␛[2m - waiting).
function clean(msg: string) {
  return msg.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[\d+m/g, "").trim();
}

// The most recent log line decides which agent holds the "spotlight" (pulses).
// Priority within a single line prefers the later, more notable pipeline stage.
function spotlight(logs: Log[]): AgentKey | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i]?.msg ?? "";
    for (const key of ["dedupe", "reviewer", "interact", "axe"] as AgentKey[]) {
      const a = AGENTS.find((x) => x.key === key)!;
      if (a.re.test(m)) return key;
    }
  }
  return null;
}

export default function AgentActivityPanel({
  pages, logs, currentUrl, aiAudit, interact, total,
}: {
  pages: number;
  logs: Log[];
  currentUrl: string | null;
  aiAudit: boolean;
  interact: boolean;
  total?: number | null;
}) {
  // Which agents are actually part of THIS run.
  const enabled = new Set<AgentKey>(["crawler", "axe"]);
  if (interact) enabled.add("interact");
  if (aiAudit) { enabled.add("reviewer"); enabled.add("dedupe"); }
  const shown = AGENTS.filter((a) => enabled.has(a.key));

  const active = spotlight(logs) ?? "axe"; // page-scan is the baseline activity
  const latest = logs.length ? clean(logs[logs.length - 1].msg) : "Starting…";
  const determinate = typeof total === "number" && total > 0;
  const pct = determinate ? Math.min(100, Math.round((pages / (total as number)) * 100)) : 0;

  return (
    <Box
      sx={{
        mt: 2, p: 2.5, borderRadius: 2,
        background: "linear-gradient(180deg,#0b1220 0%,#080b14 100%)",
        border: "1px solid rgba(154,167,180,0.14)",
        // shared keyframes
        "@keyframes a11yPulse": {
          "0%": { transform: "scale(1)", opacity: 0.65 },
          "70%": { transform: "scale(1.7)", opacity: 0 },
          "100%": { opacity: 0 },
        },
        "@keyframes a11yFlow": {
          "0%": { left: "-10%", opacity: 0 },
          "25%": { opacity: 1 },
          "75%": { opacity: 1 },
          "100%": { left: "110%", opacity: 0 },
        },
      }}
    >
      <Typography variant="overline" sx={{ color: "text.secondary", letterSpacing: 2 }}>
        Agents at work
      </Typography>

      {/* agent constellation. NOTE: overflowX:auto also clips the Y axis, so the
          active orb's pulse ring + glow would get cut off — pt/pb/px give the
          animation room to expand into (padding is inside the clip box). */}
      <Stack direction="row" alignItems="flex-start" spacing={0} sx={{ mt: 1, overflowX: "auto", pt: 3, pb: 1.5, px: 1.5 }}>
        {shown.map((a, idx) => {
          const isActive = a.key === active;
          return (
            <Stack key={a.key} direction="row" alignItems="center" sx={{ flex: "0 0 auto" }}>
              <Box sx={{ textAlign: "center", minWidth: 92 }}>
                <Box sx={{ position: "relative", width: 56, height: 56, mx: "auto" }}>
                  {isActive && (
                    <Box sx={{
                      position: "absolute", inset: 0, borderRadius: "50%",
                      border: `2px solid ${a.color}`, animation: "a11yPulse 1.4s ease-out infinite",
                    }} />
                  )}
                  <Box sx={{
                    position: "absolute", inset: 5, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#04121a",
                    background: `radial-gradient(circle at 35% 30%, #ffffffcc, ${a.color} 55%, ${a.color}99)`,
                    boxShadow: isActive ? `0 0 20px ${a.color}bb` : "none",
                    opacity: isActive ? 1 : 0.8,
                    transition: "opacity .3s, box-shadow .3s",
                  }}>
                    {a.icon}
                  </Box>
                </Box>
                <Typography variant="caption" sx={{
                  display: "block", mt: 0.75, fontWeight: isActive ? 700 : 500,
                  color: isActive ? "text.primary" : "text.secondary",
                }}>
                  {a.label}
                </Typography>
                <Typography variant="caption" sx={{ fontSize: 10, color: isActive ? a.color : "text.disabled" }}>
                  {isActive ? "working…" : "on"}
                </Typography>
              </Box>

              {/* connector with a flowing pulse toward the next agent */}
              {idx < shown.length - 1 && (
                <Box sx={{ position: "relative", width: 46, height: 2, mt: -2.5, mx: -0.5,
                  background: "rgba(154,167,180,0.25)", overflow: "hidden", borderRadius: 1 }}>
                  <Box sx={{
                    position: "absolute", top: -1.5, width: 8, height: 5, borderRadius: 3,
                    background: a.color, filter: "blur(1px)",
                    animation: "a11yFlow 1.8s linear infinite", animationDelay: `${idx * 0.25}s`,
                  }} />
                </Box>
              )}
            </Stack>
          );
        })}
      </Stack>

      {/* progress + current activity */}
      <Box sx={{ mt: 1.5 }}>
        <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {determinate ? `${pages} / ${total} checkpoints scanned` : `${pages} page${pages === 1 ? "" : "s"} scanned`}
          </Typography>
          {determinate && <Typography variant="caption" color="text.secondary">{pct}%</Typography>}
        </Stack>
        <LinearProgress
          variant={determinate ? "determinate" : "indeterminate"}
          value={pct}
          sx={{ height: 6, borderRadius: 3 }}
        />
      </Box>

      {currentUrl && (
        <Typography variant="body2" noWrap color="primary" sx={{ mt: 1.5 }}>{currentUrl}</Typography>
      )}
      <Typography variant="caption" sx={{ display: "block", mt: 0.5, fontFamily: "monospace", color: "text.secondary" }} noWrap>
        {latest}
      </Typography>
    </Box>
  );
}
