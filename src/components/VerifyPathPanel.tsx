import { useEffect, useRef, useState } from "react";
import { Paper, Stack, Typography, Button, Chip, LinearProgress, Box, Collapse } from "@mui/material";
import PlaylistAddCheckIcon from "@mui/icons-material/PlaylistAddCheck";
import { api } from "../services/api";

// The reproduce-only ("Verify path") result. Mirrors replayAll()'s summary in
// sidecar/replay.mjs: it dry-runs the recorded actions WITHOUT scanning, so QA
// can confirm the journey still works and see how fragile it is before spending
// a full AI scan on it.
type Tiers = Record<string, number>;
type Smell = { i: number; type: string; name: string };
type Summary = {
  executed: number;
  skipped: number;
  smells: Smell[];
  failedAt: { i: number; type: string; error: string } | null;
  tiers: Tiers;
};

// Tiers that mean the element was found by something stable AND accessible.
const STABLE = ["testid", "role", "label", "placeholder", "text"];
const TIER_LABEL: Record<string, string> = {
  testid: "data-testid", role: "role + name", label: "label", placeholder: "placeholder",
  text: "text", css: "CSS path", xpath: "XPath", navigate: "navigate", masked: "masked", keyboard: "keyboard",
};

export default function VerifyPathPanel({
  sessionOpen, source, busy, onError,
}: {
  sessionOpen: boolean;
  source: "current" | "imported";
  busy?: boolean;
  onError?: (msg: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lastLog, setLastLog] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const verify = async () => {
    setSummary(null); setLogLines([]); setLastLog("");
    const r = await api.replayStart({ scan: false, source }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { onError?.(r.error ?? "Could not start verification."); return; }
    setRunning(true);
    pollRef.current = window.setInterval(async () => {
      const st = await api.replayStatus().catch(() => null);
      if (!st || st.mode !== "reproduce") return;
      if (Array.isArray(st.log) && st.log.length) {
        setLogLines(st.log.map((l: { msg: string }) => l.msg));
        setLastLog(st.log[st.log.length - 1].msg);
      }
      if (!st.running) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setRunning(false);
        if (st.error) onError?.(st.error);
        if (st.summary) setSummary(st.summary as Summary);
      }
    }, 800);
  };

  const xpathCount = summary?.tiers?.xpath ?? 0;

  return (
    <Box sx={{ mt: 2 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button variant="outlined" size="small" startIcon={<PlaylistAddCheckIcon />}
                disabled={!sessionOpen || running || busy} onClick={verify}>
          {running ? "Verifying…" : "Verify path"}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Dry-run the recorded actions (no scan) to confirm the path still works and see how fragile it is.
        </Typography>
      </Stack>

      {running && (
        <Box sx={{ mt: 1.5 }}>
          <LinearProgress />
          {lastLog && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block", fontFamily: "monospace" }}>
              {lastLog}
            </Typography>
          )}
        </Box>
      )}

      {summary && (
        <Paper variant="outlined" sx={{ p: 2, mt: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {summary.failedAt ? (
              <Chip size="small" color="error" label={`Broke at step ${summary.failedAt.i} (${summary.failedAt.type})`} />
            ) : (
              <Chip size="small" color="success" label="Path replayed cleanly" />
            )}
            <Chip size="small" variant="outlined" label={`${summary.executed} executed`} />
            {summary.skipped > 0 && (
              <Chip size="small" variant="outlined" label={`${summary.skipped} skipped (masked / uploads)`} />
            )}
          </Stack>

          {summary.failedAt && (
            <Typography variant="body2" color="error" sx={{ mt: 1 }}>
              {summary.failedAt.error}
            </Typography>
          )}

          <Typography variant="overline" sx={{ mt: 2, display: "block" }}>How each control was found</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
            {Object.entries(summary.tiers)
              .filter(([k]) => k !== "navigate" && k !== "masked" && k !== "keyboard")
              .sort((a, b) => b[1] - a[1])
              .map(([tier, n]) => (
                <Chip
                  key={tier}
                  size="small"
                  color={tier === "xpath" ? "error" : tier === "css" ? "warning" : STABLE.includes(tier) ? "success" : "default"}
                  variant={STABLE.includes(tier) ? "filled" : "outlined"}
                  label={`${TIER_LABEL[tier] ?? tier} · ${n}`}
                />
              ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            Green tiers are stable and accessible. XPath means the control had no role, name, label, or test id — brittle to
            automate and invisible to assistive tech.
          </Typography>

          {xpathCount > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="overline" sx={{ display: "block", color: "warning.main" }}>
                {summary.smells.length} control{summary.smells.length === 1 ? "" : "s"} only reachable by XPath — accessibility smell
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Each is reported as WCAG 4.1.2 (Name, Role, Value) in a scan.
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {summary.smells.map((s) => (
                  <Stack key={s.i} direction="row" spacing={1} alignItems="center">
                    <Chip size="small" color="warning" variant="outlined" label="4.1.2" />
                    <Typography variant="body2">
                      {s.type} on {s.name ? <b>{s.name}</b> : <i>(no accessible name)</i>}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}

          {logLines.length > 0 && (
            <>
              <Button size="small" sx={{ mt: 1.5 }} onClick={() => setShowLog((v) => !v)}>
                {showLog ? "Hide" : "Show"} replay log
              </Button>
              <Collapse in={showLog}>
                <Box sx={{ mt: 1, p: 1, bgcolor: "action.hover", borderRadius: 1, maxHeight: 180, overflow: "auto" }}>
                  {logLines.map((l, i) => (
                    <Typography key={i} variant="caption" component="div" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                      {l}
                    </Typography>
                  ))}
                </Box>
              </Collapse>
            </>
          )}
        </Paper>
      )}
    </Box>
  );
}
