import { HashRouter, Routes, Route, NavLink } from "react-router-dom";
import { ThemeProvider, CssBaseline, Box, Stack, Typography } from "@mui/material";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import RadarIcon from "@mui/icons-material/Radar";
import DescriptionIcon from "@mui/icons-material/Description";
import BugReportIcon from "@mui/icons-material/BugReport";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import PhoneAndroidIcon from "@mui/icons-material/PhoneAndroid";
import SettingsIcon from "@mui/icons-material/Settings";
import { theme } from "./theme/theme";
import SidecarGate from "./components/SidecarGate";
import ErrorBanner from "./components/ErrorBanner";
import Dashboard from "./pages/Dashboard";
import ScanCenter from "./pages/ScanCenter";
import Reports from "./pages/Reports";
import Logs from "./pages/Logs";
import CrawlExplorer from "./pages/CrawlExplorer";
import MobileScanner from "./pages/MobileScanner";
import Settings from "./pages/Settings";

const nav = [
  { to: "/", label: "Dashboard", icon: <DashboardIcon fontSize="small" /> },
  { to: "/crawl", label: "Crawl Explorer", icon: <AccountTreeIcon fontSize="small" /> },
  { to: "/scan", label: "Scan Center", icon: <RadarIcon fontSize="small" /> },
  { to: "/mobile", label: "Mobile Scanner", icon: <PhoneAndroidIcon fontSize="small" /> },
  { to: "/reports", label: "Reports", icon: <DescriptionIcon fontSize="small" /> },
  { to: "/logs", label: "Logs", icon: <BugReportIcon fontSize="small" /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon fontSize="small" /> },
];

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <SidecarGate>
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
            <ErrorBanner />
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/crawl" element={<CrawlExplorer />} />
              <Route path="/scan" element={<ScanCenter />} />
              <Route path="/mobile" element={<MobileScanner />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </Box>
        </Box>
      </HashRouter>
      </SidecarGate>
    </ThemeProvider>
  );
}
