// A11y Lens — cost estimation.
//
// An expert audit is not free, and the cost scales with the surface you point
// it at. Showing the number after every run is the cheapest way to stop a
// 40-page sweep becoming a surprise invoice.
//
// Prices are USD per 1M tokens and WILL drift — they're a local estimate, not a
// billing source of truth. Unknown models return null rather than a wrong number.
export const PRICING = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  // Anthropic
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  // Google
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // Local — free at the point of use
  __local: { input: 0, output: 0 },
};

export function estimateCost({ provider, model, inputTokens = 0, outputTokens = 0 }) {
  if (provider === "ollama") {
    return { usd: 0, inputTokens, outputTokens, note: "local model — no API cost" };
  }
  // Match the longest known prefix, so "gpt-4o-2026-01-01" still resolves.
  const key = Object.keys(PRICING)
    .filter((k) => k !== "__local" && String(model ?? "").startsWith(k))
    .sort((a, b) => b.length - a.length)[0];

  if (!key) {
    return { usd: null, inputTokens, outputTokens, note: `no local price for "${model}" — tokens shown, cost unknown` };
  }
  const p = PRICING[key];
  const usd = (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
  return { usd: Math.round(usd * 10000) / 10000, inputTokens, outputTokens, pricedAs: key };
}
