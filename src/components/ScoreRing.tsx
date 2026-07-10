import { Box, Typography } from "@mui/material";
import { severity } from "../theme/theme";

// Signature "lens ring" — an SVG dial whose arc color tracks the score.
export default function ScoreRing({ score, size = 148 }: { score: number; size?: number }) {
  const r = 62, c = 2 * Math.PI * r;
  const color = score >= 90 ? severity.pass : score >= 70 ? severity.moderate : severity.critical;
  return (
    <Box sx={{ position: "relative", width: size, height: size }} role="img"
         aria-label={`Accessibility score ${score} out of 100`}>
      <svg viewBox="0 0 148 148" width={size} height={size}>
        <circle cx="74" cy="74" r={r} fill="none" stroke="rgba(154,167,180,0.15)" strokeWidth="10" />
        <circle cx="74" cy="74" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          transform="rotate(-90 74 74)"
          style={{ transition: "stroke-dashoffset 900ms ease, stroke 400ms ease" }} />
      </svg>
      <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <Box textAlign="center">
          <Typography variant="h4" component="div">{score}</Typography>
          <Typography variant="overline">/ 100</Typography>
        </Box>
      </Box>
    </Box>
  );
}
