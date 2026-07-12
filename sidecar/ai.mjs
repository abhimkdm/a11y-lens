// A11y Lens AI layer — one chat() call, multiple providers.
// Used by the crawler (action picking) and the report generator (Phase 8).

export const AI_PROVIDER_DEFAULTS = {
  kimi: {
    model: "kimi-k2.6",
    baseUrl: "https://litellm.ai.netcracker.cloud/v1",
  },
};

export function resolveAiConfig(ai) {
  const defaults = AI_PROVIDER_DEFAULTS[ai?.provider] ?? {};
  const baseUrl = normalizeBaseUrl(ai?.baseUrl || defaults.baseUrl || "");
  return {
    provider: ai?.provider,
    model: ai?.model || defaults.model || "",
    baseUrl,
    apiKey: ai?.apiKey || "",
  };
}

function normalizeBaseUrl(url) {
  return String(url ?? "").trim().replace(/\/$/, "");
}

function networkErrorMessage(ai, e) {
  const resolved = resolveAiConfig(ai);
  const cause = e?.cause?.code || e?.cause?.message || "";
  const raw = String(e?.message ?? e);

  if (resolved.provider === "ollama") {
    return (
      `Can't reach Ollama at localhost:11434. Make sure Ollama is installed and running ` +
      `(https://ollama.com), and that you've pulled the model "${resolved.model}" — e.g. run: ollama pull ${resolved.model}`
    );
  }

  const endpoint = resolved.baseUrl || "the configured endpoint";
  if (/ENOTFOUND|EAI_AGAIN/i.test(cause) || /ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    const vpnHint = /netcracker/i.test(endpoint)
      ? " This host is internal to Netcracker — connect to your corporate VPN (or office network), then try again."
      : " Check DNS, VPN, or proxy settings.";
    return `Can't reach ${resolved.provider}: hostname not found for ${endpoint}.${vpnHint}`;
  }

  if (/CERT|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(`${cause} ${raw}`)) {
    return (
      `Can't reach ${resolved.provider} (${endpoint}): TLS certificate verification failed. ` +
      "If you're on a corporate network, ask IT for the proxy CA cert or set NODE_EXTRA_CA_CERTS."
    );
  }

  return (
    `Can't reach ${resolved.provider} (${raw}${cause ? ` / ${cause}` : ""}). ` +
    `Check that ${endpoint} is reachable from this machine.`
  );
}

async function callProvider(ai, prompt, maxTokens) {
  const resolved = resolveAiConfig(ai);

  if (resolved.provider === "ollama") {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: resolved.model, stream: false, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error);
    return r.message?.content ?? "";
  }

  if (resolved.provider === "claude") {
    if (!resolved.apiKey) throw new Error("No Claude API key set. Add one in Settings.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": resolved.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: resolved.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.content?.map(c => c.text ?? "").join("") ?? "";
  }

  if (resolved.provider === "gemini") {
    if (!resolved.apiKey) throw new Error("No Gemini API key set. Add one in Settings.");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${resolved.model}:generateContent?key=${resolved.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    ).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // openai-compatible (OpenAI, Kimi/LiteLLM, Azure gateways, LM Studio, etc.)
  if (!resolved.apiKey) throw new Error("No API key set for this provider. Add one in Settings.");
  const base = resolved.baseUrl || "https://api.openai.com/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  }).then(x => x.json());
  if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
  return r.choices?.[0]?.message?.content ?? "";
}

export async function aiChat(ai, prompt, maxTokens = 2000) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");
  try {
    return await callProvider(ai, prompt, maxTokens);
  } catch (e) {
    const raw = String(e?.message ?? e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|CERT|UNABLE_TO_VERIFY/i.test(raw + (e?.cause?.code ?? ""))) {
      throw new Error(networkErrorMessage(ai, e));
    }
    throw e;
  }
}

export async function testAiConnection(ai) {
  const resolved = resolveAiConfig(ai);
  if (!resolved.provider) throw new Error("No AI provider selected.");
  const text = await aiChat(ai, "Reply with exactly: ok", 16);
  return { provider: resolved.provider, model: resolved.model, baseUrl: resolved.baseUrl, reply: text.trim().slice(0, 80) };
}

// Ask for JSON, strip fences, parse defensively.
export async function aiJson(ai, prompt, maxTokens = 2500) {
  const raw = await aiChat(ai, prompt + "\n\nReply with ONLY valid JSON. No markdown fences, no preamble.", maxTokens);
  const clean = raw.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("AI did not return JSON.");
  return JSON.parse(clean.slice(start, end + 1));
}
