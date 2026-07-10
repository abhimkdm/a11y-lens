import { Grid2 as Grid, Paper, Typography, Stack, Box, Button } from "@mui/material";
import { useNavigate } from "react-router-dom";
import ScoreRing from "../components/ScoreRing";
import SeverityChip from "../components/SeverityChip";
import { useAppStore } from "../store/useAppStore";

export default function Dashboard() {
  const { currentScan, history } = useAppStore();
  const nav = useNavigate();

  if (!currentScan)
    return (
      <Box sx={{ display: "grid", placeItems: "center", height: "70vh" }}>
        <Stack spacing={2} alignItems="center">
          <Typography variant="h4">No scans yet</Typography>
          <Typography color="text.secondary">
            Open a browser session, log in to your application, and run your first scan.
          </Typography>
          <Button variant="contained" size="large" onClick={() => nav("/scan")}>
            Go to Scan Center
          </Button>
        </Stack>
      </Box>
    );

  const s = currentScan;
  return (
    <Grid container spacing={2.5}>
      <Grid size={{ xs: 12, md: 4 }}>
        <Paper sx={{ p: 3, display: "grid", placeItems: "center", height: "100%" }}>
          <Stack spacing={1.5} alignItems="center">
            <Typography variant="overline">Latest score</Typography>
            <ScoreRing score={s.score} />
            <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 260 }}>
              {s.title || s.url}
            </Typography>
          </Stack>
        </Paper>
      </Grid>
      <Grid size={{ xs: 12, md: 8 }}>
        <Paper sx={{ p: 3, height: "100%" }}>
          <Typography variant="overline">Open issues by severity</Typography>
          <Stack direction="row" spacing={1.5} sx={{ mt: 2, flexWrap: "wrap" }}>
            {(["critical", "serious", "moderate", "minor"] as const).map((lvl) => (
              <SeverityChip key={lvl} level={lvl} count={s.counts[lvl] ?? 0} />
            ))}
          </Stack>
          <Typography variant="overline" sx={{ display: "block", mt: 4 }}>Recent scans</Typography>
          <Stack spacing={1} sx={{ mt: 1 }}>
            {history.slice(0, 5).map((h, i) => (
              <Stack key={i} direction="row" justifyContent="space-between"
                     sx={{ p: 1.25, borderRadius: 1.5, bgcolor: "#0E1116" }}>
                <Typography variant="body2" noWrap sx={{ maxWidth: "60%" }}>{h.url}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {new Date(h.timestamp).toLocaleString()} · {h.score}/100
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Button sx={{ mt: 2 }} onClick={() => nav("/reports")}>View all reports</Button>
        </Paper>
      </Grid>
    </Grid>
  );
}
