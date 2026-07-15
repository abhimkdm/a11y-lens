import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Box, LinearProgress, Stack, Typography } from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { api } from "../services/api";

// Chromium (~150MB) genuinely cannot be packed into an installer. Telling the
// user to run `npx playwright install chromium` is useless — a QA tester with an
// MSI has no terminal and no Node. So the app installs its own browser, here,
// from a button.
export default function BrowserSetup() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const pollRef = useRef<number | null>(null);

  const check = useCallback(() => {
    api.browserStatus()
      .then((r) => { if (r.ok) { setInstalled(r.installed); setRunning(!!r.installing); } })
      .catch(() => {});
  }, []);

  useEffect(() => { check(); }, [check]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const install = async () => {
    setError(""); setRunning(true); setProgress("Starting download…");
    const r = await api.browserInstall().catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setRunning(false); setError(r.error ?? "Could not start the download"); return; }
    if (r.alreadyInstalled) { setRunning(false); setInstalled(true); return; }

    pollRef.current = window.setInterval(async () => {
      const st = await api.browserInstallStatus().catch(() => null);
      if (!st?.ok) return;
      setProgress(st.progress || "");
      setLog(st.log ?? []);
      if (!st.running) {
        if (pollRef.current) clearInterval(pollRef.current);
        setRunning(false);
        if (st.error) setError(st.error);
        if (st.done) setInstalled(true);
        check();
      }
    }, 1000);
  };

  // Installed, or we haven't checked yet — nothing to say.
  if (installed !== false) return null;

  return (
    <Alert severity={error ? "error" : "warning"} sx={{ mb: 2 }}
      action={
        !running && (
          <Button color="inherit" size="small" startIcon={<DownloadIcon />} onClick={install}>
            {error ? "Retry" : "Install now"}
          </Button>
        )
      }
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        The browser engine isn't installed yet
      </Typography>
      <Typography variant="body2">
        A11y Lens drives a real Chromium browser to test your pages. It's a one-time ~150&nbsp;MB
        download, and the app can fetch it for you — no terminal needed.
      </Typography>

      {running && (
        <Box sx={{ mt: 1.5 }}>
          <LinearProgress />
          <Typography variant="caption" sx={{ display: "block", mt: 0.75, fontFamily: "monospace" }}>
            {progress || "Downloading…"}
          </Typography>
        </Box>
      )}

      {error && (
        <Stack sx={{ mt: 1 }}>
          <Typography variant="body2">{error}</Typography>
          {log.length > 0 && (
            <Box component="pre" sx={{
              m: 0, mt: 1, p: 1, borderRadius: 1, bgcolor: "rgba(0,0,0,0.35)",
              fontSize: 11.5, fontFamily: "monospace", whiteSpace: "pre-wrap",
              maxHeight: 140, overflow: "auto",
            }}>{log.join("\n")}</Box>
          )}
          <Typography variant="caption" sx={{ mt: 0.5 }}>
            On a corporate network this download often needs a proxy. Set <code>HTTPS_PROXY</code>{" "}
            before launching, or install the browser manually with{" "}
            <code>npx playwright install chromium</code>.
          </Typography>
        </Stack>
      )}
    </Alert>
  );
}
