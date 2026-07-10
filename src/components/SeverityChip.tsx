import { Chip } from "@mui/material";
import { severity, } from "../theme/theme";
import type { Severity } from "../store/useAppStore";

export default function SeverityChip({ level, count }: { level: Severity; count?: number }) {
  return (
    <Chip size="small"
      label={count !== undefined ? `${level} · ${count}` : level}
      sx={{ bgcolor: `${severity[level]}22`, color: severity[level],
            border: `1px solid ${severity[level]}55`, fontWeight: 600, textTransform: "capitalize" }} />
  );
}
