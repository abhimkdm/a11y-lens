import { useEffect, useState } from "react";
import {
  Paper, Typography, Stack, TextField, MenuItem, Alert, Button, Switch,
  FormControlLabel, Chip, Divider,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";

const PROVIDERS = ["ollama", "openai", "claude", "gemini", "kimi"];

export default function Settings() {
  const { aiProvider, setAiProvider } = useAppStore();
  const [hasKey, setHasKey] = useState(false);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, { model?: string; baseUrl?: string }>>({});
  const [security, setSecurity] = useState({ localOnly: false, masking: true });
  const [audit, setAudit] = useState<{ id: number; timestamp: string; action: string; detail: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api.getAiSettings().then((r) => {
      if (r.ok) {
        setHasKey(r.hasKey);
        if (r.provider) setAiProvider({ provider: r.provider, model: r.model, baseUrl: r.baseUrl ?? "" });
      }
    }).catch(() => setOffline(true));
    api.getAiProviderDefaults().then((r) => r.ok && setProviderDefaults(r.defaults)).catch(() => {});
    api.getSecurity().then((r) => r.ok && setSecurity({ localOnly: r.localOnly, masking: r.masking })).catch(() => {});
    api.auditLog().then((r) => r.ok && setAudit(r.entries)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProvider = (provider: string) => {
    const d = providerDefaults[provider];
    setAiProvider({
      provider,
      model: d?.model || "",
      baseUrl: d?.baseUrl || "",
    });
  };

  const testConnection = async () => {
    setMsg(null);
    setTesting(true);
    const r = await api.testAiConnection(aiProvider).catch((e) => ({ ok: false, error: String(e) }));
    setTesting(false);
    if (r.ok) {
      setMsg({ kind: "success", text: `Connected to ${r.provider}/${r.model}. Reply: ${r.reply}` });
    } else {
      setMsg({ kind: "error", text: r.error ?? "Connection test failed" });
    }
  };

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

  const isOpenAiCompatible = !["ollama", "claude", "gemini"].includes(aiProvider.provider);

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
            onChange={(e) => selectProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <MenuItem key={p} value={p}>{p}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" label="Model" value={aiProvider.model}
            placeholder={providerDefaults[aiProvider.provider]?.model}
            onChange={(e) => setAiProvider({ model: e.target.value })} />
          {isOpenAiCompatible && (
            <TextField size="small" label="API base URL" value={aiProvider.baseUrl}
              placeholder={providerDefaults[aiProvider.provider]?.baseUrl || "https://api.openai.com/v1"}
              helperText="OpenAI-compatible endpoint. Leave blank to use the provider default."
              onChange={(e) => setAiProvider({ baseUrl: e.target.value })} />
          )}
          <TextField size="small" type="password"
            label={hasKey ? "API key (leave blank to keep current)" : "API key"}
            value={aiProvider.apiKey}
            onChange={(e) => setAiProvider({ apiKey: e.target.value })} />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button variant="outlined" onClick={testConnection} disabled={testing || offline}>
              {testing ? "Testing…" : "Test Connection"}
            </Button>
            <Button variant="contained" onClick={saveAi} disabled={offline}>
              Save provider settings
            </Button>
          </Stack>
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
