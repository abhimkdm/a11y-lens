import {
  Accordion, AccordionSummary, AccordionDetails, Typography, Stack, Box,
  Button, Link, Tooltip,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import SeverityChip from "./SeverityChip";
import { useAppStore, type Violation } from "../store/useAppStore";

export default function ViolationList({ violations }: { violations: Violation[] }) {
  const { ignored, ignoreRule } = useAppStore();
  const visible = violations.filter((v) => !ignored[v.id]);
  if (!visible.length)
    return <Typography color="text.secondary" sx={{ p: 3 }}>No open violations. Nice work.</Typography>;

  return (
    <Box>
      {visible.map((v) => (
        <Accordion key={v.id} disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: "100%" }}>
              <SeverityChip level={v.impact} />
              <Typography sx={{ fontWeight: 600 }}>{v.help}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ ml: "auto", mr: 2 }}>
                {v.nodes.length} element{v.nodes.length > 1 ? "s" : ""} · {v.wcag.join(", ") || "best practice"}
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" sx={{ mb: 1.5 }}>{v.description}</Typography>
            {v.nodes.map((n, i) => (
              <Box key={i} sx={{ mb: 1.5, p: 1.5, borderRadius: 1.5, bgcolor: "#0E1116",
                                 border: "1px solid rgba(154,167,180,0.15)" }}>
                <Typography variant="caption" color="primary">{n.target}</Typography>
                <Box component="pre" sx={{ m: 0, mt: 0.5, fontSize: 12.5, whiteSpace: "pre-wrap",
                                           fontFamily: "IBM Plex Mono, monospace", color: "#C8D3DE" }}>
                  {n.html}
                </Box>
                <Typography variant="caption" color="text.secondary">{n.failureSummary}</Typography>
              </Box>
            ))}
            <Stack direction="row" spacing={1}>
              <Tooltip title="Copy the failing selector">
                <Button size="small" startIcon={<ContentCopyIcon />}
                  onClick={() => navigator.clipboard.writeText(v.nodes[0]?.target ?? "")}>
                  Copy selector
                </Button>
              </Tooltip>
              <Button size="small" color="inherit" startIcon={<VisibilityOffIcon />}
                onClick={() => ignoreRule(v.id, "Marked from scan view")}>
                Ignore rule
              </Button>
              <Link href={v.helpUrl} target="_blank" rel="noreferrer" sx={{ ml: "auto", alignSelf: "center" }}>
                Deque rule docs
              </Link>
            </Stack>
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}
