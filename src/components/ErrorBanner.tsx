import { useEffect, useState } from "react";
import { Alert, Button } from "@mui/material";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "../services/api";

// Surfaces "something went wrong, but we kept going" without interrupting the
// user mid-task. Polls quietly; never blocks a scan or a report.
export default function ErrorBanner() {
  const [errors, setErrors] = useState(0);
  const [dismissed, setDismissed] = useState(0);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    const check = () =>
      api.getLogs(50)
        .then((r) => {
          if (r?.ok) setErrors(r.logs.filter((l: { level: string }) => l.level === "error").length);
        })
        .catch(() => {});
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, []);

  // Nothing to say, already dismissed at this count, or the user is already
  // looking at the Logs page.
  if (!errors || errors <= dismissed || loc.pathname === "/logs") return null;

  return (
    <Alert
      severity="error"
      sx={{ mb: 2 }}
      onClose={() => setDismissed(errors)}
      action={
        <Button color="inherit" size="small" onClick={() => nav("/logs")}>
          Check Logs
        </Button>
      }
    >
      {errors === 1
        ? "An error was recorded during the last operation. The result may be incomplete."
        : `${errors} errors were recorded. Some results may be incomplete.`}
    </Alert>
  );
}
