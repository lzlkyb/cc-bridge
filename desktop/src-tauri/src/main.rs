#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use cc_bridge_desktop::*;

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("could not resolve app data directory");
            std::fs::create_dir_all(&data_dir).expect("could not create app data directory");

            let db_conn = db::init_database(&data_dir).expect("failed to initialize database");
            let bridge_config = config::load_config(&db_conn).expect("failed to load config");

            // Prune audit log per retention policy on startup
            let _ = audit::cleanup_old_entries(&data_dir, bridge_config.audit_retention_days);

            let app_state = Arc::new(state::AppState::new(db_conn, bridge_config, data_dir));
            app.manage(app_state.clone());

            // Spawn MCP HTTP server
            let mcp_state = app_state.clone();
            let mcp_handle = tauri::async_runtime::spawn(async move {
                mcp::http::spawn_mcp_server(mcp_state).await;
            });
            {
                let s = app_state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut h = s.mcp_server_handle.lock().await;
                    *h = Some(mcp_handle);
                });
            }

            // Create main window
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("cc-bridge")
                .inner_size(940.0, 760.0)
                .min_inner_size(560.0, 600.0)
                .build()?;

            // System tray
            let show_item = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;

            let tray_state = app_state.clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("missing default window icon"),
                )
                .on_menu_event(move |tray_app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = tray_app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "restart" => {
                        let s = tray_state.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut h = s.mcp_server_handle.lock().await;
                            if let Some(handle) = h.take() {
                                handle.abort();
                                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                            }
                            let sc = s.clone();
                            let new_handle = tauri::async_runtime::spawn(async move {
                                mcp::http::spawn_mcp_server(sc).await;
                            });
                            *h = Some(new_handle);
                        });
                    }
                    "quit" => {
                        tray_app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::save_config,
            commands::regenerate_token,
            commands::get_audit_log,
            commands::browse_directory,
            commands::restart_mcp_server,
            commands::stop_mcp_server,
            commands::start_mcp_server,
            commands::clear_audit_log,
            commands::get_lan_ips,
            commands::get_autostart,
            commands::set_autostart,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app_handle, _event| {});
}
