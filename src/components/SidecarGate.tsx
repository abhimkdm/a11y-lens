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

  const boot = useCallback(async () => {
    setState("booting");
    const ok = await waitForSidecar(20000);
    setState(ok ? "ready" : "failed");
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
            Most common causes: another copy of A11y Lens is already running and holding the port,
            or the browser engine hasn't been installed yet
            (<code>npx playwright install chromium</code>). If you're running from source, start it
            with <code>npm run sidecar</code> in a separate terminal.
          </Typography>
          <Button variant="contained" startIcon={<RefreshIcon />} onClick={retry}>
            Retry
          </Button>
        </Stack>
      )}
    </Box>
  );
}
