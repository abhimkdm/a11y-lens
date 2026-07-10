// A11y Lens AI layer — one chat() call, multiple providers.
export const AI_PROVIDER_DEFAULTS = {
  kimi: {
    model: "kimi-k2.6",
    baseUrl: "https://litellm.ai.netcracker.cloud/v1",
  },
};

export async function aiChat(ai, prompt, maxTokens = 2000) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");

  if (ai.provider === "ollama") {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: ai.model, stream: false, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error);
    return r.message?.content ?? "";
  }

  if (ai.provider === "claude") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ai.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.content?.map(c => c.text ?? "").join("") ?? "";
  }

  if (ai.provider === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${ai.model}:generateContent?key=${ai.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    ).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // Kimi via Netcracker LiteLLM — OpenAI-compatible chat/completions.
  if (ai.provider === "kimi" || ai.provider === "openai") {
    const defaults = AI_PROVIDER_DEFAULTS[ai.provider] ?? {};
    const base = (ai.baseUrl || defaults.baseUrl || "https://api.openai.com/v1").trim().replace(/\/$/, "");
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model || defaults.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return r.choices?.[0]?.message?.content ?? "";
  }

  throw new Error(`Unknown AI provider: ${ai.provider}`);
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
