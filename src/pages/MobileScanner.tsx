import { useCallback, useEffect, useState } from "react";
import {
  Paper, Typography, Stack, Button, Chip, Box, Alert, LinearProgress, MenuItem,
  TextField, Accordion, AccordionSummary, AccordionDetails, Divider, Tooltip,
  ToggleButton, ToggleButtonGroup, FormControlLabel, Checkbox,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import AndroidIcon from "@mui/icons-material/Android";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import VerifiedIcon from "@mui/icons-material/Verified";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import RouteIcon from "@mui/icons-material/Route";
import StopIcon from "@mui/icons-material/Stop";
import DescriptionIcon from "@mui/icons-material/Description";
import PaidOutlinedIcon from "@mui/icons-material/PaidOutlined";
import SeverityChip from "../components/SeverityChip";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import type { Severity } from "../store/useAppStore";

interface Device {
  id: string; name: string; platform: "android" | "ios";
  kind: string; state: string; runtime?: string;
}
interface MobileApp { id: string; name: string; kind: "user" | "system" }
interface MobileFinding {
  rule: string; impact: Severity; title: string;
  explanation: string; userImpact?: string; fix: string;
  evidence: string; wcag: string[]; guideline?: string;
  evidenceStatus: "verified" | "unverified"; measured?: boolean;
  elements?: number;
  seenInSteps?: number[]; // present on flow results
}
interface FlowStepSummary {
  index: number; label: string;
  app: { package: string } | null; timestamp: string;
  counts: Record<Severity, number>; newFindings: number;
  usage?: { inputTokens: number; outputTokens: number };
}
interface MobileCost {
  usd: number | null; inputTokens: number; outputTokens: number;
  note?: string; pricedAs?: string;
}
interface MobileResult {
  platform: string; device: { model?: string; release?: string } | null;
  app: { package: string; activity?: string } | null;
  timestamp: string; screenshot: string | null;
  findings: MobileFinding[]; passes: string[];
  counts: Record<Severity, number>;
  treeAvailable: boolean; treeWarning: string | null;
  provider: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  cost?: MobileCost;
  flow?: boolean; name?: string; steps?: FlowStepSummary[];
  stats: {
    fromMeasured: number; fromAi: number; verified: number; unverified: number;
    totalElements?: number; interactiveElements?: number; labeledInteractive?: number;
    densityDpi?: number | null;
    stepsScanned?: number; rawFindings?: number; deduplicated?: number;
  };
}

export default function MobileScanner() {
  const { aiProvider } = useAppStore();
  const [tool, setTool] = useState<{
    android: { available: boolean; version: string | null; hint: string | null };
    ios: { available: boolean; version: string | null; hint: string | null };
    platform: string;
  } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [platform, setPlatform] = useState<"android" | "ios">("android");
  const [deviceId, setDeviceId] = useState("");
  const [aiReview, setAiReview] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<MobileResult | null>(null);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");

  // --- app launcher ---
  const [apps, setApps] = useState<MobileApp[]>([]);
  const [appId, setAppId] = useState("");
  const [includeSystem, setIncludeSystem] = useState(false);
  const [appsLoading, setAppsLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState("");

  // --- flow mode ---
  const [mode, setMode] = useState<"single" | "flow">("single");
  const [flowActive, setFlowActive] = useState(false);
  const [flowName, setFlowName] = useState("");
  const [flowSteps, setFlowSteps] = useState<FlowStepSummary[]>([]);
  const [stepLabel, setStepLabel] = useState("");

  // --- report export ---
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState("");
  const [exportingCost, setExportingCost] = useState(false);

  const refresh = useCallback(() => {
    api.mobileToolchain().then((r) => r.ok && setTool(r)).catch(() => {});
    api.mobileDevices()
      .then((r) => {
        if (!r.ok) return;
        const all = [...(r.android ?? []), ...(r.ios ?? [])];
        setDevices(all);
        const first = all.find((d: Device) => d.platform === platform && d.state === "booted");
        if (first && !deviceId) setDeviceId(first.id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  useEffect(() => { refresh(); }, [refresh]);

  // Recover an in-progress flow after a UI reload — the sidecar keeps it alive.
  useEffect(() => {
    api.mobileFlowStatus().then((r) => {
      if (r.ok && r.active) {
        setFlowActive(true);
        setMode("flow");
        setFlowName(r.name ?? "");
        setFlowSteps(r.steps ?? []);
        if (r.platform) setPlatform(r.platform);
        if (r.deviceId) setDeviceId(r.deviceId);
      }
    }).catch(() => {});
  }, []);

  const forPlatform = devices.filter((d) => d.platform === platform);
  const selected = devices.find((d) => d.id === deviceId);
  const available = platform === "android" ? tool?.android.available : tool?.ios.available;
  const booted = selected?.state === "booted";

  const loadApps = useCallback((sys: boolean) => {
    if (!deviceId) return;
    setAppsLoading(true);
    api.mobileApps(platform, deviceId, sys)
      .then((r) => { if (r.ok) setApps(r.apps ?? []); })
      .catch(() => {})
      .finally(() => setAppsLoading(false));
  }, [platform, deviceId]);

  useEffect(() => {
    setApps([]); setAppId(""); setLaunchMsg("");
    if (booted) loadApps(includeSystem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, booted]);

  const boot = async () => {
    if (!deviceId) return;
    setError(""); setHint("");
    const r = await api.mobileBoot(platform, deviceId).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start the device"); setHint(r.hint ?? ""); return; }
    setTimeout(refresh, 4000);
  };

  const launch = async () => {
    if (!appId) return;
    setError(""); setHint(""); setLaunching(true); setLaunchMsg("");
    const r = await api.mobileLaunch(platform, deviceId, appId)
      .catch((e) => ({ ok: false, error: String(e) }));
    setLaunching(false);
    if (r.ok) setLaunchMsg(`Launched ${appId} — wait for it to load, then scan.`);
    else { setError(r.error ?? "Launch failed"); setHint(r.hint ?? ""); }
  };

  const scan = async () => {
    setError(""); setHint(""); setScanning(true); setResult(null); setExportedPath("");
    const r = await api.mobileScan(platform, deviceId, aiProvider, aiReview)
      .catch((e) => ({ ok: false, error: String(e) }));
    setScanning(false);
    if (r.ok) setResult(r.result);
    else { setError(r.error ?? "Scan failed"); setHint(r.hint ?? ""); }
  };

  const startFlow = async () => {
    setError(""); setHint(""); setResult(null); setExportedPath("");
    const r = await api.mobileFlowStart(platform, deviceId, flowName)
      .catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start the flow"); return; }
    setFlowActive(true);
    setFlowSteps([]);
    if (!flowName) setFlowName(r.name ?? "");
  };

  const scanStep = async () => {
    setError(""); setHint(""); setScanning(true);
    const r = await api.mobileFlowStep(aiProvider, stepLabel, aiReview)
      .catch((e) => ({ ok: false, error: String(e) }));
    setScanning(false);
    if (r.ok) { setFlowSteps(r.status?.steps ?? []); setStepLabel(""); }
    else { setError(r.error ?? "Step scan failed"); setHint(r.hint ?? ""); }
  };

  const finishFlow = async () => {
    setError(""); setHint(""); setScanning(true);
    const r = await api.mobileFlowStop().catch((e) => ({ ok: false, error: String(e) }));
    setScanning(false);
    setFlowActive(false);
    if (r.ok) { setResult(r.result); setFlowSteps([]); setFlowName(""); }
    else setError(r.error ?? "Could not finish the flow");
  };

  const cancelFlow = async () => {
    await api.mobileFlowCancel().catch(() => {});
    setFlowActive(false); setFlowSteps([]); setFlowName("");
  };

  const exportReport = async () => {
    if (!result) return;
    setExporting(true); setExportedPath("");
    const r = await api.mobileReportHtml(result).catch((e) => ({ ok: false, error: String(e) }));
    setExporting(false);
    if (r.ok) setExportedPath(r.path ?? "");
    else setError(r.error ?? "Report export failed");
  };

  const exportCostReport = async () => {
    if (!result) return;
    setExportingCost(true); setExportedPath("");
    const r = await api.mobileAiUsageReportHtml(result).catch((e) => ({ ok: false, error: String(e) }));
    setExportingCost(false);
    if (r.ok) setExportedPath(r.path ?? "");
    else setError(r.error ?? "AI cost report export failed");
  };

  return (
    <Stack spacing={2.5}>
      <Alert severity="info" icon={false}>
        <Typography variant="body2">
          <strong>This is a separate engine from the web scanner.</strong> Native apps have no DOM, so
          there's no axe-core, no crawler, and no page overlay here. A11y Lens reads the platform's own
          accessibility tree — what TalkBack and VoiceOver actually see — and measures against Android
          and Apple's guidelines, mapped to WCAG 2.1 via WCAG2ICT.
        </Typography>
      </Alert>

      {/* --- device --------------------------------------------------- */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="overline" sx={{ flex: 1 }}>1 · Device</Typography>
          <Button size="small" startIcon={<RefreshIcon />} onClick={refresh}>Refresh</Button>
        </Stack>

        <ToggleButtonGroup exclusive size="small" value={platform} sx={{ mt: 1.5 }} disabled={flowActive}
          onChange={(_, v) => { if (v) { setPlatform(v); setDeviceId(""); setResult(null); } }}>
          <ToggleButton value="android"><AndroidIcon fontSize="small" sx={{ mr: 0.75 }} /> Android</ToggleButton>
          <ToggleButton value="ios"><PhoneIphoneIcon fontSize="small" sx={{ mr: 0.75 }} /> iOS</ToggleButton>
        </ToggleButtonGroup>

        {tool && !available && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {platform === "android" ? tool.android.hint : tool.ios.hint}
          </Alert>
        )}

        {available && (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 2 }}>
            <TextField select size="small" fullWidth label="Device or emulator" value={deviceId}
                       disabled={flowActive} onChange={(e) => setDeviceId(e.target.value)}>
              {!forPlatform.length && <MenuItem value="" disabled>No devices found</MenuItem>}
              {forPlatform.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.name} · {d.kind}{d.runtime ? ` · ${d.runtime}` : ""} · {d.state}
                </MenuItem>
              ))}
            </TextField>
            {selected && selected.state !== "booted" && (
              <Button variant="outlined" startIcon={<PlayArrowIcon />} onClick={boot}
                      sx={{ whiteSpace: "nowrap" }}>
                Start
              </Button>
            )}
          </Stack>
        )}

        {/* --- app launcher ------------------------------------------- */}
        {available && booted && (
          <>
            <Divider sx={{ my: 2 }} />
            <Typography variant="overline">App (optional)</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1 }}>
              <TextField select size="small" fullWidth value={appId}
                         label={appsLoading ? "Loading apps…" : "Installed app"}
                         onChange={(e) => setAppId(e.target.value)}>
                {!apps.length && <MenuItem value="" disabled>
                  {appsLoading ? "Loading…" : "No apps found"}
                </MenuItem>}
                {apps.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.name}{a.name !== a.id ? ` · ${a.id}` : ""}{a.kind === "system" ? " · system" : ""}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" startIcon={<RocketLaunchIcon />} disabled={!appId || launching}
                      onClick={launch} sx={{ whiteSpace: "nowrap" }}>
                {launching ? "Launching…" : "Launch"}
              </Button>
            </Stack>
            <FormControlLabel sx={{ mt: 0.5 }}
              control={<Checkbox size="small" checked={includeSystem}
                                 onChange={(e) => { setIncludeSystem(e.target.checked); loadApps(e.target.checked); }} />}
              label={<Typography variant="body2">Include system apps</Typography>}
            />
            {launchMsg && <Alert severity="success" sx={{ mt: 1 }}>{launchMsg}</Alert>}
          </>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
          A11y Lens reads whatever is on screen right now — it does not drive or navigate your app.
          Launch the app here (or open it by hand), get to the screen you want, then scan.
        </Typography>
      </Paper>

      {/* --- scan ----------------------------------------------------- */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="overline" sx={{ flex: 1 }}>2 · Scan</Typography>
          <ToggleButtonGroup exclusive size="small" value={mode} disabled={flowActive}
            onChange={(_, v) => { if (v) setMode(v); }}>
            <ToggleButton value="single">Single screen</ToggleButton>
            <ToggleButton value="flow"><RouteIcon fontSize="small" sx={{ mr: 0.75 }} /> Flow</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {mode === "single" && (
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1.5 }}>
            <Button variant="contained" onClick={scan} disabled={!available || !deviceId || scanning}>
              {scanning ? "Scanning…" : "Scan screen"}
            </Button>
            <FormControlLabel
              control={<Checkbox size="small" checked={aiReview} onChange={(e) => setAiReview(e.target.checked)} />}
              label={<Typography variant="body2">AI review (adds what measurement can't judge)</Typography>}
            />
          </Stack>
        )}

        {mode === "flow" && !flowActive && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              A flow scans a user journey one screen at a time — login, search, checkout — and
              de-duplicates across steps, so an issue on a shared component (tab bar, header) is
              counted once and tagged with every screen it appears on.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
              <TextField size="small" fullWidth label="Flow name (e.g. Checkout journey)"
                         value={flowName} onChange={(e) => setFlowName(e.target.value)} />
              <Button variant="contained" startIcon={<RouteIcon />} onClick={startFlow}
                      disabled={!available || !deviceId} sx={{ whiteSpace: "nowrap" }}>
                Start flow
              </Button>
            </Stack>
          </>
        )}

        {mode === "flow" && flowActive && (
          <>
            <Alert severity="info" sx={{ mt: 1.5 }}>
              <strong>{flowName || "Flow"}</strong> is recording — navigate the app to each screen you
              want to test, then scan it as a step.
            </Alert>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
              <TextField size="small" fullWidth label={`Step ${flowSteps.length + 1} label (e.g. Login screen)`}
                         value={stepLabel} onChange={(e) => setStepLabel(e.target.value)} />
              <Button variant="contained" onClick={scanStep} disabled={scanning}
                      sx={{ whiteSpace: "nowrap" }}>
                {scanning ? "Scanning…" : "Scan step"}
              </Button>
            </Stack>
            <FormControlLabel sx={{ mt: 0.5 }}
              control={<Checkbox size="small" checked={aiReview} onChange={(e) => setAiReview(e.target.checked)} />}
              label={<Typography variant="body2">AI review on each step</Typography>}
            />

            {flowSteps.length > 0 && (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
                {flowSteps.map((s) => (
                  <Tooltip key={s.index}
                    title={`${s.counts.critical}C · ${s.counts.serious}S · ${s.counts.moderate}M · ${s.counts.minor}m — ${s.newFindings} new`}>
                    <Chip size="small" variant="outlined" label={`${s.index}. ${s.label}`} />
                  </Tooltip>
                ))}
              </Stack>
            )}

            <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
              <Button variant="contained" color="success" startIcon={<StopIcon />}
                      onClick={finishFlow} disabled={scanning || !flowSteps.length}>
                Finish flow ({flowSteps.length} step{flowSteps.length === 1 ? "" : "s"})
              </Button>
              <Button variant="text" color="inherit" onClick={cancelFlow} disabled={scanning}>
                Cancel
              </Button>
            </Stack>
          </>
        )}

        {scanning && <LinearProgress sx={{ mt: 2 }} />}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
            {hint && <Typography variant="body2" sx={{ mt: 0.5 }}>{hint}</Typography>}
          </Alert>
        )}
      </Paper>

      {/* --- results -------------------------------------------------- */}
      {result && (
        <Paper sx={{ p: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6">
              {result.flow
                ? result.name ?? "Flow"
                : result.device?.model ?? result.platform}
              {!result.flow && result.device?.release
                ? ` · ${result.platform === "android" ? "Android" : "iOS"} ${result.device.release}` : ""}
            </Typography>
            {result.flow && (
              <Chip size="small" color="primary" variant="outlined"
                    label={`${result.stats.stepsScanned ?? result.steps?.length ?? 0} steps`} />
            )}
            {result.app && <Chip size="small" variant="outlined" label={result.app.package} />}
            {result.provider && <Chip size="small" variant="outlined" label={result.provider} />}
            {result.cost && (result.usage?.inputTokens ?? 0) > 0 && (
              <Tooltip title={`${(result.usage?.inputTokens ?? 0).toLocaleString()} in / ${(result.usage?.outputTokens ?? 0).toLocaleString()} out tokens${result.cost.pricedAs ? ` · priced as ${result.cost.pricedAs}` : ""}`}>
                <Chip size="small" color={result.cost.usd === null ? "warning" : "success"} variant="outlined"
                      label={
                        result.cost.usd === null ? `${((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)).toLocaleString()} tokens`
                          : result.cost.usd === 0 ? "local · free"
                            : `$${result.cost.usd.toFixed(4)}`
                      } />
              </Tooltip>
            )}
            <Box sx={{ flex: 1 }} />
            <Button size="small" startIcon={<DescriptionIcon />} onClick={exportReport} disabled={exporting}>
              {exporting ? "Writing…" : "Export HTML report"}
            </Button>
            {result.provider && (result.usage?.inputTokens ?? 0) > 0 && (
              <Tooltip title="Management-facing report: model used, token consumption, and estimated AI cost for this scan.">
                <Button size="small" startIcon={<PaidOutlinedIcon />} onClick={exportCostReport} disabled={exportingCost}>
                  {exportingCost ? "Writing…" : "AI cost report"}
                </Button>
              </Tooltip>
            )}
          </Stack>

          {exportedPath && (
            <Alert severity="success" sx={{ mt: 2 }}>
              Report written to <code>{exportedPath}</code> — a single self-contained file you can
              attach to a ticket or an email.
            </Alert>
          )}

          {!result.treeAvailable && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <strong>The accessibility tree could not be captured.</strong> Only the visual AI review
              ran — the deterministic label and touch-target checks need the element tree and were
              skipped. {result.treeWarning}
            </Alert>
          )}

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
            {(["critical", "serious", "moderate", "minor"] as const).map((l) =>
              result.counts[l] > 0 ? <SeverityChip key={l} level={l} count={result.counts[l]} /> : null
            )}
            <Chip size="small" color="success" variant="outlined"
                  label={`${result.stats.fromMeasured} measured`} />
            {result.stats.fromAi > 0 && (
              <Chip size="small" variant="outlined" label={`${result.stats.fromAi} from AI`} />
            )}
            {result.stats.unverified > 0 && (
              <Chip size="small" color="warning" variant="outlined"
                    label={`${result.stats.unverified} unverified`} />
            )}
            {result.flow && (result.stats.deduplicated ?? 0) > 0 && (
              <Tooltip title={`${result.stats.rawFindings} findings across all steps merged down to ${result.findings.length} unique issues.`}>
                <Chip size="small" variant="outlined" label={`${result.stats.deduplicated} duplicates merged`} />
              </Tooltip>
            )}
          </Stack>

          {!result.flow && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
              {result.stats.interactiveElements ?? 0} interactive elements ·{" "}
              {result.stats.labeledInteractive ?? 0} labelled
              {result.stats.densityDpi ? ` · ${result.stats.densityDpi}dpi` : ""}
            </Typography>
          )}

          <Divider sx={{ my: 2 }} />

          {result.findings.map((f, i) => (
            <Accordion key={i} disableGutters>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1.25} alignItems="center" sx={{ width: "100%", pr: 1 }}>
                  <SeverityChip level={f.impact} />
                  {f.measured ? (
                    <Tooltip title="Measured directly from the platform accessibility tree — not an AI judgement, so it cannot be a hallucination.">
                      <Chip size="small" label="measured" color="success"
                            sx={{ height: 20, fontSize: 10.5, fontWeight: 700 }} />
                    </Tooltip>
                  ) : f.evidenceStatus === "verified" ? (
                    <Tooltip title="The AI's quote was found verbatim in the captured accessibility tree.">
                      <VerifiedIcon fontSize="small" sx={{ color: "#7BE8B0" }} />
                    </Tooltip>
                  ) : (
                    <Tooltip title="The AI's quote was NOT found in the accessibility tree. Confirm manually.">
                      <HelpOutlineIcon fontSize="small" sx={{ color: "#FFB35C" }} />
                    </Tooltip>
                  )}
                  <Typography sx={{ fontWeight: 600, flex: 1 }}>{f.title}</Typography>
                  {result.flow && f.seenInSteps && (
                    <Chip size="small" variant="outlined"
                          label={`step${f.seenInSteps.length === 1 ? "" : "s"} ${f.seenInSteps.join(", ")}`}
                          sx={{ height: 20, fontSize: 10.5 }} />
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {f.wcag?.join(", ") || f.guideline || ""}
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" sx={{ mb: 1.5 }}>{f.explanation}</Typography>
                {f.userImpact && (
                  <>
                    <Typography variant="overline">User impact</Typography>
                    <Typography variant="body2" sx={{ mb: 1.5 }}>{f.userImpact}</Typography>
                  </>
                )}
                <Typography variant="overline">Evidence — from the accessibility tree</Typography>
                <Box component="pre" sx={preSx}>{f.evidence}</Box>
                <Typography variant="overline">Fix</Typography>
                <Box component="pre" sx={{ ...preSx, borderColor: "rgba(123,232,176,0.25)" }}>{f.fix}</Box>
              </AccordionDetails>
            </Accordion>
          ))}

          {result.passes.length > 0 && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2 }}>What works</Typography>
              {result.passes.map((p, i) => (
                <Typography key={i} variant="body2" sx={{ color: "#7BE8B0" }}>✓ {p}</Typography>
              ))}
            </>
          )}

          {result.flow && result.steps && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2 }}>Journey</Typography>
              {result.steps.map((s) => (
                <Typography key={s.index} variant="body2" color="text.secondary">
                  {s.index}. <strong>{s.label}</strong>
                  {s.app?.package ? ` · ${s.app.package}` : ""} ·{" "}
                  {new Date(s.timestamp).toLocaleTimeString()} · {s.newFindings} new
                </Typography>
              ))}
            </>
          )}

          {result.screenshot && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="overline">{result.flow ? "First screen" : "Screen"}</Typography>
              <Box component="img" src={`data:image/png;base64,${result.screenshot}`}
                   alt="Screenshot of the scanned mobile screen"
                   sx={{ display: "block", maxWidth: 300, mt: 1, borderRadius: 2,
                         border: "1px solid rgba(154,167,180,0.25)" }} />
            </Box>
          )}
        </Paper>
      )}
    </Stack>
  );
}

const preSx = {
  m: 0, mb: 1.5, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
  border: "1px solid rgba(154,167,180,0.15)", fontSize: 12.5,
  fontFamily: "IBM Plex Mono, monospace", whiteSpace: "pre-wrap",
  wordBreak: "break-word" as const, color: "#C8D3DE",
};
