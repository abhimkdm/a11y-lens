// A11y Lens AI layer — one chat() call, multiple providers.
// Used by the crawler (action picking) and the report generator (Phase 8).
//
// Every provider call is wrapped so raw network errors (Node's generic
// "fetch failed" from an ECONNREFUSED/DNS failure) turn into a message
// that actually tells you what to do next.

// Per-provider defaults for OpenAI-compatible endpoints. A provider listed
// here doesn't need ai.model / ai.baseUrl explicitly set — they're filled
// in automatically, and the user can still override either in Settings.
export const AI_PROVIDER_DEFAULTS = {
  kimi: {
    model: "kimi-k2.6",
    baseUrl: "https://litellm.ai.netcracker.cloud/v1",
  },
};

async function callProvider(ai, prompt, maxTokens) {
  if (ai.provider === "ollama") {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: ai.model, stream: false, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error);
    return r.message?.content ?? "";
  }

  if (ai.provider === "claude") {
    if (!ai.apiKey) throw new Error("No Claude API key set. Add one in Settings.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ai.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.content?.map(c => c.text ?? "").join("") ?? "";
  }

  if (ai.provider === "gemini") {
    if (!ai.apiKey) throw new Error("No Gemini API key set. Add one in Settings.");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${ai.model}:generateContent?key=${ai.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    ).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // openai-compatible (OpenAI, Kimi, Azure-compatible gateways, LM Studio, etc.)
  if (!ai.apiKey) throw new Error("No API key set for this provider. Add one in Settings.");
  const defaults = AI_PROVIDER_DEFAULTS[ai.provider] ?? {};
  const base = ai.baseUrl || defaults.baseUrl || "https://api.openai.com/v1";
  const model = ai.model || defaults.model;
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  }).then(x => x.json());
  if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
  return r.choices?.[0]?.message?.content ?? "";
}

export async function aiChat(ai, prompt, maxTokens = 2000) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");
  try {
    return await callProvider(ai, prompt, maxTokens);
  } catch (e) {
    // Node's fetch throws a bare "fetch failed" for connection-level
    // problems (server down, DNS failure, etc). Translate per provider.
    const raw = String(e?.message ?? e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
      if (ai.provider === "ollama") {
        throw new Error(
          `Can't reach Ollama at localhost:11434. Make sure Ollama is installed and running ` +
          `(https://ollama.com), and that you've pulled the model "${ai.model}" — e.g. run: ollama pull ${ai.model}`
        );
      }
      throw new Error(
        `Can't reach ${ai.provider} (${raw}). Check your internet connection` +
        (ai.baseUrl ? ` and that ${ai.baseUrl} is reachable.` : ".")
      );
    }
    throw e;
  }
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
