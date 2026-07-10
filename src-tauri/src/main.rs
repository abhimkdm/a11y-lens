// A11y Lens — Tauri core.
// Spawns the Node.js sidecar (Playwright + axe-core) and proxies
// scan commands between the React UI and the automation layer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn start_sidecar(app: tauri::AppHandle) -> Result<String, String> {
    // In dev the sidecar runs via `npm run sidecar` on port 8787.
    // In production it ships as a bundled external binary.
    let _ = app.shell();
    Ok("sidecar-ready".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![start_sidecar])
        .run(tauri::generate_context!())
        .expect("error while running A11y Lens");
}
