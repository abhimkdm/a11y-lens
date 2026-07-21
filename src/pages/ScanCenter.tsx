import { useEffect, useRef, useState } from "react";
import {
    Paper, Typography, Stack, Button, TextField, Alert, LinearProgress, Grid2 as Grid, Chip, Box,
    Checkbox, FormControlLabel, MenuItem, Tooltip,
} from "@mui/material";
import BoltIcon from "@mui/icons-material/Bolt";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import OpenInBrowserIcon from "@mui/icons-material/OpenInBrowser";
import LayersIcon from "@mui/icons-material/Layers";
import LayersClearIcon from "@mui/icons-material/LayersClear";
import ConstructionIcon from "@mui/icons-material/Construction";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import ReplayIcon from "@mui/icons-material/Replay";
import PsychologyIcon from "@mui/icons-material/Psychology";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import ViolationList from "../components/ViolationList";
import AiReportPanel from "../components/AiReportPanel";
import BrowserSetup from "../components/BrowserSetup";
import ExpertAuditPanel from "../components/ExpertAuditPanel";
import ScoreRing from "../components/ScoreRing";
import VerifyPathPanel from "../components/VerifyPathPanel";
import AgentActivityPanel from "../components/AgentActivityPanel";
import { saveFile } from "../utils/saveFile";
import BrowserPicker from "../components/BrowserPicker";

// Feature flag — the AI Expert Audit (incl. cross-check, probes, scope selector)
// is fully built and tested but hidden from the UI for now. Flip to `true` to
// bring back the scope selector, the Cross-check checkbox and the audit button.
// Everything behind it (sidecar endpoints, panel, persistence) is left intact.
const SHOW_EXPERT_AUDIT = false;

// Keyboard Audit is built but hidden from the scan toolbar for now. Flip to `true`
// to bring back the button (and keyboard findings panel below scan results).
const SHOW_KEYBOARD_AUDIT = false;

export default function ScanCenter() {
  const [error, setError] = useState("");
  const {
    sessionOpen, setSessionOpen, scanning, setScanning, currentScan, setScan, ignored, aiProvider,
    attachAiReport, attachExpertAudit, setScanId, applicationUrl, setApplicationUrl,
  } = useAppStore();

  // An AI report / expert audit is produced AFTER the scan is first saved. Without
  // writing it back, the stored session (and therefore every export from Reports)
  // would be missing the AI sections entirely.
  const persist = (scan: typeof currentScan) => {
    if (!scan) return;
    if (scan.id) api.updateSession(scan.id, scan).catch(() => {});
    else api.saveSession(scan).then((r) => r?.ok && setScanId(r.id)).catch(() => {});
  };
  const [reportBusy, setReportBusy] = useState(false);
  const [expertBusy, setExpertBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [expertScope, setExpertScope] = useState<"main" | "chrome" | "all">("main");
  const [crossCheck, setCrossCheck] = useState(false);

  // The expert audit's whole value is finding what axe CANNOT. So we hand it
  // this page's live axe violations as a suppression list — it then spends its
  // entire budget on what the scanner structurally can't see.
  const expertAudit = async () => {
    setError(""); setExpertBusy(true);
    const r = await api
      .expertAudit(aiProvider, currentScan?.violations ?? [], {
        scope: expertScope,
        mode: crossCheck ? "cross-check" : "single",
      })
      .catch((e) => ({ ok: false, error: String(e) }));
    setExpertBusy(false);
    if (r.ok) {
      attachExpertAudit(r.audit);
      persist({ ...(currentScan as NonNullable<typeof currentScan>), expertAudit: r.audit });
    } else setError(r.error ?? "Expert audit failed");
  };

  const genReport = async () => {
    if (!currentScan) return;
    setError(""); setNotice(""); setReportBusy(true);
    const r = await api.aiReport(currentScan, aiProvider).catch((e) => ({ ok: false, error: String(e) }));
    setReportBusy(false);
    if (r.ok) {
      attachAiReport(r.report);
      persist({ ...(currentScan as NonNullable<typeof currentScan>), aiReport: r.report });
      // The report came back, but the model's output was partly malformed and we
      // recovered what we could. Say so plainly — and don't throw the report away.
      if (r.degraded) {
        setNotice(
          "The report was generated, but part of the model's response was malformed and could not be " +
          "recovered. What you see below is everything we could salvage — see Logs for the details."
        );
      }
    } else setError(r.error ?? "Report generation failed — see Logs for details.");
  };
  const [overlayMsg, setOverlayMsg] = useState("");
  const [maxPages, setMaxPages] = useState(10);
  const [crawl, setCrawl] = useState<{ pages: { url: string; title: string; score: number }[]; log: { msg: string }[]; currentUrl: string | null; unitsDone?: number; unitsTotal?: number; stage?: string } | null>(null);
  // Describes the currently running scan so the agent panel shows only the
  // agents this run actually enabled, and a real progress denominator when known.
  const [runInfo, setRunInfo] = useState<{ aiAudit: boolean; interact: boolean; total: number | null } | null>(null);
  const pollRef = useRef<number | null>(null);

  const [useUrlList, setUseUrlList] = useState(false);
  const [urlList, setUrlList] = useState<string[]>([]);
  const [urlListError, setUrlListError] = useState("");
  const [urlListSource, setUrlListSource] = useState(""); // filename, "Recorded path", or "Crawl Explorer"
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Interaction scanning. `allowMutations` is deliberately NOT persisted and is
  // reset to false after every scan — a mutating run must be a fresh, explicit
  // decision each time, never a setting left on by accident.
  const [interact, setInteract] = useState(false);
  const [allowMutations, setAllowMutations] = useState(false);
  const [valueProfileText, setValueProfileText] = useState("");
  const [valueProfileError, setValueProfileError] = useState("");

  // Which engine the session runs in. Chrome by default; Gecko/WebKit are where
  // the genuinely different accessibility findings come from.
  const [browserId, setBrowserId] = useState("chrome");
  const [recording, setRecording] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const recordPollRef = useRef<number | null>(null);

  // v2 action recording: the full recording object (steps + selector chains),
  // a human label, whether replay should use the just-recorded or imported one,
  // and the hidden file input used to import a saved recording.
  type Recording = {
    kind: string; steps: unknown[]; checkpoints?: number[];
    entries?: { url: string; title?: string }[];
  } & Record<string, unknown>;
  const [recordingObj, setRecordingObj] = useState<Recording | null>(null);
  const [recordLabel, setRecordLabel] = useState("");
  const [replaySource, setReplaySource] = useState<"current" | "imported">("current");
  const recordImportRef = useRef<HTMLInputElement>(null);

  const startRecording = async () => {
    setError("");
    const r = await api.recordStart().catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start recording"); return; }
    setRecording(true);
    setRecordedCount(0);
    // A recorded journey is almost always about interaction-revealed states —
    // that is the reason to record one. Turn the interaction pass on so
    // "Replay & scan" audits the drawers and validation the journey opens,
    // instead of silently scanning only the landing state of each checkpoint.
    setInteract(true);
    recordPollRef.current = window.setInterval(async () => {
      const st = await api.recordStatus().catch(() => null);
      if (st?.ok) setRecordedCount(st.steps ?? st.entries.length);
    }, 1000);
  };

  const stopRecording = async () => {
    if (recordPollRef.current) { clearInterval(recordPollRef.current); recordPollRef.current = null; }
    const r = await api.recordStop().catch((e) => ({ ok: false, error: String(e) }));
    setRecording(false);
    if (!r.ok) { setError(r.error ?? "Could not stop recording"); return; }
    const urls: string[] = (r.entries ?? []).map((e: { url: string }) => e.url);
    const steps: number = r.steps ?? 0;
    const cps: number = r.checkpoints ?? urls.length;
    setRecordingObj(r.recording ?? null);
    setReplaySource("current");
    setRecordLabel(`Recorded path (${cps} checkpoint${cps === 1 ? "" : "s"}, ${steps} action${steps === 1 ? "" : "s"})`);
    if (!steps) setError("Recording captured no actions — click through the journey in the browser before stopping.");
    // Keep the recorded URLs available for the classic custom-URL-list scan too.
    setUrlList(urls);
    setUrlListError("");
    setUrlListSource(`Recorded path (${urls.length} page${urls.length === 1 ? "" : "s"})`);
    setUseUrlList(urls.length > 0);
  };

  // Import a previously saved recording (from disk) and hold it for replay.
  const importRecording = async (file: File) => {
    setError("");
    let parsed: Recording;
    try { parsed = JSON.parse(await file.text()); }
    catch { setError("That file isn't valid JSON."); return; }
    if (!parsed || parsed.kind !== "a11y-lens-recording" || !Array.isArray(parsed.steps)) {
      setError("Not an A11y Lens recording (missing the a11y-lens-recording marker)."); return;
    }
    const r = await api.recordImport(parsed).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not import recording."); return; }
    setRecordingObj(parsed);
    setReplaySource("imported");
    setRecordLabel(
      `Imported (${r.checkpoints} checkpoint${r.checkpoints === 1 ? "" : "s"}, ${r.steps} action${r.steps === 1 ? "" : "s"}` +
      `${r.masked ? `, ${r.masked} masked` : ""})`
    );
    if (Array.isArray(parsed.entries)) {
      const urls = parsed.entries.map((e) => e.url);
      setUrlList(urls);
      setUrlListSource(`Imported path (${urls.length} page${urls.length === 1 ? "" : "s"})`);
    }
  };

  const downloadRecordedPath = async () => {
    if (!recordingObj) return;
    const name = `a11y-lens-recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    const res = await saveFile(name, JSON.stringify(recordingObj, null, 2), "application/json");
    if (res.cancelled) return;                       // user pressed Cancel — say nothing
    setNotice(res.path ? `Recording saved to ${res.path}` : "Recording saved.");
  };

  const parseUrlListJson = (raw: string): string[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Not valid JSON.");
    }
    // Accept either a plain array of strings, or { urls: [...] }.
    const arr = Array.isArray(parsed) ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as { urls?: unknown }).urls))
      ? (parsed as { urls: unknown[] }).urls
      : null;
    if (!arr) throw new Error('Expected a JSON array of URLs, or an object like {"urls": [...]}.');
    if (!arr.length) throw new Error("The list is empty.");
    const bad = arr.find((u) => typeof u !== "string" || !u.trim());
    if (bad !== undefined) throw new Error("Every entry must be a non-empty string (an absolute URL or a path starting with \"/\").");
    return arr as string[];
  };

  const handleUrlListFile = async (file: File) => {
    setUrlListError(""); setUrlList([]); setUrlListSource(file.name);
    try {
      const text = await file.text();
      const list = parseUrlListJson(text);
      setUrlList(list);
    } catch (e) {
      setUrlListError((e as Error).message);
    }
  };

  // A curated page set handed over from Crawl Explorer. Picking it up here is
  // the whole point of that module: a human chose these pages, so the scan should
  // use exactly them rather than letting the AI wander.
  const { pendingUrlList, setPendingUrlList } = useAppStore();
  useEffect(() => {
    if (pendingUrlList?.length) {
      setUrlList(pendingUrlList);
      setUrlListSource(`Crawl Explorer (${pendingUrlList.length} pages)`);
      setUrlListError("");
      setUseUrlList(true);
      setPendingUrlList(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUrlList]);

  // The user can close the browser window whenever they like. Poll the sidecar so
  // "Session open" reflects the actual window rather than the last thing we did,
  // and so the engine picker unlocks again once it is gone.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const st = await api.status().catch(() => null);
      if (!alive || !st) return;
      setSessionOpen(!!st.open);
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [setSessionOpen]);

  const closeSession = async () => {
    setError(""); setNotice("");
    await api.closeSession().catch(() => null);
    setSessionOpen(false);
    setNotice("Browser session closed. You can pick a different engine now.");
  };

  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => {
    stopPolling();
    if (recordPollRef.current) clearInterval(recordPollRef.current);
  }, []);

  const fullScan = async (aiAudit = false) => {
    if (useUrlList && (!urlList.length || urlListError)) {
      setError("Upload a valid URL list JSON file first, or turn off \"Use custom URL list\".");
      return;
    }
    if (aiAudit && (!aiProvider?.provider || !aiProvider?.model)) {
      setError("AI Full Scan needs an AI provider. Configure one in Settings first.");
      return;
    }
    let valueProfile: unknown = null;
    if (interact && allowMutations && valueProfileText.trim()) {
      try { valueProfile = JSON.parse(valueProfileText); setValueProfileError(""); }
      catch { setValueProfileError("Value profile is not valid JSON."); setError("Fix the value profile JSON, or clear it."); return; }
    }
    setError(""); setCrawl(null);
    const r = await api.fullScanStart(
      maxPages, aiProvider, useUrlList ? urlList : undefined,
      interact ? { interact: true, allowMutations, valueProfile } : undefined,
      aiAudit
    ).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start full scan"); return; }
    // Non-sticky: a mutating run can't be left armed for the next scan.
    setAllowMutations(false);
    setRunInfo({ aiAudit, interact, total: useUrlList ? urlList.length : null });
    beginCrawlPolling();
  };

  // Replay scan and Full scan both drive the SAME crawler, so they report through
  // the same status endpoint — this polling loop is shared by both.
  const beginCrawlPolling = () => {
    setScanning("full");
    pollRef.current = window.setInterval(async () => {
      const st = await api.fullScanStatus().catch(() => null);
      if (!st) return;
      setCrawl({ pages: st.pages, log: st.log, currentUrl: st.currentUrl, unitsDone: st.unitsDone, unitsTotal: st.unitsTotal, stage: st.stage });
      if (!st.running) {
        stopPolling(); setScanning("idle");
        if (st.error) setError(st.error);
        if (st.result) {
          setScan(st.result);
          api.saveSession(st.result).then((res) => res?.ok && setScanId(res.id)).catch(() => {});
        }
      }
    }, 1500);
  };

  // Replay the recorded/imported path and scan every state it reveals. Reuses the
  // crawler (and its polling) via the navigator seam on the sidecar.
  const replayScan = async (aiAudit = false) => {
    if (!recordingObj) { setError("Record or import a path first."); return; }
    if (aiAudit && (!aiProvider?.provider || !aiProvider?.model)) {
      setError("AI replay scan needs an AI provider. Configure one in Settings first."); return;
    }
    let valueProfile: unknown = null;
    if (interact && allowMutations && valueProfileText.trim()) {
      try { valueProfile = JSON.parse(valueProfileText); setValueProfileError(""); }
      catch { setValueProfileError("Value profile is not valid JSON."); setError("Fix the value profile JSON, or clear it."); return; }
    }
    setError(""); setCrawl(null);
    const r = await api.replayStart({
      scan: true, source: replaySource, ai: aiProvider, aiAudit,
      ...(interact ? { interact: true, allowMutations, valueProfile } : {}),
    }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start replay scan"); return; }
    setAllowMutations(false);
    setRunInfo({ aiAudit, interact, total: recordingObj?.checkpoints?.length ?? null });
    beginCrawlPolling();
  };

  const stopFullScan = async () => { await api.fullScanStop().catch(() => {}); };

  const [toolbarOn, setToolbarOn] = useState(false);
  const inspectToolbar = async () => {
    setError("");
    const r = toolbarOn ? await api.hideToolbar().catch((e) => ({ ok: false, error: String(e) }))
                        : await api.showToolbar().catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) setToolbarOn(!toolbarOn);
    else setError(r.error ?? "Could not toggle inspect toolbar");
  };

  const overlay = async (show: boolean) => {
    setError(""); setOverlayMsg("");
    const r = show
      ? await api.showOverlay(
          (currentScan?.violations ?? []).filter((v) => !ignored[v.id])
        ).catch((e) => ({ ok: false, error: String(e) }))
      : await api.clearOverlay().catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) setError(r.error ?? "Overlay failed");
    else if (show) setOverlayMsg(`Overlay active — ${r.placed} markers placed. Click a marker in the browser for details and a suggested fix.`);
  };

  const open = async () => {
    setError("");
    const r = await api.openSession(applicationUrl, browserId).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) setSessionOpen(true);
    else setError(r.error ?? "Could not reach the sidecar. Run: npm run sidecar");
  };

  const quick = async () => {
    setError(""); setScanning("quick");
    const r = await api.quickScan().catch((e) => ({ ok: false, error: String(e) }));
    setScanning("idle");
    if (r.ok) {
      setScan(r);
      api.saveSession(r).then((res) => res?.ok && setScanId(res.id)).catch(() => {});
    }
    else setError(r.error ?? "Scan failed");
  };

  const keyboard = async () => {
    setError(""); setScanning("keyboard");
    const r = await api.keyboardScan().catch((e) => ({ ok: false, error: String(e) }));
    setScanning("idle");
    if (r.ok && currentScan) setScan({ ...currentScan, keyboardFindings: r.findings });
    else if (!r.ok) setError(r.error ?? "Keyboard audit failed");
  };

  // True when the loaded scan came from an AI Full Scan — the model already
  // reviewed every page, so a separate "Generate AI Report" pass would re-spend
  // tokens on the same judgement. Detected from the audit metadata the crawler
  // attaches, with a token-count fallback for older sessions.
  const aiAlreadyAudited =
    !!currentScan?.aiAudit ||
    ((currentScan?.usage?.inputTokens ?? 0) + (currentScan?.usage?.outputTokens ?? 0)) > 0;

  return (
    <Stack spacing={2.5}>
      <BrowserSetup />

      <Paper sx={{ p: 3 }}>
        <Typography variant="overline">1 · Browser session</Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
          <TextField fullWidth size="small" label="Application URL" value={applicationUrl}
                     onChange={(e) => setApplicationUrl(e.target.value)} />
          <Button variant="outlined" startIcon={<OpenInBrowserIcon />} onClick={open}
                  sx={{ whiteSpace: "nowrap" }}>
            Open browser
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} component="div">
          A visible browser window opens. Log in manually — your credentials never leave the browser.
          {sessionOpen && <Chip size="small" color="success" label="Session open" sx={{ ml: 1 }} />}
          {sessionOpen && (
            <Button size="small" color="inherit" onClick={closeSession}
                    sx={{ ml: 1, textTransform: "none" }}>
              Close session
            </Button>
          )}
        </Typography>
        <Box sx={{ mt: 2 }}>
          <BrowserPicker value={browserId} onChange={setBrowserId} disabled={sessionOpen} />
          {sessionOpen && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              Close the session to switch engine — a session belongs to one browser.
            </Typography>
          )}
        </Box>
        <Button sx={{ mt: 1.5 }} variant={toolbarOn ? "contained" : "outlined"} color="secondary"
                startIcon={<ConstructionIcon />} disabled={!sessionOpen} onClick={inspectToolbar}>
          {toolbarOn ? "Hide inspect toolbar" : "Show inspect toolbar"}
        </Button>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          Manual tools in the browser: alt-text visualizer and screen reader simulator —
          for the checks automation can't fully judge.
        </Typography>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="overline">2 · Record a path (optional)</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
          Click through a specific journey yourself — login, add to cart, checkout — and A11y Lens records every
          action (with resilient selectors), so it can reproduce the exact path later even on a single-page app where
          the URL never changes. Save it to disk and re-import it any time.
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          {recording ? (
            <Button variant="contained" color="error" startIcon={<FiberManualRecordIcon />} onClick={stopRecording}>
              Stop recording ({recordedCount} action{recordedCount === 1 ? "" : "s"})
            </Button>
          ) : (
            <Button variant="outlined" color="secondary" startIcon={<FiberManualRecordIcon />}
                    disabled={!sessionOpen} onClick={startRecording}>
              Record path
            </Button>
          )}
          {recording && <Chip size="small" color="error" label="● Recording — click through the journey in the browser now" />}

          {!recording && (
            <>
              <Button size="small" variant="outlined" startIcon={<UploadFileIcon />}
                      onClick={() => recordImportRef.current?.click()}>
                Import recording
              </Button>
              <input ref={recordImportRef} type="file" accept="application/json,.json" hidden
                     onChange={(e) => { const f = e.target.files?.[0]; if (f) importRecording(f); e.currentTarget.value = ""; }} />
            </>
          )}

          {!recording && recordingObj && (
            <>
              <Chip size="small" color="success" label={recordLabel} />
              <Button size="small" onClick={downloadRecordedPath}>Save as JSON</Button>
            </>
          )}
        </Stack>

        {!recording && recordingObj && (
          <>
            <VerifyPathPanel sessionOpen={sessionOpen} source={replaySource} busy={scanning !== "idle"} onError={setError} />
            <Stack direction="row" spacing={1.5} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
              <Button variant="contained" color="secondary" startIcon={<ReplayIcon />}
                      disabled={!sessionOpen || scanning !== "idle"} onClick={() => replayScan(false)}>
                Replay &amp; scan
              </Button>
              <Button variant="contained" startIcon={<AutoFixHighIcon />}
                      disabled={!sessionOpen || scanning !== "idle"} onClick={() => replayScan(true)}>
                Replay &amp; AI scan
              </Button>
            </Stack>
          </>
        )}
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="overline">3 · Run a scan</Typography>
        <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
          <Grid size={{ xs: 12, sm: SHOW_KEYBOARD_AUDIT ? 3 : 4 }}>
            <Button fullWidth variant="contained" size="medium" startIcon={<BoltIcon />}
                    disabled={!sessionOpen || scanning !== "idle"} onClick={quick}>
              Quick Accessibility Scan
            </Button>
          </Grid>
          {SHOW_KEYBOARD_AUDIT && (
            <Grid size={{ xs: 12, sm: 3 }}>
              <Button fullWidth variant="outlined" size="medium" startIcon={<KeyboardIcon />}
                      disabled={!sessionOpen || scanning !== "idle"} onClick={keyboard}>
                Keyboard Audit
              </Button>
            </Grid>
          )}
          {scanning === "full" ? (
            <Grid size={{ xs: 12, sm: SHOW_KEYBOARD_AUDIT ? 6 : 8 }}>
              <Button fullWidth color="error" variant="outlined" size="medium"
                      startIcon={<StopCircleIcon />} onClick={stopFullScan}>
                Stop Scan
              </Button>
            </Grid>
          ) : (
            <>
              <Grid size={{ xs: 12, sm: SHOW_KEYBOARD_AUDIT ? 3 : 4 }}>
                <Button fullWidth variant="outlined" size="medium" startIcon={<AutoAwesomeIcon />}
                        disabled={!sessionOpen || scanning !== "idle"} onClick={() => fullScan(false)}>
                  Full Scan
                </Button>
              </Grid>
              <Grid size={{ xs: 12, sm: SHOW_KEYBOARD_AUDIT ? 3 : 4 }}>
                <Tooltip title="Full Scan plus a per-page AI expert audit — finds what scanners miss (meaningful names, focus management, keyboard operation, state exposure, visual-vs-programmatic mismatch). Uses your configured AI provider and consumes tokens per page.">
                  <span style={{ display: "block", width: "100%" }}>
                    <Button fullWidth variant="contained" color="secondary" size="medium" startIcon={<AutoFixHighIcon />}
                            disabled={!sessionOpen || scanning !== "idle"} onClick={() => fullScan(true)}>
                      AI Full Scan
                    </Button>
                  </span>
                </Tooltip>
              </Grid>
            </>
          )}
        </Grid>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
          {/* Max pages bounds the CRAWL, and only the crawl. When you supply a URL
              list the list length is the bound, and a recorded path is bounded by
              its checkpoints — the sidecar ignores this value in both cases, so
              showing it there just invites the question "did it cut my list off?".
              (It never did: the URL-list branch caps at the list length, not this.) */}
          {!useUrlList && !recordingObj && (
            <TextField size="small" type="number" label="Max pages" value={maxPages}
                       onChange={(e) => setMaxPages(Math.max(1, Math.min(40, +e.target.value || 10)))}
                       helperText="Crawl stops here"
                       sx={{ width: 130 }} />
          )}
          {useUrlList && urlList.length > 0 && (
            <Chip size="small" variant="outlined"
                  label={`${urlList.length} URL${urlList.length === 1 ? "" : "s"} — all will be scanned`} />
          )}
          {!useUrlList && recordingObj && (
            <Chip size="small" variant="outlined"
                  label={`${recordingObj.checkpoints?.length ?? 0} checkpoints from the recording`} />
          )}
          <Typography variant="body2" color="text.secondary">
            {interact
              ? (allowMutations
                  ? "Operate mode: the AI fills forms with your profile values and submits them. Staging only."
                  : "Explore mode: the AI opens menus, modals, dropdowns and triggers validation to scan hidden states — but never types real data or submits.")
              : "The AI explores navigation only — it never clicks delete, submit, payment, approve, or logout."}
          </Typography>
        </Stack>

        <FormControlLabel
          sx={{ mt: 1 }}
          control={<Checkbox checked={interact}
            onChange={(e) => { setInteract(e.target.checked); if (!e.target.checked) setAllowMutations(false); }} />}
          label="Interact with each page — open menus, modals, dropdowns and trigger validation to scan states that only appear after interaction"
        />
        {interact && (
          <Box sx={{ ml: 3.5, mb: 1, pl: 1.5, borderLeft: "2px solid rgba(154,167,180,0.25)" }}>
            <FormControlLabel
              control={<Checkbox color="warning" checked={allowMutations}
                onChange={(e) => setAllowMutations(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  This is a <strong>staging / test</strong> environment — allow the AI to fill forms and submit them (mutations)
                </Typography>
              }
            />
            {allowMutations && (
              <Alert severity="warning" sx={{ mt: 0.5, mb: 1 }}>
                The AI will type values and click submit on this session's site (<code>{sessionOpen ? "open session" : "no session"}</code>).
                Only use this against staging with disposable data. This resets after the scan — you'll re-confirm each time.
              </Alert>
            )}
            {allowMutations && (
              <TextField
                fullWidth multiline minRows={3} size="small"
                label="Value profile (optional JSON)"
                placeholder={'{\n  "profile": { "search": "wireless headphones" },\n  "fields": { "#email": "test@staging.example.com", "input[name=zip]": "94103" }\n}'}
                value={valueProfileText}
                onChange={(e) => { setValueProfileText(e.target.value); setValueProfileError(""); }}
                error={!!valueProfileError}
                helperText={valueProfileError || "Fields you specify use your values; everything else gets a safe synthetic value (test@…, 1, Lorem) — logged in the report. Sensitive fields (card, CVV, OTP) are never filled."}
                sx={{ mt: 0.5, fontFamily: "monospace" }}
              />
            )}
          </Box>
        )}

        <FormControlLabel
          sx={{ mt: 1 }}
          control={<Checkbox checked={useUrlList}
            onChange={(e) => { setUseUrlList(e.target.checked); setError(""); }} />}
          label="Use a custom URL list instead of AI navigation (from a recorded path or an uploaded JSON file)"
        />
        {useUrlList && (
          <Box sx={{ mt: 0.5, mb: 1 }}>
            <input ref={fileInputRef} type="file" accept=".json,application/json" hidden
                   onChange={(e) => e.target.files?.[0] && handleUrlListFile(e.target.files[0])} />
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Button size="small" variant="outlined" startIcon={<UploadFileIcon />}
                      onClick={() => fileInputRef.current?.click()}>
                Upload URL list (.json)
              </Button>
              {urlListSource && !urlListError && (
                <Chip size="small" color="success" label={
                  urlListSource.startsWith("Recorded") || urlListSource.startsWith("Crawl Explorer")
                    ? urlListSource
                    : `${urlListSource} · ${urlList.length} URL${urlList.length === 1 ? "" : "s"}`
                } />
              )}
              {urlListSource && urlListError && (
                <Chip size="small" color="error" label={urlListSource} />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
              Record a path above, or upload JSON like <code>["/pricing", "/about", "https://yourapp.com/help"]</code> —
              or <code>{"{"}"urls": [...]{"}"}</code>. Only pages on the same origin as the open session are scanned.
            </Typography>
            {urlListError && <Alert severity="error" sx={{ mt: 1 }}>{urlListError}</Alert>}
          </Box>
        )}
        {scanning !== "idle" && !(scanning === "full" && crawl) && <LinearProgress sx={{ mt: 2 }} />}
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        {scanning === "full" && crawl && (
          <>
            <AgentActivityPanel
              pages={crawl.pages.length}
              logs={crawl.log}
              currentUrl={crawl.currentUrl}
              aiAudit={runInfo?.aiAudit ?? false}
              interact={runInfo?.interact ?? false}
              total={runInfo?.total ?? null}
              unitsDone={crawl.unitsDone}
              unitsTotal={crawl.unitsTotal}
              stage={crawl.stage}
            />
            <Paper variant="outlined" sx={{ mt: 2, p: 2, bgcolor: "#0E1116" }}>
              <Typography variant="overline">Activity log</Typography>
              <Stack spacing={0.25} sx={{ mt: 1 }}>
                {/* "Could not activate X: TimeoutError" fires once per unclickable
                    candidate and can be a dozen lines a page — it drowns the real
                    activity. Still recorded in Logs for debugging, just not here. */}
                {crawl.log
                  .filter((l) => !/^Could not activate\b/i.test(l.msg))
                  .map((l, i) => (
                    <Typography key={i} variant="caption" color="text.secondary"
                                sx={{ fontFamily: "monospace" }}>
                      {l.msg.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[\d+m/g, "")}
                    </Typography>
                  ))}
              </Stack>
            </Paper>
          </>
        )}
      </Paper>

      {currentScan && (
        <Paper sx={{ p: 3 }}>
          <Stack direction="row" spacing={3} alignItems="center" sx={{ mb: 2 }}>
            <ScoreRing score={currentScan.score} size={110} />
            <Stack>
              <Typography variant="h6">{currentScan.title || currentScan.url}</Typography>
              <Typography variant="body2" color="text.secondary">
                Scanned {new Date(currentScan.timestamp).toLocaleString()}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ ml: "auto" }}>
              <Button variant="outlined" startIcon={<LayersIcon />} onClick={() => overlay(true)}
                      disabled={!sessionOpen}>
                Show overlay in browser
              </Button>
              <Button color="inherit" startIcon={<LayersClearIcon />} onClick={() => overlay(false)}
                      disabled={!sessionOpen}>
                Clear
              </Button>
              {SHOW_EXPERT_AUDIT && (
                <>
                  <TextField select size="small" value={expertScope} label="Audit scope"
                             onChange={(e) => setExpertScope(e.target.value as "main" | "chrome" | "all")}
                             sx={{ width: 150 }}>
                    <MenuItem value="main">Main content</MenuItem>
                    <MenuItem value="chrome">Site chrome</MenuItem>
                    <MenuItem value="all">Everything</MenuItem>
                  </TextField>
                  <Tooltip title="Runs two different models against identical evidence and reconciles them into consensus / confirmed / needs-review tiers. Roughly 2x the cost, but tells you which findings to trust.">
                    <FormControlLabel
                      control={<Checkbox size="small" checked={crossCheck}
                                         onChange={(e) => setCrossCheck(e.target.checked)} />}
                      label={<Typography variant="body2">Cross-check</Typography>}
                    />
                  </Tooltip>
                  <Button variant="outlined" color="secondary" startIcon={<PsychologyIcon />}
                          onClick={expertAudit} disabled={expertBusy || !sessionOpen}>
                    {expertBusy ? "Auditing…" : crossCheck ? "AI Expert Audit ×2" : "AI Expert Audit"}
                  </Button>
                </>
              )}
              {/* AI spend discipline: an AI Full Scan has ALREADY had the model
                  review every page, so generating a second AI report on top of it
                  is duplicate spend for the same judgement. Offer the button only
                  after a non-AI scan; if a report already exists, make regenerating
                  an explicit choice rather than a one-click accident. */}
              <Tooltip
                title={
                  aiAlreadyAudited
                    ? "This was an AI Full Scan — the model already reviewed every page, and those findings are in the report. Generating another AI report would spend tokens on the same judgement."
                    : currentScan.aiReport
                      ? "An AI report already exists for this scan. Regenerating costs another request."
                      : "Have the AI synthesise these automated findings into a report."
                }
              >
                <span>
                  <Button variant="contained" color="secondary" startIcon={<AutoAwesomeIcon />}
                          onClick={genReport} disabled={reportBusy || aiAlreadyAudited}>
                    {reportBusy ? "Generating…" : currentScan.aiReport ? "Regenerate AI Report" : "Generate AI Report"}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Stack>
          {overlayMsg && <Alert severity="success" sx={{ mb: 2 }}>{overlayMsg}</Alert>}
          {reportBusy && (
            <Box sx={{ mb: 2 }}>
              <AgentActivityPanel
                mode="report"
                pages={currentScan.pages?.length ?? 0}
                logs={[]}
                currentUrl={null}
                aiAudit
                interact={false}
                total={null}
              />
            </Box>
          )}
          {currentScan.pages && (
            <Paper variant="outlined" sx={{ mb: 2, p: 2, bgcolor: "#0E1116" }}>
              <Typography variant="overline">Pages scanned · {currentScan.pages.length}</Typography>
              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {currentScan.pages.map((p, i) => (
                  <Stack key={i} direction="row" justifyContent="space-between">
                    <Typography variant="body2" noWrap sx={{ maxWidth: "70%" }}>{p.title || p.url}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {p.score}/100 · {p.violationRuleCount} rules
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}
          {(reportBusy || expertBusy) && <LinearProgress sx={{ mb: 2 }} />}
          {notice && (
            <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setNotice("")}
                   action={<Button color="inherit" size="small" href="#/logs">Check Logs</Button>}>
              {notice}
            </Alert>
          )}
          {SHOW_EXPERT_AUDIT && expertBusy && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Capturing screenshot, DOM, accessibility tree and keyboard walk, then reviewing as an
              expert would — this takes longer than a scan.
              {crossCheck && " Cross-check runs two models and reconciles them, so expect roughly double the time."}
            </Typography>
          )}
          {SHOW_EXPERT_AUDIT && currentScan.expertAudit && (
            <Box sx={{ mb: 2 }}><ExpertAuditPanel audit={currentScan.expertAudit} /></Box>
          )}
          {currentScan.aiReport && (
            <Box sx={{ mb: 2 }}><AiReportPanel report={currentScan.aiReport} /></Box>
          )}
          <ViolationList violations={currentScan.violations} />
          {SHOW_KEYBOARD_AUDIT && currentScan.keyboardFindings && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 3 }}>
                Keyboard findings · {currentScan.keyboardFindings.length}
              </Typography>
              {currentScan.keyboardFindings.map((f, i) => (
                <Typography key={i} variant="body2" sx={{ fontFamily: "monospace", mt: 0.5 }}>
                  {f.type} — {f.html}
                </Typography>
              ))}
            </>
          )}
        </Paper>
      )}
    </Stack>
  );
}
