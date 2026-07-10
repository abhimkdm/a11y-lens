import { createTheme } from "@mui/material/styles";

// A11y Lens design tokens — the UI itself must pass WCAG AA.
// Signature element: the "lens ring" score dial + severity spectrum.
export const severity = {
  critical: "#FF7B7B",
  serious:  "#FFB35C",
  moderate: "#FFD966",
  minor:    "#8AC7FF",
  pass:     "#7BE8B0",
} as const;

export const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0E1116", paper: "#161C24" },
    primary: { main: "#8AC7FF" },
    secondary: { main: "#7BE8B0" },
    text: { primary: "#E9EEF5", secondary: "#9AA7B4" },
    divider: "rgba(154,167,180,0.18)",
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: `"IBM Plex Sans","Segoe UI",system-ui,sans-serif`,
    h4: { fontWeight: 700, letterSpacing: "-0.02em" },
    h6: { fontWeight: 600 },
    overline: { letterSpacing: "0.14em", color: "#9AA7B4" },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600,
          "&:focus-visible": { outline: "2px solid #8AC7FF", outlineOffset: 2 },
        },
      },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none", border: "1px solid rgba(154,167,180,0.12)" } } },
  },
});
