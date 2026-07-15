// A11y Lens — Mobile accessibility rules (deterministic tier).
//
// These are MEASURED from the platform's own accessibility tree, not inferred by
// a model. Same principle as the web engine's probes: anything measurable gets
// measured, and the AI is only asked to judge what genuinely needs judgement.
//
// The rules are the native analogues of what Google's Accessibility Scanner and
// Apple's Accessibility Inspector check, mapped to WCAG 2.1 A/AA via WCAG2ICT
// (which is what makes native findings defensible in an EAA conformance report —
// WCAG applies to non-web software through that mapping).
//
// PLATFORM DIFFERENCES THAT MATTER AND ARE EASY TO GET WRONG:
//
//   Touch target minimum:  Android 48x48 dp   |   iOS 44x44 pt
//   Density:               Android reports PIXELS; dp = px / (dpi / 160).
//                          Skip that conversion and every target-size finding on
//                          a high-density phone is wrong by a factor of 3.
//   iOS:                   points are already density-independent — no conversion.

export const TARGET_MIN = { android: 48, ios: 44 }; // dp / pt

const INTERACTIVE_ANDROID = /Button|ImageButton|CheckBox|RadioButton|Switch|ToggleButton|EditText|Spinner|SeekBar|RatingBar|TabWidget/i;
const IOS_INTERACTIVE_TYPES = new Set([
  "Button", "Link", "SearchField", "TextField", "SecureTextField", "Switch",
  "Slider", "Stepper", "SegmentedControl", "Cell", "Tab", "MenuItem",
]);

// --- Android: parse the uiautomator XML dump --------------------------------
export function parseAndroidHierarchy(xml) {
  const nodes = [];

  // Deliberately regex rather than an XML DOM: uiautomator output is a flat,
  // machine-generated attribute soup, and pulling in an XML parser for it would
  // be a dependency we'd then have to bundle into the installer.
  for (const m of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/(\w[\w-]*)="([^"]*)"/g)) attrs[a[1]] = a[2];

    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    const bounds = b
      ? { x: +b[1], y: +b[2], w: +b[3] - +b[1], h: +b[4] - +b[2] }
      : { x: 0, y: 0, w: 0, h: 0 };

    nodes.push({
      class: attrs.class ?? "",
      resourceId: attrs["resource-id"] ?? "",
      text: (attrs.text ?? "").trim(),
      contentDesc: (attrs["content-desc"] ?? "").trim(),
      clickable: attrs.clickable === "true",
      longClickable: attrs["long-clickable"] === "true",
      focusable: attrs.focusable === "true",
      enabled: attrs.enabled === "true",
      checkable: attrs.checkable === "true",
      scrollable: attrs.scrollable === "true",
      displayed: attrs.displayed !== "false",
      password: attrs.password === "true",
      bounds,
      raw: m[0].slice(0, 300),
    });
  }
  return nodes;
}

// --- iOS: normalise idb's describe-all output -------------------------------
export function parseIosHierarchy(tree) {
  const nodes = [];
  const list = Array.isArray(tree) ? tree : [tree];

  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    const f = n.frame ?? {};
    nodes.push({
      type: n.type ?? "",
      label: (n.AXLabel ?? n.label ?? "").trim(),
      value: (n.AXValue ?? n.value ?? "").trim(),
      identifier: n.AXUniqueId ?? n.identifier ?? "",
      enabled: n.enabled !== false,
      // idb reports frames in POINTS, which are already density-independent.
      bounds: { x: f.x ?? 0, y: f.y ?? 0, w: f.width ?? 0, h: f.height ?? 0 },
      raw: JSON.stringify(n).slice(0, 300),
    });
    for (const c of n.children ?? []) walk(c);
  };
  list.forEach(walk);
  return nodes;
}

const describe = (n, platform) =>
  platform === "android"
    ? `<${n.class.split(".").pop()}${n.resourceId ? ` id="${n.resourceId.split("/").pop()}"` : ""}` +
      `${n.text ? ` text="${n.text}"` : ""}${n.contentDesc ? ` content-desc="${n.contentDesc}"` : ""}` +
      ` bounds=${n.bounds.w}x${n.bounds.h}>`
    : `<${n.type}${n.identifier ? ` id="${n.identifier}"` : ""}${n.label ? ` label="${n.label}"` : ""}` +
      ` frame=${Math.round(n.bounds.w)}x${Math.round(n.bounds.h)}>`;

/**
 * Run the deterministic rules.
 * @param nodes    normalised hierarchy
 * @param platform "android" | "ios"
 * @param info     { densityDpi } for Android — REQUIRED for correct dp maths
 */
export function runMobileRules(nodes, platform, info = {}) {
  const findings = [];
  const isAndroid = platform === "android";

  // Android hierarchies report pixels. Everything below is compared in dp/pt.
  const scale = isAndroid ? (info.densityDpi ?? 160) / 160 : 1;
  const toDp = (px) => px / scale;

  const visible = nodes.filter((n) =>
    isAndroid
      ? n.displayed && n.bounds.w > 0 && n.bounds.h > 0
      : n.bounds.w > 0 && n.bounds.h > 0
  );

  const interactive = visible.filter((n) =>
    isAndroid
      ? n.clickable || n.longClickable || n.checkable || INTERACTIVE_ANDROID.test(n.class)
      : IOS_INTERACTIVE_TYPES.has(n.type)
  );

  const nameOf = (n) => (isAndroid ? n.contentDesc || n.text : n.label);

  // --- 1. Interactive element with no accessible name -----------------------
  // The single most common, most damaging native defect. A screen reader
  // announces "button" and nothing else — the user has no idea what it does.
  const unlabeled = interactive.filter((n) => !nameOf(n) && !n.password);
  if (unlabeled.length) {
    findings.push({
      rule: "unlabeled-interactive-element",
      impact: "critical",
      title: `${unlabeled.length} interactive element${unlabeled.length === 1 ? "" : "s"} have no accessible name`,
      wcag: ["4.1.2 A", "1.1.1 A"],
      explanation: isAndroid
        ? "These controls are clickable but expose neither text nor a contentDescription. TalkBack announces only the control type — a user hears \"button\" with no idea what it does."
        : "These controls expose no accessibilityLabel. VoiceOver announces only the trait — the user hears \"button\" with no idea what it does.",
      fix: isAndroid
        ? 'Set android:contentDescription on the view (or app:tint-free ImageButton), or use ViewCompat.setAccessibilityDelegate. For decorative images, set android:importantForAccessibility="no" instead of an empty description.'
        : 'Set .accessibilityLabel on the control (SwiftUI: .accessibilityLabel("Close"); UIKit: view.accessibilityLabel = "Close"). For decorative views, set isAccessibilityElement = false.',
      evidence: unlabeled.slice(0, 5).map((n) => describe(n, platform)).join("\n"),
      elements: unlabeled.length,
      source: "measured",
    });
  }

  // --- 2. Touch target too small -------------------------------------------
  const min = TARGET_MIN[platform];
  const tooSmall = interactive.filter((n) => {
    const w = toDp(n.bounds.w);
    const h = toDp(n.bounds.h);
    return w > 0 && h > 0 && (w < min || h < min);
  });
  if (tooSmall.length) {
    findings.push({
      rule: "touch-target-too-small",
      impact: "serious",
      title: `${tooSmall.length} touch target${tooSmall.length === 1 ? " is" : "s are"} smaller than ${min}${isAndroid ? "dp" : "pt"}`,
      // Note: WCAG 2.1 has NO target-size criterion at AA (2.5.5 is AAA; 2.5.8 is
      // WCAG 2.2). We cite the platform guideline, and 2.5.5 AAA where relevant,
      // rather than inventing an AA criterion that does not exist.
      wcag: ["2.5.5 AAA"],
      guideline: isAndroid
        ? "Android Accessibility: minimum touch target 48x48dp"
        : "Apple HIG: minimum tappable area 44x44pt",
      explanation:
        `Targets below ${min}${isAndroid ? "dp" : "pt"} are hard to hit for users with motor impairments, tremor, or large fingers. ` +
        `Note this is not a WCAG 2.1 Level AA failure — WCAG 2.1 has no AA target-size criterion — but it is a platform guideline violation and a real usability barrier.`,
      fix: isAndroid
        ? `Increase the view's minWidth/minHeight to ${min}dp, or expand the tappable area with TouchDelegate without changing the visual size.`
        : `Increase the control's frame to at least ${min}x${min}pt, or add .contentShape(Rectangle()) with padding to enlarge the hit area without changing the visual size.`,
      evidence: tooSmall
        .slice(0, 5)
        .map((n) => `${describe(n, platform)} — ${Math.round(toDp(n.bounds.w))}x${Math.round(toDp(n.bounds.h))}${isAndroid ? "dp" : "pt"}`)
        .join("\n"),
      elements: tooSmall.length,
      source: "measured",
    });
  }

  // --- 3. Duplicate accessible names ---------------------------------------
  // Screen reader users navigate by name. Five controls all called "More" are
  // indistinguishable — the user cannot tell which one they're about to activate.
  const byName = new Map();
  for (const n of interactive) {
    const name = nameOf(n);
    if (!name) continue;
    const list = byName.get(name.toLowerCase()) ?? [];
    list.push(n);
    byName.set(name.toLowerCase(), list);
  }
  const dupes = [...byName.entries()].filter(([, v]) => v.length > 1);
  if (dupes.length) {
    findings.push({
      rule: "duplicate-accessible-names",
      impact: "moderate",
      title: `${dupes.length} accessible name${dupes.length === 1 ? " is" : "s are"} used by multiple controls`,
      wcag: ["2.4.6 AA", "4.1.2 A"],
      explanation:
        "Several controls share the same name. Screen reader users navigate by name, so identical names make the controls indistinguishable — the user cannot tell which one they are about to activate.",
      fix: isAndroid
        ? 'Give each control a distinct contentDescription that includes its context, e.g. "More about Fibernet" rather than "More".'
        : 'Give each control a distinct accessibilityLabel that includes its context, e.g. "More about Fibernet" rather than "More".',
      evidence: dupes
        .slice(0, 4)
        .map(([name, list]) => `"${name}" used by ${list.length} controls: ${list.slice(0, 3).map((n) => describe(n, platform)).join(", ")}`)
        .join("\n"),
      elements: dupes.reduce((n, [, v]) => n + v.length, 0),
      source: "measured",
    });
  }

  // --- 4. Android: clickable but not focusable ------------------------------
  // A control that can be tapped but never receives accessibility focus is
  // unreachable by TalkBack — it may as well not exist.
  if (isAndroid) {
    const unfocusable = visible.filter((n) => n.clickable && !n.focusable && n.enabled);
    if (unfocusable.length) {
      findings.push({
        rule: "clickable-not-focusable",
        impact: "serious",
        title: `${unfocusable.length} clickable element${unfocusable.length === 1 ? " is" : "s are"} not reachable by TalkBack`,
        wcag: ["2.1.1 A"],
        explanation:
          "These views handle taps but are not focusable, so TalkBack's swipe navigation never lands on them. A screen reader user cannot reach or activate them at all.",
        fix: 'Set android:focusable="true" on the view (and android:clickable="true"), or attach the click handler to a focusable parent rather than a bare View/LinearLayout.',
        evidence: unfocusable.slice(0, 5).map((n) => describe(n, platform)).join("\n"),
        elements: unfocusable.length,
        source: "measured",
      });
    }
  }

  // --- 5. Editable field with no label --------------------------------------
  const fields = visible.filter((n) =>
    isAndroid ? /EditText/i.test(n.class) : n.type === "TextField" || n.type === "SecureTextField"
  );
  const unlabeledFields = fields.filter((n) => !nameOf(n));
  if (unlabeledFields.length) {
    findings.push({
      rule: "unlabeled-input-field",
      impact: "critical",
      title: `${unlabeledFields.length} input field${unlabeledFields.length === 1 ? " has" : "s have"} no label`,
      wcag: ["3.3.2 A", "4.1.2 A"],
      explanation:
        "A text field with no accessible name gives the screen reader user nothing to identify it by. On a form — a login, an address, a payment — this stops the task outright.",
      fix: isAndroid
        ? "Set android:hint (which becomes the accessible name) or associate a TextView with android:labelFor. A hint alone disappears once the user types, so prefer labelFor for long forms."
        : "Set .accessibilityLabel on the field. A placeholder is not a label — it disappears on input and VoiceOver may not announce it.",
      evidence: unlabeledFields.slice(0, 5).map((n) => describe(n, platform)).join("\n"),
      elements: unlabeledFields.length,
      source: "measured",
    });
  }

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) counts[f.impact]++;

  return {
    findings,
    counts,
    stats: {
      totalElements: nodes.length,
      visibleElements: visible.length,
      interactiveElements: interactive.length,
      labeledInteractive: interactive.filter((n) => nameOf(n)).length,
      platform,
      densityDpi: isAndroid ? (info.densityDpi ?? 160) : null,
    },
  };
}

/** Compact text rendering of the hierarchy, for the AI prompt. */
export function hierarchyToText(nodes, platform, limit = 120) {
  const isAndroid = platform === "android";
  return nodes
    .filter((n) => (isAndroid ? n.displayed : true) && n.bounds.w > 0 && n.bounds.h > 0)
    .slice(0, limit)
    .map((n) => {
      const name = isAndroid ? n.contentDesc || n.text : n.label;
      const kind = isAndroid ? n.class.split(".").pop() : n.type;
      const flags = isAndroid
        ? [n.clickable && "clickable", n.focusable && "focusable", !n.enabled && "disabled"].filter(Boolean)
        : [!n.enabled && "disabled"].filter(Boolean);
      return `  ${kind}${name ? ` "${name}"` : " (NO NAME)"} ` +
        `@${n.bounds.x},${n.bounds.y} ${n.bounds.w}x${n.bounds.h}` +
        `${flags.length ? ` [${flags.join(",")}]` : ""}`;
    })
    .join("\n");
}
