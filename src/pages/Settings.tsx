import { useEffect, useState } from "react";
import {
  Paper, Typography, Stack, TextField, MenuItem, Alert, Button, Switch,
  FormControlLabel, Chip, Divider,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import ContactCard from "../components/ContactCard";

const PROVIDERS = ["ollama", "openai", "claude", "gemini", "kimi"];

// The cross-check model is only used by the AI Expert Audit, which is currently
// hidden behind SHOW_EXPERT_AUDIT in ScanCenter. Showing a config panel for a
// feature the user can't reach is just clutter — so it's hidden with it.
// Flip both flags together to bring the feature back.
const SHOW_CROSS_CHECK = false;

export default function Settings() {
  const { aiProvider, setAiProvider } = useAppStore();
  const [hasKey, setHasKey] = useState(false);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, { model?: string; baseUrl?: string }>>({});
  const [security, setSecurity] = useState({ localOnly: false, masking: true, storeScreenshots: false });
  const [aiB, setAiB] = useState({ provider: "", model: "", apiKey: "", baseUrl: "" });
  const [aiBHasKey, setAiBHasKey] = useState(false);
  const [aiBMsg, setAiBMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
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
    api.getAiProviderDefaults().then((r) => r.ok && setProviderDefaults(r.defaults)).catch(() => {});
    api.getCrossCheckSettings().then((r) => {
      if (r.ok) {
        setAiBHasKey(r.hasKey);
        if (r.provider) setAiB((p) => ({ ...p, provider: r.provider, model: r.model, baseUrl: r.baseUrl ?? "" }));
      }
    }).catch(() => {});
    api.getSecurity().then((r) => r.ok && setSecurity({
      localOnly: r.localOnly, masking: r.masking, storeScreenshots: r.storeScreenshots ?? false,
    })).catch(() => {});
    api.auditLog().then((r) => r.ok && setAudit(r.entries)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProvider = (provider: string) => {
    const d = providerDefaults[provider];
    setAiProvider({
      provider,
      model: aiProvider.model || d?.model || "",
      baseUrl: aiProvider.baseUrl || d?.baseUrl || "",
    });
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

  const [testing, setTesting] = useState(false);
  const testConnection = async () => {
    setMsg(null); setTesting(true);
    const r = await api.testAiConnection(aiProvider).catch((e) => ({ ok: false, error: String(e) }));
    setTesting(false);
    if (r.ok) {
      setMsg({
        kind: "success",
        text: `Connected — ${r.provider}/${r.model}${r.baseUrl ? ` via ${r.baseUrl}` : ""} responded in ${r.latencyMs}ms (reply: "${r.reply}").`,
      });
    } else {
      setMsg({ kind: "error", text: r.error ?? "Connection test failed" });
    }
  };

  const isOpenAiCompatible = !["ollama", "claude", "gemini"].includes(aiProvider.provider);
  const aiBIsOpenAiCompatible = aiB.provider !== "" && !["ollama", "claude", "gemini"].includes(aiB.provider);
  const sameFamily = aiB.provider && aiB.provider === aiProvider.provider;

  const saveAiB = async () => {
    setAiBMsg(null);
    const r = await api.saveCrossCheckSettings(aiB).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) {
      setAiBMsg({ kind: "success", text: "Cross-check model saved. Key encrypted at rest." });
      if (aiB.apiKey) setAiBHasKey(true);
      setAiB((p) => ({ ...p, apiKey: "" }));
    } else setAiBMsg({ kind: "error", text: r.error ?? "Save failed" });
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
            onChange={(e) => selectProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <MenuItem key={p} value={p}>{p}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" label="Model" value={aiProvider.model}
            placeholder={providerDefaults[aiProvider.provider]?.model}
            onChange={(e) => setAiProvider({ model: e.target.value })} />
          {isOpenAiCompatible && (
            <TextField size="small" label="Base URL" value={aiProvider.baseUrl}
              placeholder={providerDefaults[aiProvider.provider]?.baseUrl || "https://api.openai.com/v1"}
              helperText="OpenAI-compatible endpoint. Leave blank to use the provider's default."
              onChange={(e) => setAiProvider({ baseUrl: e.target.value })} />
          )}
          <TextField size="small" type="password"
            label={hasKey ? "API key (leave blank to keep current)" : "API key"}
            value={aiProvider.apiKey}
            onChange={(e) => setAiProvider({ apiKey: e.target.value })} />
          <Stack direction="row" spacing={1.5}>
            <Button variant="outlined" onClick={testConnection} disabled={testing}>
              {testing ? "Testing…" : "Test Connection"}
            </Button>
            <Button variant="contained" onClick={saveAi} disabled={testing}>
              Save provider settings
            </Button>
          </Stack>
          {msg && <Alert severity={msg.kind}>{msg.text}</Alert>}
        </Stack>
      </Paper>

      {SHOW_CROSS_CHECK && (<>
        <Paper sx={{ p: 3 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="overline">Cross-check model (second opinion)</Typography>
            {aiBHasKey && <Chip size="small" icon={<LockIcon />} label="Key stored encrypted" color="success" variant="outlined" />}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
            Used by the Expert Audit's cross-check mode: two models judge the same evidence, and findings are
            tiered into consensus / confirmed / needs-review. Pick a <strong>different provider family</strong> than
            your primary — two models from the same family tend to make the same mistakes, so their agreement
            proves much less.
          </Typography>
          <Stack spacing={2}>
            <TextField select size="small" label="Provider" value={aiB.provider}
              onChange={(e) => {
                const p = e.target.value;
                const d = providerDefaults[p];
                setAiB((prev) => ({ ...prev, provider: p, model: prev.model || d?.model || "", baseUrl: prev.baseUrl || d?.baseUrl || "" }));
              }}>
              <MenuItem value="">(disabled — no cross-check)</MenuItem>
              {PROVIDERS.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
            </TextField>
            {sameFamily && (
              <Alert severity="warning">
                Your cross-check model is the same provider as your primary. Agreement between two models of the
                same family is weak evidence — prefer a different family (e.g. primary Kimi, cross-check Claude).
              </Alert>
            )}
            {aiB.provider && (
              <>
                <TextField size="small" label="Model" value={aiB.model}
                  placeholder={providerDefaults[aiB.provider]?.model}
                  onChange={(e) => setAiB((p) => ({ ...p, model: e.target.value }))} />
                {aiBIsOpenAiCompatible && (
                  <TextField size="small" label="Base URL" value={aiB.baseUrl}
                    placeholder={providerDefaults[aiB.provider]?.baseUrl || "https://api.openai.com/v1"}
                    onChange={(e) => setAiB((p) => ({ ...p, baseUrl: e.target.value }))} />
                )}
                <TextField size="small" type="password"
                  label={aiBHasKey ? "API key (leave blank to keep current)" : "API key"}
                  value={aiB.apiKey}
                  onChange={(e) => setAiB((p) => ({ ...p, apiKey: e.target.value }))} />
              </>
            )}
            <Button variant="outlined" onClick={saveAiB} sx={{ alignSelf: "flex-start" }}>
              Save cross-check model
            </Button>
            {aiBMsg && <Alert severity={aiBMsg.kind}>{aiBMsg.text}</Alert>}
          </Stack>
        </Paper>
      </>)}

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
          <FormControlLabel
            control={<Switch checked={security.storeScreenshots}
              onChange={(e) => toggleSecurity({ storeScreenshots: e.target.checked })} />}
            label="Store screenshots in sessions and reports" />
        </Stack>
        {security.storeScreenshots && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            Screenshots are captured full-page from a logged-in session and can contain customer names,
            addresses, and order data. They will be written to the local database and embedded in exported
            HTML reports. Only enable this if those reports stay somewhere appropriate.
          </Alert>
        )}
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

      <ContactCard />
    </Stack>
  );
}
