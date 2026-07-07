// Native desktop shell for cc-bridge.
//
// `cargo check` passes on Linux (x86_64-unknown-linux-gnu, verified in a
// throwaway Ubuntu 24.04 container with webkit2gtk/gtk3/appindicator dev
// packages installed) — that exercises the same tauri/tauri-plugin-shell/
// tauri-plugin-single-instance API surface this file uses on every
// platform, since none of the code below is behind a #[cfg(windows)] or
// similar platform gate. It has NOT been built for the actual Windows
// target, and `cargo tauri build`'s NSIS bundling step is Windows-only —
// verify that part for real on the target Windows machine.
//
//   - The actual MCP server logic lives entirely in ../../server/
//     (Node.js). This Rust code never reimplements any of it — it only
//     spawns the SEA-built cc-bridge(.exe) as a "sidecar" child process
//     and puts a native window/tray around it.
//   - CC_BRIDGE_DATA_DIR is passed to the sidecar so it stores
//     config.json/audit.log/backups under this app's per-user data
//     directory instead of next to the (likely read-only, under Program
//     Files) sidecar binary — see getBaseDir() in cc-bridge.js.
//   - A background thread polls config.json for host/port changes and
//     transparently restarts the sidecar + renavigates the window when it
//     sees one, so changing network settings in the web panel no longer
//     requires the user to manually restart anything.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

type ChildState = Arc<Mutex<Option<CommandChild>>>;

#[derive(serde::Deserialize)]
struct ServerConfig {
    token: String,
    port: u16,
    #[serde(default)]
    host: String,
}

fn read_config(data_dir: &Path) -> Option<ServerConfig> {
    let content = std::fs::read_to_string(data_dir.join("config.json")).ok()?;
    serde_json::from_str(&content).ok()
}

// Polls until config.json exists with a token+port AND that port is
// actually accepting TCP connections, or gives up after `timeout`.
fn wait_for_ready(data_dir: &Path, timeout: Duration) -> Option<ServerConfig> {
    let start = std::time::Instant::now();
    loop {
        if let Some(cfg) = read_config(data_dir) {
            let addr = format!("127.0.0.1:{}", cfg.port);
            if let Ok(socket_addr) = addr.parse() {
                if std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_millis(200)).is_ok() {
                    return Some(cfg);
                }
            }
        }
        if start.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn panel_url(cfg: &ServerConfig) -> Option<url::Url> {
    format!("http://127.0.0.1:{}/?token={}&managed=1", cfg.port, cfg.token)
        .parse()
        .ok()
}

// Kills any previous sidecar, spawns a fresh one, waits for it to come up,
// then either creates the main window (first call) or navigates the
// existing one (subsequent calls, e.g. after a config-driven restart).
fn start_or_restart_sidecar(app: &tauri::AppHandle, data_dir: &Path, child_state: &ChildState) {
    if let Some(old_child) = child_state.lock().unwrap().take() {
        let _ = old_child.kill();
        std::thread::sleep(Duration::from_millis(300));
    }

    let sidecar_command = match app.shell().sidecar("cc-bridge") {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("[desktop] failed to prepare sidecar command: {e}");
            return;
        }
    };

    let spawn_result = sidecar_command
        .env("CC_BRIDGE_DATA_DIR", data_dir.to_string_lossy().to_string())
        .spawn();

    let (mut rx, child) = match spawn_result {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[desktop] failed to spawn sidecar: {e}");
            return;
        }
    };

    *child_state.lock().unwrap() = Some(child);

    // Forward the sidecar's own stdout/stderr into this process's console
    // (useful for diagnosing startup failures during development).
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    eprintln!("[sidecar] error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    let cfg = match wait_for_ready(data_dir, Duration::from_secs(10)) {
        Some(cfg) => cfg,
        None => {
            eprintln!("[desktop] sidecar did not become ready within 10s");
            return;
        }
    };

    let url = match panel_url(&cfg) {
        Some(u) => u,
        None => {
            eprintln!("[desktop] failed to build panel URL");
            return;
        }
    };

    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.navigate(url);
        }
        None => {
            if let Err(e) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("cc-bridge")
                .inner_size(1080.0, 820.0)
                .build()
            {
                eprintln!("[desktop] failed to create main window: {e}");
            }
        }
    }
}

// Background loop: if config.json's host/port differ from what the running
// sidecar was last started with, restart it and point the window at the
// new address. Everything else (allowedRoots, extensions, rate limit,
// backup retention) already hot-applies inside the sidecar itself and
// needs no restart, so this only watches host/port.
fn spawn_config_watcher(app: tauri::AppHandle, data_dir: PathBuf, child_state: ChildState) {
    std::thread::spawn(move || {
        let mut last: Option<(String, u16)> = None;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if let Some(cfg) = read_config(&data_dir) {
                let current = (cfg.host.clone(), cfg.port);
                match &last {
                    None => last = Some(current),
                    Some(prev) if *prev != current => {
                        eprintln!("[desktop] host/port changed in config.json, restarting sidecar");
                        start_or_restart_sidecar(&app, &data_dir, &child_state);
                        last = Some(current);
                    }
                    _ => {}
                }
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("could not resolve app data directory");
            std::fs::create_dir_all(&data_dir).expect("could not create app data directory");

            let child_state: ChildState = Arc::new(Mutex::new(None));
            app.manage(child_state.clone());

            let show_item = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;

            let tray_handle = handle.clone();
            let tray_data_dir = data_dir.clone();
            let tray_child_state = child_state.clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("missing default window icon — run `npx tauri icon` first"),
                )
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "restart" => {
                        start_or_restart_sidecar(&tray_handle, &tray_data_dir, &tray_child_state);
                    }
                    "quit" => {
                        if let Some(child) = tray_child_state.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // First boot: spawn the sidecar and create the main window once
            // it's actually listening. Done on a background thread so the
            // (up to 10s) readiness wait never blocks Tauri's own setup.
            let boot_handle = handle.clone();
            let boot_data_dir = data_dir.clone();
            let boot_child_state = child_state.clone();
            std::thread::spawn(move || {
                start_or_restart_sidecar(&boot_handle, &boot_data_dir, &boot_child_state);
            });

            spawn_config_watcher(handle.clone(), data_dir.clone(), child_state.clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window (the X button) hides it instead of quitting
            // — the sidecar keeps running in the background. Only the tray's
            // "退出" menu item actually terminates the app + sidecar.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Safety net: make sure the sidecar never outlives the app,
            // even on exit paths that don't go through the tray's "退出".
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<ChildState>();
                let leftover_child = state.lock().unwrap().take();
                if let Some(child) = leftover_child {
                    let _ = child.kill();
                }
            }
        });
}
