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
    // Global Kimi/Moonshot API. China-mainland keys use https://api.moonshot.cn/v1 instead.
    baseUrl: "https://litellm.ai.netcracker.cloud/v1",
  },
  nvidia: {
    model: "meta/llama-3.3-70b-instruct",
    // Smaller model for Settings → Test Connection — 70B cold starts can take minutes.
    testModel: "meta/llama-3.1-8b-instruct",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  // OpenRouter is an aggregator with an OpenAI-compatible endpoint, so it needs no
  // special client — just a base URL. Model ids are namespaced ("vendor/model"),
  // and ids ending in ":free" cost nothing but are rate limited by REQUEST COUNT,
  // which is the constraint that matters here: an AI Full Scan issues one request
  // per page AND per interaction-revealed state, so a large crawl exhausts a free
  // daily allowance long before it exhausts any token budget. See the note in
  // Settings. Paid ids on the same key have no such per-day cap.
  openrouter: {
    model: "openrouter/auto",
    testModel: "openrouter/auto",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveProviderFields(provider, { model, baseUrl, stored, test = false } = {}) {
  const defaults = AI_PROVIDER_DEFAULTS[provider] ?? {};
  const storedMatch = stored?.provider === provider;
  const resolvedModel =
    nonEmpty(model) ||
    (storedMatch && nonEmpty(stored?.model)) ||
    (test && defaults.testModel) ||
    defaults.model;
  const resolvedBaseUrl =
    nonEmpty(baseUrl) ||
    (storedMatch && nonEmpty(stored?.baseUrl)) ||
    defaults.baseUrl;
  return { model: resolvedModel, baseUrl: resolvedBaseUrl, defaults };
}

// Free/shared tiers throttle by REQUEST COUNT (OpenRouter: 20/min, 50/day on an
// unfunded account). A scan issues one request per page and per revealed state, so
// hitting 429 mid-crawl is normal rather than exceptional. Backing off keeps the
// scan alive; failing fast would silently lose that page's findings entirely.
export async function withRateLimitRetry(fn, { attempts = 3, onLog = () => {} } = {}) {
  let wait = 4000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      const rateLimited = /\b429\b|rate.?limit|too many requests|quota/i.test(msg);
      if (!rateLimited || i === attempts - 1) throw e;
      const perDay = /per.?day|daily|quota exceeded/i.test(msg);
      if (perDay) {
        // A daily cap will not clear by waiting a few seconds — say so plainly
        // instead of retrying into the same wall.
        throw Object.assign(new Error(
          `Daily request limit reached for this provider. ${msg.slice(0, 120)}`), { rateLimitDaily: true });
      }
      onLog(`Rate limited — waiting ${Math.round(wait / 1000)}s before retrying (attempt ${i + 2}/${attempts}).`);
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

function extractApiError(status, body) {
  if (body?.error?.message) return body.error.message;
  if (body?.detail) return String(body.detail);
  if (body?.title && body?.status) return `${body.title} (HTTP ${body.status})`;
  if (body?.message) return String(body.message);
  return `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`;
}

async function openAiCompatChat({ baseUrl, apiKey, model, messages, maxTokens, responseFormat, timeoutMs = 120_000 }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("No API key was supplied for this provider. Save the key in Settings, or paste it and test again.");
  }
  if (!model) throw new Error("No model configured. Set one in Settings.");
  const body = { model, max_tokens: maxTokens, messages };
  if (responseFormat) body.response_format = responseFormat;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    // An empty key here becomes `Authorization: Bearer ` — which providers reject
    // with "Missing Authentication header", a message that sends people hunting
    // through their account settings for a problem that is local.
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from ${baseUrl} (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.error || (parsed.status && parsed.status >= 400)) {
    throw new Error(extractApiError(res.status, parsed));
  }
  return parsed;
}

async function callProvider(ai, prompt, maxTokens, opts = {}) {
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

  // openai-compatible (OpenAI, Kimi, NVIDIA NIM, Azure-compatible gateways, LM Studio, etc.)
  if (!ai.apiKey) throw new Error("No API key set for this provider. Add one in Settings.");
  const { model, baseUrl } = resolveProviderFields(ai.provider, {
    model: ai.model,
    baseUrl: ai.baseUrl,
    test: opts.test,
  });
  const r = await openAiCompatChat({
    baseUrl: baseUrl || "https://api.openai.com/v1",
    apiKey: ai.apiKey,
    model,
    maxTokens,
    messages: [{ role: "user", content: prompt }],
    timeoutMs: opts.timeoutMs,
  });
  return {
    content: r.choices?.[0]?.message?.content ?? "",
    usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
  };
}

// Same call, same error handling, but also hands back token usage — needed by
// any caller that has to price the request (the AI Report's plain-text fallback
// path, in particular). aiChat() below is unchanged for its four existing
// callers, which only ever wanted the string.
export async function aiChatWithUsage(ai, prompt, maxTokens = 2000, opts = {}) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");
  try {
    const { content, usage } = await callProvider(ai, prompt, maxTokens, opts);
    return { text: content, usage };
  } catch (e) {
    throw translateProviderError(e, ai);
  }
}

function translateProviderError(e, ai) {
  // Node's fetch throws a bare "fetch failed" for connection-level
  // problems (server down, DNS failure, etc). Translate per provider.
  const raw = String(e?.message ?? e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed out|TimeoutError|aborted/i.test(raw)) {
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

export async function aiChat(ai, prompt, maxTokens = 2000, opts = {}) {
  if (!ai?.provider) throw new Error("No AI provider configured. Set one in Settings.");
  try {
    const { content } = await callProvider(ai, prompt, maxTokens, opts);
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
// Models that have rejected image input, keyed "provider:model". Populated at
// runtime from the provider's own error, so a text-only model degrades to a
// text audit once instead of failing on every page of the crawl.
const NO_VISION = new Set();

export function markNoVision(provider, model) { NO_VISION.add(`${provider}:${model}`); }
export function hasNoVision(provider, model) { return NO_VISION.has(`${provider}:${model}`); }

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

    // openai-compatible (OpenAI, Kimi/NVIDIA NIM/LiteLLM, LM Studio, gateways)
    if (!ai.apiKey) throw new Error("No API key set for this provider. Add one in Settings.");
    const { model, baseUrl } = resolveProviderFields(ai.provider, { model: ai.model, baseUrl: ai.baseUrl });
    const base = baseUrl || "https://api.openai.com/v1";
    // Once a model has rejected images, stop sending them for the rest of the run.
    // Without this every page repeats the same doomed multimodal request, which is
    // how an AI Full Scan ends up with zero findings AND zero tokens.
    const visionKey = `${ai.provider}:${model}`;
    const useImages = images.length > 0 && !NO_VISION.has(visionKey);
    const content = [
      ...(useImages
        ? images.map((b64) => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${b64}` },
          }))
        : []),
      { type: "text", text: user },
    ];

    const messages = [
      { role: "system", content: system },
      { role: "user", content: useImages ? content : user },
    ];

    let r;
    try {
      r = await openAiCompatChat({
        baseUrl: base,
        apiKey: ai.apiKey,
        model,
        maxTokens,
        messages,
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "expert_audit", strict: false, schema },
        },
      });
    } catch (e) {
      const msg = String(e?.message ?? "");
      // A multimodal rejection means this model is text-only. Retry WITHOUT the
      // images (previously the retry re-sent them, so it failed identically and
      // the whole audit was lost) and remember it so later pages skip vision.
      const noVision = /multimodal|vision|image/i.test(msg);
      if (noVision && useImages) {
        NO_VISION.add(visionKey);
        r = await openAiCompatChat({
          baseUrl: base,
          apiKey: ai.apiKey,
          model,
          maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "expert_audit", strict: false, schema },
          },
        }).catch(() =>
          // Gateway may also reject json_schema — final attempt: plain JSON mode.
          openAiCompatChat({
            baseUrl: base,
            apiKey: ai.apiKey,
            model,
            maxTokens,
            messages: [
              { role: "system", content: system + "\n\nReply with ONLY valid JSON matching the requested shape. No prose, no markdown fences." },
              { role: "user", content: user },
            ],
          })
        );
      } else if (/response_format|json_schema|image|content/i.test(msg)) {
        // Some OpenAI-compatible gateways reject json_schema. Degrade gracefully
        // rather than failing the whole audit: retry as plain JSON mode.
        r = await openAiCompatChat({
          baseUrl: base,
          apiKey: ai.apiKey,
          model,
          maxTokens,
          messages: [
            { role: "system", content: system + "\n\nReply with ONLY valid JSON matching the requested shape. No prose, no markdown fences." },
            { role: "user", content: useImages ? content : user },
          ],
        });
      } else {
        throw e;
      }
    }
    usage = {
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
    };
    return withUsage(parse(r.choices?.[0]?.message?.content ?? ""));
  } catch (e) {
    const raw = String(e?.message ?? e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed out|TimeoutError|aborted/i.test(raw)) {
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
