import { useState } from "react";
import {
  Paper, Typography, Stack, Tabs, Tab, Box, Chip, Divider,
} from "@mui/material";
import VerifiedIcon from "@mui/icons-material/Verified";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import Tooltip from "@mui/material/Tooltip";
import Alert from "@mui/material/Alert";
import ElementEvidence from "./ElementEvidence";
import SeverityChip from "./SeverityChip";
import type { AiReport } from "../store/useAppStore";

function CodeBlock({ code }: { code: string }) {
  return (
    <Box component="pre" sx={{
      m: 0, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
      border: "1px solid rgba(154,167,180,0.15)", fontSize: 12.5,
      fontFamily: "IBM Plex Mono, monospace", whiteSpace: "pre-wrap", color: "#C8D3DE",
    }}>{code}</Box>
  );
}

export default function AiReportPanel({ report }: { report: AiReport }) {
  const [tabs, setTabs] = useState<Record<number, number>>({});
  const frameworks = ["html", "react", "angular"] as const;

  return (
    <Paper variant="outlined" sx={{ p: 3, bgcolor: "#10151C" }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Typography variant="h6">AI Report</Typography>
        <Chip size="small" variant="outlined" label={report.provider} />
        {report.evidence && (
          <Tooltip title={`The model was shown ${report.evidence.imagesUsed} screenshot(s) and the real DOM of every failing element, across ${report.evidence.scenarios} scenario(s).`}>
            <Chip size="small" variant="outlined"
                  label={`${report.evidence.imagesUsed} screenshots · ${report.evidence.scenarios} scenarios`} />
          </Tooltip>
        )}
        {!!report.evidence?.focusableTraced && (
          <Tooltip title={`Keyboard focus order was walked across ${report.evidence.focusableTraced} focusable elements. A scanner cannot do this — it cannot press Tab.`}>
            <Chip size="small" variant="outlined" color={report.evidence.focusIndicatorsMissing ? "warning" : "default"}
                  label={`keyboard: ${report.evidence.focusableTraced} traced${report.evidence.focusIndicatorsMissing ? ` · ${report.evidence.focusIndicatorsMissing} no focus ring` : ""}`} />
          </Tooltip>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
          {new Date(report.generatedAt).toLocaleString()}
        </Typography>
      </Stack>

      {report.evidence && report.evidence.unverified > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {report.evidence.unverified} of {report.evidence.verified + report.evidence.unverified} fixes cite
          evidence that could not be traced back to the captured page. They are marked unverified below —
          confirm those before acting on them.
        </Alert>
      )}

      <Typography variant="overline">Executive summary</Typography>
      <Typography variant="body2" sx={{ mb: 2 }}>{report.executiveSummary}</Typography>

      <Typography variant="overline">Business impact</Typography>
      <Typography variant="body2" sx={{ mb: 2 }}>{report.businessImpact}</Typography>

      {report.quickWins?.length > 0 && (
        <>
          <Typography variant="overline">Quick wins</Typography>
          <Stack spacing={0.5} sx={{ mb: 2 }}>
            {report.quickWins.map((q, i) => (
              <Typography key={i} variant="body2">→ {q}</Typography>
            ))}
          </Stack>
        </>
      )}

      <Divider sx={{ my: 2 }} />
      <Typography variant="overline">Developer fixes</Typography>
      <Stack spacing={2} sx={{ mt: 1 }}>
        {report.fixes.map((f, i) => (
          <Box key={i}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <SeverityChip level={f.impact} />
              {f.measured ? (
                <Tooltip title="Measured deterministically by walking the focus order and reading computed focus styles. Not an AI judgement — it cannot be a hallucination.">
                  <Chip size="small" label="measured" color="success"
                        sx={{ height: 20, fontSize: 10.5, fontWeight: 700 }} />
                </Tooltip>
              ) : f.evidenceStatus === "verified" ? (
                <Tooltip title="The cited evidence was found verbatim in the captured page.">
                  <VerifiedIcon fontSize="small" sx={{ color: "#7BE8B0" }} />
                </Tooltip>
              ) : f.evidenceStatus === "unverified" ? (
                <Tooltip title="The cited evidence could NOT be found in the captured page. Confirm manually before acting on this fix.">
                  <HelpOutlineIcon fontSize="small" sx={{ color: "#FFB35C" }} />
                </Tooltip>
              ) : null}
              <Typography sx={{ fontWeight: 600 }}>{f.title}</Typography>
              <Typography variant="caption" color="text.secondary">{f.rule}</Typography>
              {f.wcag?.length ? (
                <Chip size="small" variant="outlined" label={`WCAG ${f.wcag.join(", ")}`} sx={{ height: 20, fontSize: 10.5 }} />
              ) : null}
              {f.scenario && <Chip size="small" variant="outlined" label={f.scenario} sx={{ height: 20, fontSize: 10.5 }} />}
            </Stack>
            <Typography variant="body2" sx={{ my: 0.75 }}>{f.explanation}</Typography>

            {f.evidence && (
              <>
                <Typography variant="overline">Evidence{f.selector ? ` · ${f.selector}` : ""}</Typography>
                <CodeBlock code={f.evidence} />
              </>
            )}
            {f.screenshot && (
              <ElementEvidence node={{ target: f.selector ?? "", html: "", failureSummary: "", screenshot: f.screenshot }} />
            )}
            {!f.measured && (
            <Tabs value={tabs[i] ?? 0} onChange={(_, v) => setTabs({ ...tabs, [i]: v })}
                  sx={{ minHeight: 34, mb: 1 }}>
              {frameworks.map((fw) => (
                <Tab key={fw} label={fw.toUpperCase()} sx={{ minHeight: 34, py: 0 }} />
              ))}
            </Tabs>
            )}
            {!f.measured && <CodeBlock code={f[frameworks[tabs[i] ?? 0]]} />}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
