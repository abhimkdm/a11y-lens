import { api } from "../services/api";

// Save a generated file, asking the user WHERE to put it whenever the platform
// allows it.
//
// Three tiers, best first:
//   1. showSaveFilePicker — a real native "Save As" dialog: the user picks the
//      folder and filename. Tauri v2 runs on WebView2 (Chromium) on Windows, so
//      this is available without adding a Tauri dialog plugin or any Rust change.
//   2. POST /export — writes to the sidecar's export directory and returns the
//      full path, which the caller shows so the file is still findable.
//   3. Blob download — last resort; the browser decides where it lands.
//
// Returns the saved path/name for display, or null if the user cancelled.

type SaveResult = { path: string | null; cancelled: boolean };

interface FilePickerWindow extends Window {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    name: string;
    createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

export async function saveFile(name: string, content: string, mime: string): Promise<SaveResult> {
  const w = window as FilePickerWindow;

  if (typeof w.showSaveFilePicker === "function") {
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: ext
          ? [{ description: describe(ext), accept: { [mime]: [ext] } }]
          : undefined,
      });
      const stream = await handle.createWritable();
      await stream.write(content);
      await stream.close();
      return { path: handle.name, cancelled: false };
    } catch (e) {
      // AbortError = the user pressed Cancel. Respect that; do NOT silently save
      // somewhere else, which is exactly the surprising behaviour we're fixing.
      if ((e as DOMException)?.name === "AbortError") return { path: null, cancelled: true };
      // Any other failure (permission, unsupported) falls through to the tiers below.
    }
  }

  const r = await api.exportFile(name, content).catch(() => null);
  if (r?.ok) return { path: r.path as string, cancelled: false };

  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  return { path: name, cancelled: false };
}

function describe(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".json": return "JSON file";
    case ".html": return "HTML report";
    case ".csv": return "CSV file";
    default: return "File";
  }
}
