import { useEffect, useState } from "react";
import {
  Paper, Typography, Stack, TextField, MenuItem, Alert, Button, Switch,
  FormControlLabel, Chip, Divider,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";

const AI_PROVIDERS: Record<string, { label: string; model: string; baseUrl: string }> = {
  ollama: { label: "Ollama", model: "llama3.1", baseUrl: "" },
  openai: { label: "OpenAI", model: "gpt-4o-mini", baseUrl: "" },
  claude: { label: "Claude", model: "claude-sonnet-4-20250514", baseUrl: "" },
  gemini: { label: "Gemini", model: "gemini-2.0-flash", baseUrl: "" },
  kimi: { label: "Kimi", model: "kimi-k2.6", baseUrl: "https://litellm.ai.netcracker.cloud/v1" },
};

export default function Settings() {
  const { aiProvider, setAiProvider } = useAppStore();
  const [hasKey, setHasKey] = useState(false);
  const [security, setSecurity] = useState({ localOnly: false, masking: true });
  const [audit, setAudit] = useState<{ id: number; timestamp: string; action: string; detail: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api.getAiSettings().then((r) => {
      if (r.ok) {
        setHasKey(r.hasKey);
        if (r.provider) setAiProvider({ provider: r.provider, model: r.model, baseUrl: r.baseUrl ?? "" });
      }
    }).catch(() => setOffline(true));
    api.getSecurity().then((r) => r.ok && setSecurity({ localOnly: r.localOnly, masking: r.masking })).catch(() => {});
    api.auditLog().then((r) => r.ok && setAudit(r.entries)).catch(() => {});
  }, [setAiProvider]);

  const saveAi = async () => {
    setMsg(null);
    const r = await api.saveAiSettings(aiProvider).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) {
      setMsg({ kind: "success", text: "Saved. The API key is encrypted at rest (AES-256-GCM) and never returned to the UI." });
      if (aiProvider.apiKey) setHasKey(true);
      setAiProvider({ apiKey: "" }); // clear from memory once stored
    } else setMsg({ kind: "error", text: r.error ?? "Save failed" });
  };

  const toggleSecurity = async (patch: Partial<typeof security>) => {
    const next = { ...security, ...patch };
    setSecurity(next);
    await api.saveSecurity(next).catch(() => {});
    api.auditLog().then((r) => r.ok && setAudit(r.entries)).catch(() => {});
  };

  return (
    <Stack spacing={2.5} sx={{ maxWidth: 640 }}>
      {offline && <Alert severity="warning">Sidecar not reachable — settings need <code>npm run sidecar</code> running.</Alert>}

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="overline">AI provider</Typography>
          {hasKey && <Chip size="small" icon={<LockIcon />} label="Key stored encrypted" color="success" variant="outlined" />}
        </Stack>
        <Stack spacing={2} sx={{ mt: 1.5 }}>
          <TextField select size="small" label="Provider" value={aiProvider.provider}
            onChange={(e) => {
              const preset = AI_PROVIDERS[e.target.value];
              setAiProvider({
                provider: e.target.value,
                model: preset?.model ?? aiProvider.model,
                baseUrl: preset?.baseUrl ?? "",
              });
            }}>
            {Object.entries(AI_PROVIDERS).map(([id, { label }]) => (
              <MenuItem key={id} value={id}>{label}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" label="Model" value={aiProvider.model}
            onChange={(e) => setAiProvider({ model: e.target.value })} />
          {(aiProvider.provider === "kimi" || aiProvider.provider === "openai") && (
            <TextField size="small" label="API base URL" value={aiProvider.baseUrl}
              placeholder={aiProvider.provider === "kimi"
                ? "https://litellm.ai.netcracker.cloud/v1"
                : "https://api.openai.com/v1"}
              onChange={(e) => setAiProvider({ baseUrl: e.target.value })} />
          )}
          <TextField size="small" type="password"
            label={hasKey ? "API key (leave blank to keep current)" : "API key"}
            value={aiProvider.apiKey}
            onChange={(e) => setAiProvider({ apiKey: e.target.value })} />
          <Button variant="contained" onClick={saveAi} sx={{ alignSelf: "flex-start" }}>
            Save provider settings
          </Button>
          {msg && <Alert severity={msg.kind}>{msg.text}</Alert>}
        </Stack>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="overline">Security</Typography>
        <Stack sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Switch checked={security.localOnly}
              onChange={(e) => toggleSecurity({ localOnly: e.target.checked })} />}
            label="Local processing only — block cloud AI providers; only Ollama on this machine is allowed" />
          <FormControlLabel
            control={<Switch checked={security.masking}
              onChange={(e) => toggleSecurity({ masking: e.target.checked })} />}
            label="Mask sensitive data — scrub emails, card numbers, tokens, and password values before saving sessions" />
        </Stack>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="overline">Audit log</Typography>
        <Divider sx={{ my: 1 }} />
        {!audit.length && <Typography variant="body2" color="text.secondary">No entries yet.</Typography>}
        <Stack spacing={0.5} sx={{ maxHeight: 260, overflow: "auto" }}>
          {audit.map((a) => (
            <Stack key={a.id} direction="row" spacing={1.5}>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", flexShrink: 0 }}>
                {new Date(a.timestamp).toLocaleString()}
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 600, flexShrink: 0 }}>{a.action}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>{a.detail}</Typography>
            </Stack>
          ))}
        </Stack>
      </Paper>
    </Stack>
  );
}
