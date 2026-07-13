import { useState } from "react";
import {
  Paper, Typography, Stack, Chip, Box, Accordion, AccordionSummary,
  AccordionDetails, Divider, Tooltip, FormControlLabel, Switch, Alert,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import VerifiedIcon from "@mui/icons-material/Verified";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import SeverityChip from "./SeverityChip";
import type { ExpertAudit } from "../store/useAppStore";

const TIER = {
  deterministic: { label: "measured", color: "#7BE8B0", tip: "Measured deterministically by a probe. Not an AI judgement — it cannot be a hallucination." },
  consensus:     { label: "consensus", color: "#7BE8B0", tip: "Both models independently flagged this from the same evidence. Highest confidence." },
  confirmed:     { label: "confirmed", color: "#8AC7FF", tip: "One model flagged it; the other model, shown the same evidence, agreed it is real." },
  single:        { label: "needs review", color: "#FFB35C", tip: "Only one model flagged this, and the other did not confirm it. Verify before raising a ticket." },
} as const;

export default function ExpertAuditPanel({ audit }: { audit: ExpertAudit }) {
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [trustedOnly, setTrustedOnly] = useState(false);
  const isCrossCheck = audit.mode === "cross-check";

  let shown = audit.findings;
  if (verifiedOnly) shown = shown.filter((f) => f.evidenceStatus === "verified");
  if (trustedOnly) shown = shown.filter((f) => f.agreement && f.agreement !== "single");

  // Group by zone the way a human reviewer would present them.
  const zones = [...new Set(shown.map((f) => f.zone))];

  return (
    <Paper variant="outlined" sx={{ p: 3, bgcolor: "#10151C" }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
        <Typography variant="h6">AI Expert Audit</Typography>
        <Chip size="small" variant="outlined" label={audit.provider} />
        {audit.durationMs && (
          <Chip size="small" variant="outlined" label={`${Math.round(audit.durationMs / 1000)}s`} />
        )}
        {audit.cost && (
          <Tooltip title={audit.cost.note ?? `${audit.cost.inputTokens} in / ${audit.cost.outputTokens} out tokens${audit.cost.pricedAs ? ` · priced as ${audit.cost.pricedAs}` : ""}`}>
            <Chip size="small" variant="outlined"
              label={audit.cost.usd === null ? `${audit.cost.inputTokens + audit.cost.outputTokens} tokens`
                : audit.cost.usd === 0 ? "local · free"
                : `$${audit.cost.usd.toFixed(4)}`} />
          </Tooltip>
        )}
        {audit.scope && <Chip size="small" variant="outlined" label={`scope: ${audit.scope}`} />}
        <Chip size="small" variant="outlined" label={audit.stats.standard ?? "WCAG 2.1 A/AA"} />
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
          {new Date(audit.generatedAt).toLocaleString()}
        </Typography>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Findings automated scanners structurally cannot detect — meaningful names, focus management,
        state exposure, and visual-vs-programmatic mismatch.
      </Typography>

      {isCrossCheck && audit.stats.tiers && (
        <Alert severity={(audit.stats.agreementRate ?? 0) >= 40 ? "success" : "warning"} sx={{ mb: 2 }}>
          <strong>Cross-check:</strong> {audit.agentA} vs {audit.agentB} on identical evidence.{" "}
          {audit.stats.tiers.consensus} consensus · {audit.stats.tiers.confirmed} confirmed ·{" "}
          {audit.stats.tiers.deterministic} measured · <strong>{audit.stats.tiers.single} need review</strong>.
          {" "}Two independent models agreed on <strong>{audit.stats.agreementRate}%</strong> of their findings
          {(audit.stats.agreementRate ?? 0) < 40 && " — low agreement, treat single-model findings with extra caution"}.
        </Alert>
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
        {(["critical", "serious", "moderate", "minor"] as const).map((lvl) =>
          audit.counts[lvl] > 0 ? <SeverityChip key={lvl} level={lvl} count={audit.counts[lvl]} /> : null
        )}
        <Tooltip title="Evidence quote was found verbatim in the DOM, accessibility tree, or keyboard walk we gave the model.">
          <Chip size="small" icon={<VerifiedIcon />} color="success" variant="outlined"
                label={`${audit.stats.verified} evidence-verified`} />
        </Tooltip>
        {audit.stats.unverified > 0 && (
          <Tooltip title="The model's evidence quote could NOT be located in the supplied inputs. Treat these as unconfirmed and review manually.">
            <Chip size="small" icon={<HelpOutlineIcon />} color="warning" variant="outlined"
                  label={`${audit.stats.unverified} unverified`} />
          </Tooltip>
        )}
      </Stack>

      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <FormControlLabel
          control={<Switch size="small" checked={verifiedOnly}
                           onChange={(e) => setVerifiedOnly(e.target.checked)} />}
          label={<Typography variant="body2">Evidence-verified only</Typography>}
        />
        {isCrossCheck && (
          <FormControlLabel
            control={<Switch size="small" checked={trustedOnly}
                             onChange={(e) => setTrustedOnly(e.target.checked)} />}
            label={<Typography variant="body2">Trusted only (hide single-model findings)</Typography>}
          />
        )}
        <Typography variant="caption" color="text.secondary">
          {audit.stats.fromProbes ? `${audit.stats.fromProbes} measured by probe · ${audit.stats.fromAi} from AI · ` : ""}
          Scanner rules suppressed: {audit.stats.suppressedRules.length || "none"}
          {audit.stats.droppedAsScannerDuplicate > 0 &&
            ` · ${audit.stats.droppedAsScannerDuplicate} duplicate(s) dropped`}
          {" · "}keyboard walk: {audit.stats.keyboardWalkSteps} steps
          {audit.stats.focusProbeChecked
            ? ` · focus probe: ${audit.stats.focusProbeMissing}/${audit.stats.focusProbeChecked} missing indicator`
            : ""}
          {!audit.stats.screenshotIncluded && " · no screenshot"}
          {audit.stats.domTruncated && " · DOM truncated"}
        </Typography>
      </Stack>

      {audit.stats.unverified > 0 && !verifiedOnly && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {audit.stats.unverified} finding{audit.stats.unverified === 1 ? "" : "s"} could not be traced back
          to a verbatim quote in the captured evidence. They may still be real — but confirm them manually
          before raising a ticket.
        </Alert>
      )}

      <Divider sx={{ mb: 2 }} />

      {!shown.length && (
        <Typography variant="body2" color="text.secondary">No findings to show with the current filter.</Typography>
      )}

      {zones.map((zone) => (
        <Box key={zone} sx={{ mb: 2 }}>
          <Typography variant="overline" sx={{ color: "primary.main" }}>{zone}</Typography>
          {shown.filter((f) => f.zone === zone).map((f, i) => (
            <Accordion key={i} disableGutters sx={{ bgcolor: "#161C24" }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1.25} alignItems="center" sx={{ width: "100%", pr: 1 }}>
                  <SeverityChip level={f.severity} />
                  {f.agreement && TIER[f.agreement] ? (
                    <Tooltip title={TIER[f.agreement].tip}>
                      <Chip size="small" label={TIER[f.agreement].label}
                            sx={{ height: 20, fontSize: 10.5, fontWeight: 700,
                                  bgcolor: `${TIER[f.agreement].color}22`,
                                  color: TIER[f.agreement].color,
                                  border: `1px solid ${TIER[f.agreement].color}55` }} />
                    </Tooltip>
                  ) : f.source === "probe" ? (
                    <Tooltip title="Measured deterministically by a probe — not an AI judgement, cannot be a hallucination">
                      <Chip size="small" label="measured" color="success"
                            sx={{ height: 20, fontSize: 10.5, fontWeight: 700 }} />
                    </Tooltip>
                  ) : f.evidenceStatus === "verified" ? (
                    <Tooltip title="Evidence verified against captured DOM / ARIA tree / keyboard walk">
                      <VerifiedIcon fontSize="small" sx={{ color: "#7BE8B0" }} />
                    </Tooltip>
                  ) : (
                    <Tooltip title="Evidence could not be located in the captured inputs — confirm manually">
                      <HelpOutlineIcon fontSize="small" sx={{ color: "#FFB35C" }} />
                    </Tooltip>
                  )}
                  <Typography sx={{ fontWeight: 600, flex: 1 }}>{f.title}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {f.wcag.join(", ") || "—"}
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" sx={{ mb: 1.5 }}>{f.description}</Typography>

                <Typography variant="overline">User impact</Typography>
                <Typography variant="body2" sx={{ mb: 1.5 }}>{f.userImpact}</Typography>

                <Typography variant="overline">Evidence</Typography>
                <Box component="pre" sx={{
                  m: 0, mb: 1.5, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
                  border: "1px solid rgba(154,167,180,0.15)", fontSize: 12.5,
                  fontFamily: "IBM Plex Mono, monospace", whiteSpace: "pre-wrap",
                  color: f.evidenceStatus === "verified" ? "#C8D3DE" : "#FFD9B0",
                }}>{f.evidence}</Box>

                {f.adjudication && (
                  <>
                    <Typography variant="overline">
                      Second-model verdict ({f.adjudication.by}: {f.adjudication.verdict})
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 1.5, color: f.adjudication.verdict === "real" ? "#7BE8B0" : "#FFB35C" }}>
                      {f.adjudication.reason}
                    </Typography>
                  </>
                )}

                <Typography variant="overline">Fix</Typography>
                <Box component="pre" sx={{
                  m: 0, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
                  border: "1px solid rgba(123,232,176,0.25)", fontSize: 12.5,
                  fontFamily: "IBM Plex Mono, monospace", whiteSpace: "pre-wrap", color: "#C8D3DE",
                }}>{f.fix}</Box>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      ))}

      {audit.passes.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="overline">What works ({audit.passes.length})</Typography>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {audit.passes.map((p, i) => (
              <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
                <CheckCircleOutlineIcon fontSize="small" sx={{ color: "#7BE8B0", mt: 0.25 }} />
                <Typography variant="body2">
                  <strong>{p.zone}:</strong> {p.message}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Paper>
  );
}
