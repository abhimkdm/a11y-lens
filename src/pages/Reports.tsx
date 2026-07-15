import { useEffect, useRef, useState } from "react";
import {
  Paper, Typography, Stack, Button, Chip, Checkbox, Alert, Divider, Box, IconButton, Tooltip,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import DataObjectIcon from "@mui/icons-material/DataObject";
import UploadIcon from "@mui/icons-material/Upload";
import DeleteIcon from "@mui/icons-material/DeleteOutline";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import SeverityChip from "../components/SeverityChip";
import { api } from "../services/api";
import { buildHtmlReport } from "../utils/reportHtml";
import { useAppStore } from "../store/useAppStore";
import type { Severity } from "../store/useAppStore";

interface SessionRow {
  id: number; url: string; title: string; timestamp: string;
  score: number; kind: string; counts: Record<Severity, number>;
}
interface DiffItem { rule: string; impact: Severity; help: string; target: string }
interface Comparison {
  prev: { timestamp: string; score: number };
  curr: { timestamp: string; score: number };
  scoreDelta: number;
  fixed: DiffItem[]; added: DiffItem[]; regressions: DiffItem[];
  summary: { fixed: number; added: number; regressions: number };
}

// Saving a file is genuinely different in the two environments this app runs in:
//
//   Tauri desktop  — the webview (WebView2 / WKWebView) does NOT honour
//                    <a download> on a blob: URL. The click silently does
//                    nothing. This is why exports appeared broken.
//   Browser (dev)  — <a download> works, but only if the anchor is actually in
//                    the DOM and the blob URL isn't revoked before the download
//                    starts reading it.
//
// So: ask the sidecar to write the file with Node (reliable everywhere), and
// only fall back to the blob trick if the sidecar isn't reachable.
async function save(name: string, content: string, type: string): Promise<string | null> {
  const r = await api.exportFile(name, content).catch(() => null);
  if (r?.ok) return r.path as string;

  // Fallback: browser download, done correctly.
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);   // must be in the DOM for some engines
  a.click();
  // Give the download a tick to start before revoking the blob.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 2000);
  return null;
}

function DiffList({ title, items, tone }: { title: string; items: DiffItem[]; tone: string }) {
  if (!items.length) return null;
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="overline" sx={{ color: tone }}>{title} · {items.length}</Typography>
      <Stack spacing={0.5} sx={{ mt: 0.5 }}>
        {items.slice(0, 12).map((d, i) => (
          <Stack key={i} direction="row" spacing={1} alignItems="center">
            <SeverityChip level={d.impact} />
            <Typography variant="body2" noWrap>{d.help}</Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: "auto", maxWidth: "40%" }}>
              {d.target}
            </Typography>
          </Stack>
        ))}
        {items.length > 12 && (
          <Typography variant="caption" color="text.secondary">…and {items.length - 12} more</Typography>
        )}
      </Stack>
    </Box>
  );
}

export default function Reports() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(0);
  const { aiProvider } = useAppStore();

  // A multi-page scan deserves a multi-page report: shared chrome issues collapsed
  // into one site-wide section, stable ids for ticketing, and an AI executive
  // summary over the whole site rather than one page.
  const siteReport = async (row: SessionRow) => {
    setError(""); setSaved(""); setBusy(row.id);
    const r0 = await api.getSession(row.id).catch(() => null);
    if (!r0?.ok) { setBusy(0); setError("Could not load session."); return; }
    const r = await api.siteReport(r0.scan, aiProvider).catch((e) => ({ ok: false, error: String(e) }));
    setBusy(0);
    if (r.ok) {
      setSaved(
        `${r.files} files written to ${r.dir} — ${r.stats.siteWideFindings} site-wide findings ` +
        `(${r.stats.duplicatesCollapsed} duplicate rows collapsed)` +
        (r.hasSummary ? " · executive summary included" : " · no executive summary (check Logs)")
      );
    } else setError(r.error ?? "Site report failed");
  };
  const [offline, setOffline] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    api.listSessions()
      .then((r) => { setRows(r.sessions ?? []); setOffline(false); })
      .catch(() => setOffline(true));
  useEffect(() => { refresh(); }, []);

  const toggle = (id: number) =>
    setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]);

  const runCompare = async () => {
    setError(""); setCmp(null);
    const [a, b] = [...selected].sort((x, y) => x - y); // older id = previous
    const r = await api.compare(a, b).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) setCmp(r.comparison);
    else setError(r.error ?? "Comparison failed");
  };

  const exportSession = async (row: SessionRow, kind: "html" | "session") => {
    setError(""); setSaved("");
    const r = await api.getSession(row.id).catch(() => null);
    if (!r?.ok) { setError("Could not load session. Is the sidecar running?"); return; }
    const base = `a11y-lens_${row.timestamp.slice(0, 19).replace(/[:T]/g, "-")}`;
    const path =
      kind === "html"
        ? await save(`${base}.html`, buildHtmlReport(r.scan), "text/html")
        : await save(
            `${base}.a11ysession.json`,
            JSON.stringify({ format: "a11y-lens-session", version: 1, scan: r.scan }, null, 2),
            "application/json"
          );
    if (path) setSaved(path);
  };

  const importFile = async (f: File) => {
    setError("");
    try {
      const parsed = JSON.parse(await f.text());
      const scan = parsed.scan ?? parsed; // accept raw scan JSON too
      const r = await api.importSession(scan);
      if (!r.ok) throw new Error(r.error);
      refresh();
    } catch (e) {
      setError(`Import failed: ${String((e as Error).message ?? e)}`);
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Typography variant="h6" sx={{ flex: 1 }}>Sessions</Typography>
        <input ref={fileRef} type="file" accept=".json" hidden
               onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        <Button startIcon={<UploadIcon />} onClick={() => fileRef.current?.click()}>
          Import session
        </Button>
        <Button variant="contained" startIcon={<CompareArrowsIcon />}
                disabled={selected.length !== 2} onClick={runCompare}>
          Compare selected
        </Button>
      </Stack>

      {offline && <Alert severity="warning">Sidecar not reachable — start it with <code>npm run sidecar</code> to see saved sessions.</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      {saved && (
        <Alert severity="success" onClose={() => setSaved("")}>
          Saved to <code>{saved}</code>
        </Alert>
      )}
      {!offline && !rows.length && (
        <Typography color="text.secondary" sx={{ p: 3 }}>
          No sessions yet. Every scan is saved here automatically.
        </Typography>
      )}

      {cmp && (
        <Paper sx={{ p: 3 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="h6">Comparison</Typography>
            <Chip label={`${cmp.prev.score} → ${cmp.curr.score} (${cmp.scoreDelta >= 0 ? "+" : ""}${cmp.scoreDelta})`}
                  color={cmp.scoreDelta > 0 ? "success" : cmp.scoreDelta < 0 ? "error" : "default"} />
            <Typography variant="body2" color="text.secondary">
              {new Date(cmp.prev.timestamp).toLocaleString()} vs {new Date(cmp.curr.timestamp).toLocaleString()}
            </Typography>
            <Button size="small" sx={{ ml: "auto" }} onClick={() => setCmp(null)}>Close</Button>
          </Stack>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="body2">
            {cmp.summary.fixed} fixed · {cmp.summary.added} new · {cmp.summary.regressions} regressions
            (rules that were clean before)
          </Typography>
          <DiffList title="Fixed" items={cmp.fixed} tone="#7BE8B0" />
          <DiffList title="Regressions" items={cmp.regressions} tone="#FF7B7B" />
          <DiffList title="Other new issues" items={cmp.added.filter(a => !cmp.regressions.includes(a))} tone="#FFB35C" />
        </Paper>
      )}

      {rows.map((row) => (
        <Paper key={row.id} sx={{ p: 2 }}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }}>
            <Checkbox checked={selected.includes(row.id)} onChange={() => toggle(row.id)}
                      inputProps={{ "aria-label": `Select session ${row.id} for comparison` }} />
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap sx={{ fontWeight: 600 }}>{row.title || row.url}</Typography>
              <Typography variant="body2" color="text.secondary">
                {new Date(row.timestamp).toLocaleString()} · {row.kind} scan · score {row.score}/100
              </Typography>
            </Stack>
            <Stack direction="row" spacing={0.75}>
              {(["critical", "serious"] as const).map((lvl) =>
                (row.counts[lvl] ?? 0) > 0 ? <SeverityChip key={lvl} level={lvl} count={row.counts[lvl]} /> : null
              )}
            </Stack>
            <Stack direction="row" spacing={0.5}>
              <Button size="small" variant="contained" startIcon={<DownloadIcon />}
                      onClick={() => exportSession(row, "html")}>HTML</Button>
              <Button size="small" variant="outlined" startIcon={<DataObjectIcon />}
                      onClick={() => exportSession(row, "session")}>Session</Button>
              {row.kind === "full" && (
                <Tooltip title="Multi-page report: shared chrome issues collapsed into one site-wide section, stable finding IDs, and an AI executive summary.">
                  <span>
                    <Button size="small" variant="contained" color="secondary"
                            disabled={busy === row.id}
                            onClick={() => siteReport(row)}>
                      {busy === row.id ? "Building…" : "Site report"}
                    </Button>
                  </span>
                </Tooltip>
              )}
              <Tooltip title="Delete session">
                <IconButton size="small" aria-label={`Delete session ${row.id}`}
                  onClick={() => api.deleteSession(row.id).then(refresh)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
