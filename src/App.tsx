import { HashRouter, Routes, Route, NavLink } from "react-router-dom";
import { ThemeProvider, CssBaseline, Box, Stack, Typography } from "@mui/material";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import RadarIcon from "@mui/icons-material/Radar";
import DescriptionIcon from "@mui/icons-material/Description";
import SettingsIcon from "@mui/icons-material/Settings";
import { theme } from "./theme/theme";
import Dashboard from "./pages/Dashboard";
import ScanCenter from "./pages/ScanCenter";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";

const nav = [
  { to: "/", label: "Dashboard", icon: <DashboardIcon fontSize="small" /> },
  { to: "/scan", label: "Scan Center", icon: <RadarIcon fontSize="small" /> },
  { to: "/reports", label: "Reports", icon: <DescriptionIcon fontSize="small" /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon fontSize="small" /> },
];

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <HashRouter>
        <Box sx={{ display: "flex", minHeight: "100vh" }}>
          <Box component="nav" aria-label="Primary"
            sx={{ width: 216, flexShrink: 0, borderRight: "1px solid", borderColor: "divider", p: 2 }}>
            <Typography variant="h6" sx={{ px: 1, mb: 3 }}>
              ◎ A11y Lens
            </Typography>
            <Stack spacing={0.5}>
              {nav.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/"} style={{ textDecoration: "none" }}>
                  {({ isActive }) => (
                    <Stack direction="row" spacing={1.25} alignItems="center"
                      sx={{
                        px: 1.5, py: 1, borderRadius: 2, color: isActive ? "primary.main" : "text.secondary",
                        bgcolor: isActive ? "rgba(138,199,255,0.10)" : "transparent",
                        "&:hover": { bgcolor: "rgba(138,199,255,0.06)" },
                      }}>
                      {n.icon}
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{n.label}</Typography>
                    </Stack>
                  )}
                </NavLink>
              ))}
            </Stack>
          </Box>
          <Box component="main" sx={{ flex: 1, p: 3.5, minWidth: 0 }}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/scan" element={<ScanCenter />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </Box>
        </Box>
      </HashRouter>
    </ThemeProvider>
  );
}
