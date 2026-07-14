// A11y Lens — tolerant JSON parsing for AI responses.
//
// The failure this exists for is real and specific: asked to emit an Angular fix
// snippet, a model produced
//
//     "angular": `<img [src]="url" alt="...">`
//
// Backtick-quoted strings are valid JavaScript and invalid JSON. JSON.parse threw,
// and the ENTIRE report — executive summary, business impact, every other fix —
// was discarded because one field of one fix was malformed. That is the wrong
// trade: a report with 7 of 8 fixes is worth far more than no report at all.
//
// So parsing here is layered, and each layer degrades rather than fails:
//   1. parse as-is
//   2. repair the common, mechanical malformations and re-parse
//   3. salvage: pull out whatever individual objects DO parse, and report the rest
//      as warnings the user can inspect in the Logs page
//
// Nothing here invents data. If a field can't be recovered it's dropped and
// recorded — never guessed.

export function stripFences(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return s;
  return s.slice(start, end + 1);
}

// Mechanical repairs for the malformations models actually produce.
export function repairJson(input) {
  let s = String(input);
  const applied = [];

  // 1. Backtick-quoted values -> properly escaped double-quoted strings.
  //    This is the exact failure from the Angular fix field.
  const backtickRe = /:\s*`([\s\S]*?)`(\s*[,}\]])/g;
  if (backtickRe.test(s)) {
    s = s.replace(/:\s*`([\s\S]*?)`(\s*[,}\]])/g, (_m, body, tail) => {
      const escaped = body
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "")
        .replace(/\t/g, "\\t");
      return `: "${escaped}"${tail}`;
    });
    applied.push("converted backtick-quoted strings to JSON strings");
  }

  // 2. Raw newlines inside double-quoted strings (illegal in JSON).
  //    Walk the string so we only touch characters actually inside a string.
  let out = "";
  let inString = false;
  let escaped = false;
  let fixedNewlines = 0;
  for (const ch of s) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && (ch === "\n" || ch === "\r")) {
      if (ch === "\n") { out += "\\n"; fixedNewlines++; }
      continue;
    }
    if (inString && ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  s = out;
  if (fixedNewlines) applied.push(`escaped ${fixedNewlines} raw newline(s) inside strings`);

  // 3. Trailing commas before a closing brace/bracket.
  const before = s;
  s = s.replace(/,(\s*[}\]])/g, "$1");
  if (s !== before) applied.push("removed trailing comma(s)");

  return { text: s, applied };
}

// Pull out top-level array items that individually parse, even when the whole
// document doesn't. This is how we keep 7 good fixes when the 8th is broken.
function salvageArray(text, key) {
  const marker = new RegExp(`"${key}"\\s*:\\s*\\[`);
  const m = marker.exec(text);
  if (!m) return null;

  const start = text.indexOf("[", m.index);
  const items = [];
  const failed = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const chunk = text.slice(objStart, i + 1);
        try {
          items.push(JSON.parse(chunk));
        } catch {
          failed.push(chunk.slice(0, 200));
        }
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }
  return { items, failed };
}

/**
 * Parse an AI JSON response as tolerantly as possible.
 * Returns { data, warnings, recovered } — never throws unless nothing at all
 * could be recovered.
 */
export function parseAiJson(raw, { salvageKeys = [] } = {}) {
  const warnings = [];
  const cleaned = stripFences(raw);

  // Layer 1 — straight parse.
  try {
    return { data: JSON.parse(cleaned), warnings, recovered: false };
  } catch (e) {
    warnings.push({
      stage: "parse",
      message: `The model's response was not valid JSON: ${e.message}`,
      detail: nearError(cleaned, e),
    });
  }

  // Layer 2 — repair and re-parse.
  const { text: repaired, applied } = repairJson(cleaned);
  try {
    const data = JSON.parse(repaired);
    warnings.push({
      stage: "repair",
      message: `Recovered the response by repairing it: ${applied.join("; ") || "minor cleanup"}.`,
      detail: null,
    });
    return { data, warnings, recovered: true };
  } catch (e) {
    warnings.push({
      stage: "repair",
      message: `Repair did not produce valid JSON either: ${e.message}`,
      detail: nearError(repaired, e),
    });
  }

  // Layer 3 — salvage whatever individual objects parse.
  const data = {};
  let salvagedAnything = false;
  for (const key of salvageKeys) {
    const res = salvageArray(repaired, key);
    if (res && res.items.length) {
      data[key] = res.items;
      salvagedAnything = true;
      warnings.push({
        stage: "salvage",
        message: `Salvaged ${res.items.length} valid "${key}" entr${res.items.length === 1 ? "y" : "ies"}${
          res.failed.length ? `; ${res.failed.length} could not be parsed and were dropped` : ""
        }.`,
        detail: res.failed.length ? res.failed.join("\n\n---\n\n") : null,
      });
    }
  }

  // Recover simple top-level strings (executiveSummary etc.) with a targeted regex.
  for (const key of ["executiveSummary", "businessImpact"]) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(repaired);
    if (m) {
      try {
        data[key] = JSON.parse(`"${m[1]}"`);
        salvagedAnything = true;
      } catch { /* leave it out */ }
    }
  }

  if (!salvagedAnything) {
    const err = new Error(
      "The model's response could not be parsed as JSON, and nothing could be salvaged from it."
    );
    err.warnings = warnings;
    err.raw = String(raw ?? "").slice(0, 4000);
    throw err;
  }

  return { data, warnings, recovered: true };
}

// A window of text around the parse error, so the Logs page can show the user
// exactly what the model emitted that broke.
function nearError(text, err) {
  const m = /position (\d+)/i.exec(err.message ?? "");
  if (!m) return text.slice(0, 400);
  const pos = Number(m[1]);
  const from = Math.max(0, pos - 180);
  const to = Math.min(text.length, pos + 180);
  return `…${text.slice(from, pos)}  <<< HERE >>>  ${text.slice(pos, to)}…`;
}
