import { useState } from "react";
import {
  Paper, Typography, Stack, Tabs, Tab, Box, Chip, Divider,
} from "@mui/material";
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
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
          {new Date(report.generatedAt).toLocaleString()}
        </Typography>
      </Stack>

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
            <Stack direction="row" spacing={1} alignItems="center">
              <SeverityChip level={f.impact} />
              <Typography sx={{ fontWeight: 600 }}>{f.title}</Typography>
              <Typography variant="caption" color="text.secondary">{f.rule}</Typography>
            </Stack>
            <Typography variant="body2" sx={{ my: 0.75 }}>{f.explanation}</Typography>
            <Tabs value={tabs[i] ?? 0} onChange={(_, v) => setTabs({ ...tabs, [i]: v })}
                  sx={{ minHeight: 34, mb: 1 }}>
              {frameworks.map((fw) => (
                <Tab key={fw} label={fw.toUpperCase()} sx={{ minHeight: 34, py: 0 }} />
              ))}
            </Tabs>
            <CodeBlock code={f[frameworks[tabs[i] ?? 0]]} />
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
