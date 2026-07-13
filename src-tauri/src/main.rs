// A11y Lens — Tauri core.
//
// The packaged app has no terminal to run `npm run sidecar` in, so the Rust
// side owns the sidecar's whole lifecycle:
//
//   app launch  -> spawn the bundled sidecar binary as a managed child process
//   while open  -> drain its stdout/stderr so the OS pipe buffer can't fill and
//                  deadlock the process (a real failure mode, not a formality)
//   app exit    -> kill it, so we never leave an orphaned server on :8787
//
// In `tauri dev` we deliberately do NOT spawn: the developer already runs
// `npm run sidecar` themselves, and two servers fighting over port 8787 is
// worse than none.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar so we can kill it on exit.
struct SidecarProcess(Mutex<Option<CommandChild>>);

fn spawn_sidecar(app: &tauri::AppHandle) -> Result<CommandChild, String> {
    let (mut rx, child) = app
        .shell()
        .sidecar("a11y-sidecar")
        .map_err(|e| format!("sidecar binary not found in the bundle: {e}"))?
        .spawn()
        .map_err(|e| format!("failed to start sidecar: {e}"))?;

    // Drain the child's output. If nobody reads these pipes they eventually fill
    // and the sidecar blocks on its next write — which presents as a silent hang.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] exited with code {:?}", payload.code);
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Lets the UI tell "sidecar never started" apart from "sidecar is still booting".
#[tauri::command]
fn sidecar_status(state: State<'_, SidecarProcess>) -> bool {
    state.0.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Manual restart, wired to the UI's retry button.
#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle, state: State<'_, SidecarProcess>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "sidecar state is poisoned".to_string())?;
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    let child = spawn_sidecar(&app)?;
    *guard = Some(child);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![sidecar_status, restart_sidecar])
        .setup(|app| {
            // In dev the developer runs `npm run sidecar` in their own terminal.
            // Spawning here as well would collide on port 8787.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                match spawn_sidecar(&handle) {
                    Ok(child) => {
                        let state = app.state::<SidecarProcess>();
                        *state.0.lock().unwrap() = Some(child);
                        println!("[a11y-lens] sidecar started");
                    }
                    Err(e) => {
                        // Don't abort startup — the UI shows a clear error and a
                        // retry button, which beats a window that never opens.
                        eprintln!("[a11y-lens] {e}");
                    }
                }
            }
            #[cfg(debug_assertions)]
            {
                let _ = app;
                println!("[a11y-lens] dev mode — expecting `npm run sidecar` to be running");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building A11y Lens")
        .run(|app_handle, event| {
            // Kill the sidecar on exit. Without this, closing the window leaves an
            // orphaned Node process holding port 8787 and the next launch fails.
            if let RunEvent::Exit = event {
                let state = app_handle.state::<SidecarProcess>();
                // Take the child out in its own statement. Using `state.0.lock()`
                // directly as an `if let` scrutinee keeps the temporary Result (and
                // the MutexGuard inside it) alive until the end of the block — which
                // outlives `state` itself and fails the borrow check (E0597).
                let child = state.0.lock().ok().and_then(|mut guard| guard.take());
                if let Some(child) = child {
                    let _ = child.kill();
                    println!("[a11y-lens] sidecar stopped");
                }
            }
        });
}