import { useCallback, useEffect, useState } from "react";
import {
  Paper, Typography, Stack, Chip, Box, Accordion, AccordionSummary, AccordionDetails,
  Button, Alert, ToggleButton, ToggleButtonGroup, Tooltip, IconButton,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import RefreshIcon from "@mui/icons-material/Refresh";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { api } from "../services/api";

export interface LogEntry {
  id: number;
  timestamp: string;
  level: "error" | "warning" | "info";
  source: string;
  message: string;
  detail: string | null;
  context: Record<string, unknown> | null;
}

const LEVEL = {
  error:   { color: "#FF7B7B", label: "error" },
  warning: { color: "#FFB35C", label: "warning" },
  info:    { color: "#8AC7FF", label: "info" },
} as const;

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<"all" | "error" | "warning">("all");
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(() => {
    api.getLogs()
      .then((r) => { if (r.ok) { setLogs(r.logs); setOffline(false); } })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const shown = filter === "all" ? logs : logs.filter((l) => l.level === filter);
  const errorCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warning").length;

  const copy = (l: LogEntry) => {
    const text = [
      `[${l.level}] ${l.source} — ${new Date(l.timestamp).toLocaleString()}`,
      l.message,
      l.context ? `\nContext: ${JSON.stringify(l.context, null, 2)}` : "",
      l.detail ? `\nDetail:\n${l.detail}` : "",
    ].join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Typography variant="h6" sx={{ flex: 1 }}>Logs</Typography>
        <ToggleButtonGroup size="small" exclusive value={filter}
          onChange={(_, v) => v && setFilter(v)}>
          <ToggleButton value="all">All ({logs.length})</ToggleButton>
          <ToggleButton value="error">Errors ({errorCount})</ToggleButton>
          <ToggleButton value="warning">Warnings ({warnCount})</ToggleButton>
        </ToggleButtonGroup>
        <Button size="small" startIcon={<RefreshIcon />} onClick={refresh}>Refresh</Button>
        <Button size="small" color="inherit" startIcon={<DeleteSweepIcon />}
          onClick={() => api.clearLogs().then(refresh).catch(() => {})}>
          Clear
        </Button>
      </Stack>

      {offline && (
        <Alert severity="warning">
          Can't reach the sidecar, so stored logs can't be loaded.
        </Alert>
      )}

      {!offline && !logs.length && (
        <Paper sx={{ p: 4 }}>
          <Typography color="text.secondary">
            No errors or warnings recorded. Anything that goes wrong during a scan or an AI report
            will appear here with the full detail.
          </Typography>
        </Paper>
      )}

      {shown.map((l) => (
        <Accordion key={l.id} disableGutters sx={{ bgcolor: "background.paper" }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ width: "100%", pr: 1 }}>
              <Chip size="small" label={LEVEL[l.level]?.label ?? l.level}
                sx={{
                  height: 22, fontWeight: 700, fontSize: 11,
                  bgcolor: `${LEVEL[l.level]?.color ?? "#8AC7FF"}22`,
                  color: LEVEL[l.level]?.color ?? "#8AC7FF",
                  border: `1px solid ${LEVEL[l.level]?.color ?? "#8AC7FF"}55`,
                }} />
              <Chip size="small" variant="outlined" label={l.source} sx={{ height: 22, fontSize: 11 }} />
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{l.message}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                {new Date(l.timestamp).toLocaleString()}
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" sx={{ mb: 1.5 }}>{l.message}</Typography>

            {l.context && (
              <>
                <Typography variant="overline">Context</Typography>
                <Box component="pre" sx={preSx}>{JSON.stringify(l.context, null, 2)}</Box>
              </>
            )}

            {l.detail && (
              <>
                <Typography variant="overline">Detail</Typography>
                <Box component="pre" sx={{ ...preSx, maxHeight: 320, overflow: "auto" }}>{l.detail}</Box>
              </>
            )}

            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
              <Tooltip title="Copy this log entry">
                <IconButton size="small" onClick={() => copy(l)} aria-label="Copy log entry">
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </AccordionDetails>
        </Accordion>
      ))}
    </Stack>
  );
}

const preSx = {
  m: 0, mb: 1.5, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
  border: "1px solid rgba(154,167,180,0.15)", fontSize: 12.5,
  fontFamily: "IBM Plex Mono, monospace", whiteSpace: "pre-wrap",
  wordBreak: "break-word" as const, color: "#C8D3DE",
};
