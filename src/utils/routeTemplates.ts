// Expand route templates with {token} placeholders into concrete URLs.
//
// This is the native, in-app replacement for the external config generator: a
// QA pastes their app's route templates (which encode THEIR app knowledge) with
// placeholders for the dynamic ids, supplies one real value per id, and A11y
// Lens expands them into crawlable URLs. A11y Lens itself stays generic — it
// knows nothing about any specific product's routes, it just does substitution.
//
// Example:
//   templates:
//     /portal/ecare/products/{productId}/usage
//     /portal/ecare/finance/{accountNumber}/invoices/pay
//   variables: { productId: "PROD-100237", accountNumber: "AC-8847213" }
//   => [ ".../products/PROD-100237/usage", ".../finance/AC-8847213/invoices/pay" ]
//
// A template line whose placeholders aren't all filled is SKIPPED (reported in
// `skipped`), never crawled with a literal "{productId}" in it.

export interface ExpandResult {
  urls: string[];
  skipped: { line: string; missing: string[] }[];
  usedVars: string[];
}

const TOKEN = /\{(\w+)\}/g;

/** Parse a "key = value" (or "key: value") per-line block into a variable map. */
export function parseVariables(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+)\s*[:=]\s*(.+)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

export function expandRouteTemplates(templatesText: string, variables: Record<string, string>): ExpandResult {
  const urls: string[] = [];
  const skipped: ExpandResult["skipped"] = [];
  const usedVars = new Set<string>();
  const seen = new Set<string>();

  for (const raw of templatesText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const missing: string[] = [];
    const expanded = line.replace(TOKEN, (_, name) => {
      const v = variables[name];
      if (v === undefined || v === "") { missing.push(name); return `{${name}}`; }
      usedVars.add(name);
      return v;
    });

    if (missing.length) { skipped.push({ line, missing: [...new Set(missing)] }); continue; }
    if (seen.has(expanded)) continue;   // dedup identical expansions
    seen.add(expanded);
    urls.push(expanded);
  }

  return { urls, skipped, usedVars: [...usedVars] };
}
