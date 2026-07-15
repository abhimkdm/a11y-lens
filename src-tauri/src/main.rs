// A11y Lens — Tauri core.
//
// The packaged app has no terminal to run `npm run sidecar` in, so Rust owns the
// sidecar's whole lifecycle.
//
// WHY WE SPAWN NODE + A SCRIPT, NOT A SINGLE-FILE EXE:
// Playwright cannot be packed into a pkg/SEA binary — playwright-core does
// runtime lookups for real files (browsers.json, driver scripts) that don't exist
// inside a virtual snapshot filesystem, and the process dies immediately with
// MODULE_NOT_FOUND. So we ship a real Node runtime (renamed `a11y-node`, so we
// can safely kill only OUR orphans and never the user's own node processes) plus
// the sidecar source as a Tauri resource.
//
// Startup is defensive because "it didn't start" is the worst possible error to
// hand a user with no terminal:
//   - if a healthy sidecar is already listening, reuse it instead of fighting it
//   - otherwise kill any orphan of OURS still holding the port
//   - then spawn, retrying up to 3 attempts
//   - capture stderr, so a failure can be explained rather than guessed at
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 8787;
const MAX_ATTEMPTS: u8 = 3; // one initial try + two retries

struct SidecarProcess {
    child: Mutex<Option<CommandChild>>,
    /// Last lines the sidecar wrote to stderr, so a failure can be shown to the
    /// user instead of a generic "couldn't reach it".
    last_error: Arc<Mutex<String>>,
}

/// Is *our* sidecar already listening and healthy? If so we reuse it rather than
/// starting a second one that would only lose the port race anyway.
fn healthy_sidecar_running() -> bool {
    // Annotate the address type explicitly: `.parse()` has no other clue what to
    // produce here, and leaving it to inference is a needless gamble.
    let addr: std::net::SocketAddr = match format!("127.0.0.1:{PORT}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };

    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false; // nothing listening
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body);
    let _ = stream.shutdown(Shutdown::Both);

    // Only treat it as ours if it identifies itself. Something else on 8787 is a
    // different problem, and pretending it's our sidecar would be worse.
    body.contains("a11y-lens-sidecar")
}

/// Kill orphaned sidecars left behind by a crash. Safe by construction: we only
/// target our uniquely-named runtime binary, never a user's own `node`.
fn kill_orphan_sidecars() {
    #[cfg(target_os = "windows")]
    {
        // Must match Tauri's externalBin name + target triple (not "a11y-node.exe").
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "a11y-node-x86_64-pc-windows-msvc.exe", "/T"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW — don't flash a console
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "a11y-node"])
            .status();
    }
    std::thread::sleep(Duration::from_millis(600)); // let the OS release the port
}

fn spawn_sidecar(app: &tauri::AppHandle, last_error: Arc<Mutex<String>>) -> Result<CommandChild, String> {
    // Ship layout: <resource>/sidecar/server.mjs + <resource>/node_modules/...
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("could not locate bundled resources: {e}"))?;
    // Windows returns `\\?\C:\...` here. Node 24 dies on that as the main module
    // (EISDIR: lstat 'C:'). Stripping the prefix is not enough when the absolute
    // path also contains `\a` etc. — so we set cwd and pass a relative script path.
    let resource_dir = dunce::simplified(&resource_dir).to_path_buf();

    let script = resource_dir.join("sidecar").join("server.mjs");
    if !script.is_file() {
        return Err(format!(
            "bundled sidecar script not found at {}",
            script.display()
        ));
    }

    println!(
        "[a11y-lens] spawning sidecar: cwd={}, script=sidecar/server.mjs",
        resource_dir.display()
    );

    let (mut rx, child) = app
        .shell()
        .sidecar("a11y-node")
        .map_err(|e| format!("bundled Node runtime not found: {e}"))?
        .current_dir(&resource_dir)
        .args(["--no-warnings=ExperimentalWarning", "sidecar/server.mjs"])
        .spawn()
        .map_err(|e| format!("failed to start the sidecar: {e}"))?;

    // Drain the pipes. If nobody reads them they fill up and the child blocks on
    // its next write — a hang that looks exactly like a crash.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    eprintln!("[sidecar] {text}");
                    if let Ok(mut buf) = last_error.lock() {
                        buf.push_str(&text);
                        if buf.len() > 4000 {
                            let cut = buf.len() - 4000;
                            buf.drain(..cut);
                        }
                    }
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

/// Spawn with retries. Between attempts we kill our own orphans, because the
/// overwhelmingly common cause of a failed start is a previous instance that
/// crashed without releasing port 8787.
fn start_sidecar_with_retries(
    app: &tauri::AppHandle,
    last_error: Arc<Mutex<String>>,
) -> Result<Option<CommandChild>, String> {
    if healthy_sidecar_running() {
        println!("[a11y-lens] a healthy sidecar is already running — reusing it");
        return Ok(None);
    }

    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            println!("[a11y-lens] sidecar attempt {attempt}/{MAX_ATTEMPTS} — clearing orphans first");
            kill_orphan_sidecars();
        }

        match spawn_sidecar(app, last_error.clone()) {
            Ok(child) => {
                // Give it a moment, then confirm it's actually serving. A process
                // that spawned and immediately died is not a success.
                for _ in 0..20 {
                    std::thread::sleep(Duration::from_millis(250));
                    if healthy_sidecar_running() {
                        println!("[a11y-lens] sidecar is up (attempt {attempt})");
                        return Ok(Some(child));
                    }
                }
                last_err = "the sidecar started but never began listening".into();
                let _ = child.kill();
            }
            Err(e) => {
                last_err = e;
            }
        }
        eprintln!("[a11y-lens] sidecar attempt {attempt} failed: {last_err}");
    }

    Err(last_err)
}

#[tauri::command]
fn sidecar_status(state: State<'_, SidecarProcess>) -> bool {
    let running = state.child.lock().map(|g| g.is_some()).unwrap_or(false);
    running || healthy_sidecar_running()
}

/// What the sidecar said on its way down — shown in the UI so a failure is
/// diagnosable instead of a shrug.
#[tauri::command]
fn sidecar_last_error(state: State<'_, SidecarProcess>) -> String {
    state.last_error.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle, state: State<'_, SidecarProcess>) -> Result<(), String> {
    // Drop the old child before touching orphans, or we'd kill our own handle.
    let existing = state.child.lock().ok().and_then(|mut g| g.take());
    if let Some(child) = existing {
        let _ = child.kill();
        std::thread::sleep(Duration::from_millis(300));
    }
    kill_orphan_sidecars();

    if let Ok(mut buf) = state.last_error.lock() {
        buf.clear();
    }

    let child = start_sidecar_with_retries(&app, state.last_error.clone())?;
    if let Ok(mut guard) = state.child.lock() {
        *guard = child;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarProcess {
            child: Mutex::new(None),
            last_error: Arc::new(Mutex::new(String::new())),
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            restart_sidecar,
            sidecar_last_error
        ])
        .setup(|app| {
            // In dev the developer runs `npm run sidecar` themselves; spawning here
            // too would just collide on the port.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                let state = app.state::<SidecarProcess>();
                let last_error = state.last_error.clone();
                match start_sidecar_with_retries(&handle, last_error) {
                    Ok(child) => {
                        if let Ok(mut guard) = state.child.lock() {
                            *guard = child;
                        }
                    }
                    Err(e) => {
                        // Never abort startup. A window with a clear error and a
                        // retry button beats a window that never opens.
                        eprintln!("[a11y-lens] sidecar failed after {MAX_ATTEMPTS} attempts: {e}");
                        if let Ok(mut buf) = state.last_error.lock() {
                            buf.push_str(&format!("\nStartup failed after {MAX_ATTEMPTS} attempts: {e}"));
                        }
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
            // Kill the sidecar on exit, or the next launch inherits an orphan
            // squatting on port 8787.
            if let RunEvent::Exit = event {
                let state = app_handle.state::<SidecarProcess>();
                // Bind the take() to a let: using `state.child.lock()` directly as an
                // `if let` scrutinee keeps the MutexGuard alive past `state` (E0597).
                let child = state.child.lock().ok().and_then(|mut guard| guard.take());
                if let Some(child) = child {
                    let _ = child.kill();
                    println!("[a11y-lens] sidecar stopped");
                }
            }
        });
}
