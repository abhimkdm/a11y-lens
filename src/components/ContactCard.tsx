import { useState } from "react";
import {
  Paper, Typography, Stack, Button, Avatar, Divider, Tooltip, IconButton, Snackbar,
} from "@mui/material";
import EmailIcon from "@mui/icons-material/Email";
import ChatIcon from "@mui/icons-material/Chat";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import BadgeIcon from "@mui/icons-material/Badge";

const OWNER = {
  name: "Abhishek M Kadam",
  role: "System Architect",
  email: "Abhishek.M.Kadam@netcracker.com",
  webex: "webexteams://im?space=25f42ac0-7e9d-11f1-a1ea-df11035388c8",
};

// Opening an external URL is genuinely different inside the packaged app.
//
//   Tauri desktop — the webview will NOT hand a `mailto:` or `webexteams:` link
//                   to the OS on its own. It must go through the shell plugin,
//                   which is why a plain <a href> silently does nothing there.
//   Browser (dev)  — window.open works fine.
//
// So try the Tauri path first and fall back, rather than assuming either one.
async function openExternal(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    window.open(url, "_blank");
  }
}

export default function ContactCard() {
  const [copied, setCopied] = useState("");

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value).then(
      () => setCopied(`${label} copied`),
      () => setCopied("Couldn't copy to clipboard")
    );
  };

  return (
    <>
      <Paper sx={{ p: 3 }}>
        <Typography variant="overline">Contact</Typography>

        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1.5 }}>
          <Avatar sx={{ bgcolor: "rgba(138,199,255,0.15)", color: "primary.main", width: 48, height: 48 }}>
            {OWNER.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
          </Avatar>
          <Stack sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }}>{OWNER.name}</Typography>
            <Stack direction="row" spacing={0.75} alignItems="center">
              <BadgeIcon fontSize="inherit" sx={{ color: "text.secondary" }} />
              <Typography variant="body2" color="text.secondary">{OWNER.role}</Typography>
            </Stack>
          </Stack>
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} alignItems="center">
            <EmailIcon fontSize="small" sx={{ color: "text.secondary" }} />
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>
              {OWNER.email}
            </Typography>
            <Tooltip title="Copy email address">
              <IconButton size="small" aria-label="Copy email address"
                          onClick={() => copy(OWNER.email, "Email address")}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
          <Button variant="outlined" startIcon={<EmailIcon />}
                  onClick={() => openExternal(`mailto:${OWNER.email}`)}>
            Send email
          </Button>
          <Tooltip title="Opens the Webex desktop app. If nothing happens, Webex may not be installed.">
            <Button variant="contained" color="secondary" startIcon={<ChatIcon />}
                    onClick={() => openExternal(OWNER.webex)}>
              Message on Webex
            </Button>
          </Tooltip>
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
          Found a bug or have a request? Include the details from the Logs page — it makes issues far
          quicker to reproduce.
        </Typography>
      </Paper>

      <Snackbar
        open={!!copied}
        autoHideDuration={2500}
        onClose={() => setCopied("")}
        message={copied}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </>
  );
}
