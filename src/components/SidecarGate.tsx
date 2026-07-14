import { useCallback, useEffect, useState } from "react";
import { Box, Stack, Typography, CircularProgress, Button, Alert } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { waitForSidecar } from "../services/api";

// Blocks the app until the automation sidecar is actually listening.
//
// In the packaged app Tauri spawns the sidecar at launch, but Node needs a
// second or two to bind :8787. Rendering the UI immediately means every screen
// flashes "can't reach the sidecar" — a real failure and a normal cold start
// look identical. This gate tells them apart.
export default function SidecarGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"booting" | "ready" | "failed">("booting");
  const [detail, setDetail] = useState("");

  const boot = useCallback(async () => {
    setState("booting");
    const ok = await waitForSidecar(30000);
    if (ok) { setState("ready"); return; }
    // Ask Rust what the sidecar actually said on its way down. "Couldn't reach it"
    // is not a diagnosis; the child's stderr usually is.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const err = await invoke<string>("sidecar_last_error");
      setDetail((err || "").trim());
    } catch {
      setDetail("");
    }
    setState("failed");
  }, []);

  useEffect(() => { boot(); }, [boot]);

  const retry = async () => {
    setState("booting");
    // In the packaged app, ask Tauri to respawn the sidecar process. In browser
    // dev mode this import simply isn't available, so we just re-poll.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_sidecar");
    } catch {
      // not running under Tauri — nothing to restart, just retry the poll
    }
    boot();
  };

  if (state === "ready") return <>{children}</>;

  return (
    <Box sx={{ display: "grid", placeItems: "center", height: "100vh", p: 4 }}>
      {state === "booting" ? (
        <Stack spacing={2} alignItems="center">
          <CircularProgress />
          <Typography variant="h6">Starting the automation engine…</Typography>
          <Typography variant="body2" color="text.secondary">
            Launching the local scanning service. This usually takes a few seconds.
          </Typography>
        </Stack>
      ) : (
        <Stack spacing={2} alignItems="center" sx={{ maxWidth: 520 }}>
          <Typography variant="h6">The automation engine didn't start</Typography>
          <Alert severity="error" sx={{ width: "100%" }}>
            A11y Lens couldn't reach its scanning service on localhost:8787.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            A11y Lens tried three times, clearing any orphaned service between attempts. Common causes:
            the browser engine isn't installed yet (<code>npx playwright install chromium</code>), or
            another program is holding port 8787. If you're running from source, start it with{" "}
            <code>npm run sidecar</code> in a separate terminal.
          </Typography>

          {detail && (
            <Box sx={{ width: "100%" }}>
              <Typography variant="overline">What the service reported</Typography>
              <Box component="pre" sx={{
                m: 0, mt: 0.5, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
                border: "1px solid rgba(154,167,180,0.2)", fontSize: 12,
                fontFamily: "IBM Plex Mono, monospace", whiteSpace: "pre-wrap",
                maxHeight: 180, overflow: "auto", color: "#FFB0B0",
              }}>{detail}</Box>
            </Box>
          )}
          <Button variant="contained" startIcon={<RefreshIcon />} onClick={retry}>
            Retry
          </Button>
        </Stack>
      )}
    </Box>
  );
}
