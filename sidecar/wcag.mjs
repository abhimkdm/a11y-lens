// A11y Lens — WCAG 2.1 scope guard.
//
// The whole tool targets WCAG 2.1 Level A + AA. That is a real constraint, not
// a label: models routinely cite WCAG 2.2 criteria (2.4.11 Focus Not Obscured,
// 2.5.8 Target Size Minimum, 3.3.7 Redundant Entry, 3.3.8 Accessible
// Authentication) because they are heavily represented in training data. Citing
// a 2.2 criterion in a 2.1 conformance report is a defect — it points a
// developer at a requirement that does not apply to the target standard.
//
// So we don't merely ask the model to stay in scope; we validate every citation
// and re-map or drop what falls outside it.

// Every Level A and AA success criterion in WCAG 2.1. AAA is deliberately absent.
export const WCAG21_AA = {
  "1.1.1": { level: "A", name: "Non-text Content" },
  "1.2.1": { level: "A", name: "Audio-only and Video-only (Prerecorded)" },
  "1.2.2": { level: "A", name: "Captions (Prerecorded)" },
  "1.2.3": { level: "A", name: "Audio Description or Media Alternative" },
  "1.2.4": { level: "AA", name: "Captions (Live)" },
  "1.2.5": { level: "AA", name: "Audio Description (Prerecorded)" },
  "1.3.1": { level: "A", name: "Info and Relationships" },
  "1.3.2": { level: "A", name: "Meaningful Sequence" },
  "1.3.3": { level: "A", name: "Sensory Characteristics" },
  "1.3.4": { level: "AA", name: "Orientation" },
  "1.3.5": { level: "AA", name: "Identify Input Purpose" },
  "1.4.1": { level: "A", name: "Use of Color" },
  "1.4.2": { level: "A", name: "Audio Control" },
  "1.4.3": { level: "AA", name: "Contrast (Minimum)" },
  "1.4.4": { level: "AA", name: "Resize Text" },
  "1.4.5": { level: "AA", name: "Images of Text" },
  "1.4.10": { level: "AA", name: "Reflow" },
  "1.4.11": { level: "AA", name: "Non-text Contrast" },
  "1.4.12": { level: "AA", name: "Text Spacing" },
  "1.4.13": { level: "AA", name: "Content on Hover or Focus" },
  "2.1.1": { level: "A", name: "Keyboard" },
  "2.1.2": { level: "A", name: "No Keyboard Trap" },
  "2.1.4": { level: "A", name: "Character Key Shortcuts" },
  "2.2.1": { level: "A", name: "Timing Adjustable" },
  "2.2.2": { level: "A", name: "Pause, Stop, Hide" },
  "2.3.1": { level: "A", name: "Three Flashes or Below Threshold" },
  "2.4.1": { level: "A", name: "Bypass Blocks" },
  "2.4.2": { level: "A", name: "Page Titled" },
  "2.4.3": { level: "A", name: "Focus Order" },
  "2.4.4": { level: "A", name: "Link Purpose (In Context)" },
  "2.4.5": { level: "AA", name: "Multiple Ways" },
  "2.4.6": { level: "AA", name: "Headings and Labels" },
  "2.4.7": { level: "AA", name: "Focus Visible" },
  "2.5.1": { level: "A", name: "Pointer Gestures" },
  "2.5.2": { level: "A", name: "Pointer Cancellation" },
  "2.5.3": { level: "A", name: "Label in Name" },
  "2.5.4": { level: "A", name: "Motion Actuation" },
  "3.1.1": { level: "A", name: "Language of Page" },
  "3.1.2": { level: "AA", name: "Language of Parts" },
  "3.2.1": { level: "A", name: "On Focus" },
  "3.2.2": { level: "A", name: "On Input" },
  "3.2.3": { level: "AA", name: "Consistent Navigation" },
  "3.2.4": { level: "AA", name: "Consistent Identification" },
  "3.3.1": { level: "A", name: "Error Identification" },
  "3.3.2": { level: "A", name: "Labels or Instructions" },
  "3.3.3": { level: "AA", name: "Error Suggestion" },
  "3.3.4": { level: "AA", name: "Error Prevention (Legal, Financial, Data)" },
  "4.1.1": { level: "A", name: "Parsing" },
  "4.1.2": { level: "A", name: "Name, Role, Value" },
  "4.1.3": { level: "AA", name: "Status Messages" },
};

// WCAG 2.2 additions. If a model cites one of these we know exactly what it did,
// and in most cases there is a 2.1 criterion that carries the same finding.
export const WCAG22_ONLY = {
  "2.4.11": { name: "Focus Not Obscured (Minimum)", remapTo: "2.4.7" },
  "2.4.12": { name: "Focus Not Obscured (Enhanced)", remapTo: "2.4.7" },
  "2.4.13": { name: "Focus Appearance", remapTo: "2.4.7" },
  "2.5.7": { name: "Dragging Movements", remapTo: "2.5.1" },
  "2.5.8": { name: "Target Size (Minimum)", remapTo: null },   // no 2.1 AA equivalent
  "3.2.6": { name: "Consistent Help", remapTo: null },
  "3.3.7": { name: "Redundant Entry", remapTo: null },
  "3.3.8": { name: "Accessible Authentication (Minimum)", remapTo: null },
  "3.3.9": { name: "Accessible Authentication (Enhanced)", remapTo: null },
};

export const extractCriterion = (s) => String(s ?? "").match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

// The list of criteria the model is allowed to cite, formatted for the prompt.
// Only those an automated scanner CANNOT evaluate — citing 1.1.1 (missing alt)
// is pointless here, axe already caught it.
export const EXPERT_CITABLE = [
  "1.3.1", "1.3.2", "1.3.3", "1.3.5", "1.4.1", "1.4.10", "1.4.11", "1.4.12", "1.4.13",
  "2.1.1", "2.1.2", "2.1.4", "2.2.1", "2.2.2", "2.4.1", "2.4.2", "2.4.3", "2.4.4",
  "2.4.5", "2.4.6", "2.4.7", "2.5.1", "2.5.2", "2.5.3", "2.5.4",
  "3.2.1", "3.2.2", "3.2.3", "3.2.4", "3.3.1", "3.3.2", "3.3.3", "3.3.4",
  "4.1.2", "4.1.3",
];

export function citableList() {
  return EXPERT_CITABLE
    .map((c) => `${c} ${WCAG21_AA[c].level} (${WCAG21_AA[c].name})`)
    .join(", ");
}

// Normalize a finding's wcag[] to WCAG 2.1 A/AA.
// Returns { wcag, outOfScope, remapped } — the caller decides what to do with
// a finding whose citations were ALL out of scope.
export function normalizeWcag(list) {
  const out = [];
  const outOfScope = [];
  const remapped = [];

  for (const raw of Array.isArray(list) ? list : []) {
    const c = extractCriterion(raw);
    if (!c) continue;

    if (WCAG21_AA[c]) {
      const tag = `${c} ${WCAG21_AA[c].level}`;
      if (!out.includes(tag)) out.push(tag);
      continue;
    }

    if (WCAG22_ONLY[c]) {
      const to = WCAG22_ONLY[c].remapTo;
      if (to && WCAG21_AA[to]) {
        const tag = `${to} ${WCAG21_AA[to].level}`;
        if (!out.includes(tag)) out.push(tag);
        remapped.push({ from: c, to });
      } else {
        outOfScope.push(c);   // genuinely has no WCAG 2.1 home
      }
      continue;
    }

    outOfScope.push(c);       // AAA, invented, or malformed
  }

  return { wcag: out, outOfScope, remapped };
}
