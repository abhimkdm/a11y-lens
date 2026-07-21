import { useEffect, useState } from "react";
import {
  Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography, Button, Alert, Box, LinearProgress,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { api } from "../services/api";

// Which browser a session runs in.
//
// The point of this control is not "more browsers" for its own sake — Chrome and
// Edge share an engine and will return almost identical rule findings. The value
// is Gecko and WebKit, whose accessibility trees and keyboard behaviour genuinely
// differ, so each engine's note explains what a run there does and does not prove.

export type BrowserInfo = {
  id: string; label: string; family: string; engine: string;
  install: "channel" | "download"; note: string | null;
  available: boolean;
};

export default function BrowserPicker({
  value, onChange, disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    api.browsers()
      .then((r) => { if (r?.ok) setBrowsers(r.browsers); })
      .catch(() => setError("Could not read the browser list — is the sidecar running?"));
  };
  useEffect(load, []);

  const selected = browsers.find((b) => b.id === value);

  const install = async (id: string) => {
    setError(""); setInstalling(true); setProgress("Starting download…");
    const r = await api.installBrowsers([id]).catch(() => null);
    if (!r?.ok) { setInstalling(false); setError("Could not start the download."); return; }
    const poll = window.setInterval(async () => {
      const st = await api.browserInstallStatus().catch(() => null);
      if (!st) return;
      setProgress(st.progress ?? "");
      if (!st.running) {
        clearInterval(poll); setInstalling(false);
        if (st.error) setError(st.error); else load();
      }
    }, 1200);
  };

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.75 }}>
        Browser engine
      </Typography>

      <ToggleButtonGroup
        exclusive size="small" value={value} disabled={disabled}
        onChange={(_e, v) => v && onChange(v)}
        sx={{ flexWrap: "wrap" }}
      >
        {browsers.map((b) => (
          <Tooltip
            key={b.id}
            title={
              <>
                <b>{b.label}</b> — {b.family}
                {b.note ? <><br />{b.note}</> : null}
                {!b.available ? <><br /><i>Engine not installed yet.</i></> : null}
              </>
            }
          >
            <span>
              <ToggleButton value={b.id} disabled={disabled || !b.available} sx={{ textTransform: "none", px: 1.5 }}>
                {b.label}
              </ToggleButton>
            </span>
          </Tooltip>
        ))}
      </ToggleButtonGroup>

      {selected && !selected.available && (
        <Alert
          severity="info" sx={{ mt: 1.5 }}
          action={
            <Button size="small" startIcon={<DownloadIcon />} disabled={installing}
                    onClick={() => install(selected.id)}>
              {installing ? "Downloading…" : `Install ${selected.engine}`}
            </Button>
          }
        >
          {selected.label} needs the <b>{selected.engine}</b> engine, which isn't downloaded yet.
        </Alert>
      )}

      {installing && (
        <Box sx={{ mt: 1 }}>
          <LinearProgress />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>{progress}</Typography>
        </Box>
      )}

      {selected?.note && selected.available && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          {selected.note}
        </Typography>
      )}

      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  );
}
