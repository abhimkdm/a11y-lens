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
    return {
      content: r.message?.content ?? "",
      usage: { inputTokens: r.prompt_eval_count ?? 0, outputTokens: r.eval_count ?? 0 },
    };
  }

  if (ai.provider === "claude") {
    if (!ai.apiKey) throw new Error("No Claude API key set. Add one in Settings.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ai.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return {
      content: r.content?.map(c => c.text ?? "").join("") ?? "",
      usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 },
    };
  }

  if (ai.provider === "gemini") {
    if (!ai.apiKey) throw new Error("No Gemini API key set. Add one in Settings.");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${ai.model}:generateContent?key=${ai.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    ).then(x => x.json());
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    return {
      content: r.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      usage: {
        inputTokens: r.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: r.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
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
  return {
    content: r.choices?.[0]?.message?.content ?? "",
    usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
  };
}

// Same call, same error handling, but also hands back token usage — needed by
// any caller that has to price the request (the AI Report's plain-text fallback
// path, in particular). aiChat() below is unchanged for its four existing
// callers, which only ever wanted the string.
export async function aiChatWithUsage(ai, prompt, maxTokens = 2000) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");
  try {
    const { content, usage } = await callProvider(ai, prompt, maxTokens);
    return { text: content, usage };
  } catch (e) {
    throw translateProviderError(e, ai);
  }
}

function translateProviderError(e, ai) {
  // Node's fetch throws a bare "fetch failed" for connection-level
  // problems (server down, DNS failure, etc). Translate per provider.
  const raw = String(e?.message ?? e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    if (ai.provider === "ollama") {
      return new Error(
        `Can't reach Ollama at localhost:11434. Make sure Ollama is installed and running ` +
        `(https://ollama.com), and that you've pulled the model "${ai.model}" — e.g. run: ollama pull ${ai.model}`
      );
    }
    return new Error(
      `Can't reach ${ai.provider} (${raw}). Check your internet connection` +
      (ai.baseUrl ? ` and that ${ai.baseUrl} is reachable.` : ".")
    );
  }
  return e;
}

export async function aiChat(ai, prompt, maxTokens = 2000) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");
  try {
    const { content } = await callProvider(ai, prompt, maxTokens);
    return content;
  } catch (e) {
    throw translateProviderError(e, ai);
  }
}

// ---------------------------------------------------------------------------
// aiStructured — multimodal + schema-constrained request.
//
// Separate from aiChat() on purpose: aiChat stays exactly as it was so the
// existing AI report keeps working. This one adds the two things the Expert
// Audit needs:
//   - IMAGES: the screenshot is primary evidence; without it the model can't
//     judge visual-vs-programmatic mismatch at all.
//   - SCHEMA CONSTRAINT: instead of asking politely for JSON, we constrain the
//     decoder where the provider supports it (Ollama `format`, OpenAI
//     `json_schema`, Gemini `responseSchema`). Malformed JSON stops being
//     possible rather than merely unlikely — this is what makes small local
//     models usable for structured findings.
// Providers without native constraint (Claude) fall back to prompt + tolerant
// parse, which is what we already do everywhere else.
// ---------------------------------------------------------------------------
export async function aiStructured(ai, { system, user, images = [], schema, maxTokens = 8000 }) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");

  // Token usage is reported back so the caller can price the run.
  let usage = { inputTokens: 0, outputTokens: 0 };
  const withUsage = (data) => Object.defineProperty(data, "__usage", { value: usage, enumerable: false });

  const parse = (raw) => {
    const clean = String(raw).replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("The model did not return JSON. Try a larger model.");
    return JSON.parse(clean.slice(start, end + 1));
  };

  try {
    if (ai.provider === "ollama") {
      const r = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ai.model,
          stream: false,
          format: schema,                 // constrained decoding — invalid JSON becomes impossible
          options: { temperature: 0, num_ctx: 32768 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user, ...(images.length ? { images } : {}) },
          ],
        }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      usage = { inputTokens: r.prompt_eval_count ?? 0, outputTokens: r.eval_count ?? 0 };
      return withUsage(parse(r.message?.content ?? ""));
    }

    if (ai.provider === "claude") {
      if (!ai.apiKey) throw new Error("No Claude API key set. Add one in Settings.");
      const content = [
        ...images.map((b64) => ({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: b64 },
        })),
        { type: "text", text: user },
      ];
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ai.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ai.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content }],
        }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
      usage = { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 };
      return withUsage(parse(r.content?.map((c) => c.text ?? "").join("") ?? ""));
    }

    if (ai.provider === "gemini") {
      if (!ai.apiKey) throw new Error("No Gemini API key set. Add one in Settings.");
      const parts = [
        ...images.map((b64) => ({ inlineData: { mimeType: "image/jpeg", data: b64 } })),
        { text: user },
      ];
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${ai.model}:generateContent?key=${ai.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ parts }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
        }
      ).then((x) => x.json());
      if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
      usage = {
        inputTokens: r.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: r.usageMetadata?.candidatesTokenCount ?? 0,
      };
      return withUsage(parse(r.candidates?.[0]?.content?.parts?.[0]?.text ?? ""));
    }

    // openai-compatible (OpenAI, Kimi/LiteLLM, LM Studio, gateways)
    if (!ai.apiKey) throw new Error("No API key set for this provider. Add one in Settings.");
    const defaults = AI_PROVIDER_DEFAULTS[ai.provider] ?? {};
    const base = ai.baseUrl || defaults.baseUrl || "https://api.openai.com/v1";
    const model = ai.model || defaults.model;
    const content = [
      ...images.map((b64) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      })),
      { type: "text", text: user },
    ];

    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: images.length ? content : user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "expert_audit", strict: false, schema },
      },
    };

    let r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify(body),
    }).then((x) => x.json());

    // Some OpenAI-compatible gateways reject json_schema (or images). Degrade
    // gracefully rather than failing the whole audit: retry as plain JSON mode.
    if (r.error) {
      const msg = String(r.error.message ?? "");
      if (/response_format|json_schema|image|content/i.test(msg)) {
        r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: system + "\n\nReply with ONLY valid JSON matching the requested shape. No prose, no markdown fences." },
              { role: "user", content: images.length ? content : user },
            ],
          }),
        }).then((x) => x.json());
      }
      if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    }
    usage = {
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
    };
    return withUsage(parse(r.choices?.[0]?.message?.content ?? ""));
  } catch (e) {
    const raw = String(e?.message ?? e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
      if (ai.provider === "ollama") {
        throw new Error(
          `Can't reach Ollama at localhost:11434. Make sure Ollama is running and that you've pulled "${ai.model}" — e.g. ollama pull ${ai.model}`
        );
      }
      throw new Error(`Can't reach ${ai.provider} (${raw}).`);
    }
    throw e;
  }
}

// Ask for JSON, strip fences, parse defensively.
export async function aiJson(ai, prompt, maxTokens = 2500) {
  const { text: raw, usage } = await aiChatWithUsage(ai, prompt + "\n\nReply with ONLY valid JSON. No markdown fences, no preamble.", maxTokens);
  const clean = raw.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("AI did not return JSON.");
  const parsed = JSON.parse(clean.slice(start, end + 1));
  // Non-enumerable so it never pollutes the parsed JSON shape, matching aiStructured.
  Object.defineProperty(parsed, "__usage", { value: usage, enumerable: false });
  return parsed;
}
