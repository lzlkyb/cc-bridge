#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use png::Decoder;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::Listener;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use cc_bridge_desktop::*;

/// 生成托盘图标：透明底 + 居中状态色圆点（运行时绿、停止灰）。
/// 用代码绘制，避免额外打包二进制图标资源。两份图标缓存在 static 中，
/// 仅泄露一次 4KB 数据，后续所有刷新都 clone 复用。
fn build_tray_icon(running: bool) -> tauri::image::Image<'static> {
    const S: u32 = 64;
    const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

    // Decode PNG → RGBA pixels
    let decoder = Decoder::new(ICON_PNG);
    let mut reader = match decoder.read_info() {
        Ok(r) => r,
        Err(_) => return fallback_dot(running),
    };
    let info = reader.info();
    let (w, h) = (info.width, info.height);
    let mut src = vec![0u8; (w * h * 4) as usize];
    if reader.next_frame(&mut src).is_err() {
        return fallback_dot(running);
    }

    // Scale to S×S using nearest-neighbor
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    for y in 0..S {
        let sy = (y as f64 * w as f64 / S as f64) as u32;
        for x in 0..S {
            let sx = (x as f64 * h as f64 / S as f64) as u32;
            let si = ((sy * w + sx) * 4) as usize;
            let di = ((y * S + x) * 4) as usize;
            rgba[di] = src[si];
            rgba[di + 1] = src[si + 1];
            rgba[di + 2] = src[si + 2];
            rgba[di + 3] = src[si + 3];
        }
    }

    // Draw status dot (bottom-right, 8px radius)
    let dot_r = 8;
    let dot_cx = S - dot_r - 1;
    let dot_cy = S - dot_r - 1;
    let (dr, dg, db) = if running {
        (34, 197, 134)
    } else {
        (148, 163, 184)
    };
    for y in 0..S {
        for x in 0..S {
            let dx = x as f32 - dot_cx as f32;
            let dy = y as f32 - dot_cy as f32;
            if (dx * dx + dy * dy) <= (dot_r * dot_r) as f32 {
                let idx = ((y * S + x) * 4) as usize;
                rgba[idx] = dr;
                rgba[idx + 1] = dg;
                rgba[idx + 2] = db;
                rgba[idx + 3] = 255;
            }
        }
    }

    let leaked: &'static [u8] = Box::leak(rgba.into_boxed_slice());
    tauri::image::Image::new(leaked, S, S)
}

fn fallback_dot(running: bool) -> tauri::image::Image<'static> {
    const S: u32 = 64;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let (cr, cg, cb) = if running {
        (34, 197, 134)
    } else {
        (148, 163, 184)
    };
    let cx = S as f32 / 2.0;
    let cy = S as f32 / 2.0;
    let r = 18.0;
    for y in 0..S {
        for x in 0..S {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = if dist <= r - 1.0 {
                255u8
            } else if dist >= r + 1.0 {
                0u8
            } else {
                let t = (r + 1.0 - dist) / 2.0;
                (t * 255.0) as u8
            };
            let idx = ((y * S + x) * 4) as usize;
            rgba[idx] = cr;
            rgba[idx + 1] = cg;
            rgba[idx + 2] = cb;
            rgba[idx + 3] = alpha;
        }
    }
    let leaked: &'static [u8] = Box::leak(rgba.into_boxed_slice());
    tauri::image::Image::new(leaked, S, S)
}

fn tray_icon(running: bool) -> tauri::image::Image<'static> {
    static ICONS: std::sync::OnceLock<(
        tauri::image::Image<'static>,
        tauri::image::Image<'static>,
    )> = std::sync::OnceLock::new();
    let icons = ICONS.get_or_init(|| (build_tray_icon(true), build_tray_icon(false)));
    (if running { &icons.0 } else { &icons.1 }).clone()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::other(format!("无法解析应用数据目录：{e}")))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| std::io::Error::other(format!("无法创建应用数据目录：{e}")))?;

            let db_conn = db::init_database(&data_dir)
                .map_err(|e| std::io::Error::other(format!("初始化数据库失败：{e}")))?;
            let bridge_config = config::load_config(&db_conn)
                .map_err(|e| std::io::Error::other(format!("加载配置失败：{e}")))?;

            // E-P2-4: 审计清理移到后台，避免大 audit.log 阻塞窗口显示
            {
                let cleanup_dir = data_dir.clone();
                let retention = bridge_config.audit_retention_days;
                tauri::async_runtime::spawn(async move {
                    let _ = audit::cleanup_old_entries(&cleanup_dir, retention);
                });
            }

            let app_state = Arc::new(state::AppState::new(db_conn, bridge_config, data_dir));
            app.manage(app_state.clone());

            // D2 修复：后台周期性回收空闲路径锁，避免 path_locks 随运行时间无界增长。
            {
                let gc_state = app_state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                    loop {
                        ticker.tick().await;
                        gc_state.gc_path_locks();
                        gc_state.gc_cwd_sessions();
                    }
                });
            }

            // Updater 插件容错注册：失败仅 warn，不中断应用启动（比如 pubkey 还是占位符时）。
            if let Err(e) = app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
            {
                log::warn!("初始化 Updater 插件失败，已跳过：{e}");
            }

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

            // Show main window (config: visible=false, decorations=false)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();

                // Win11 DWM 圆角
                #[cfg(target_os = "windows")]
                {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::Graphics::Dwm::{
                        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        let preference: i32 = 2; // DWMWCP_ROUNDSMALL = 2
                        unsafe {
                            if let Err(e) = DwmSetWindowAttribute(
                                HWND(hwnd.0 as isize),
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &preference as *const i32 as *const _,
                                std::mem::size_of::<i32>() as u32,
                            ) {
                                log::warn!("DWM 圆角设置失败: {:?}", e);
                            }
                        }
                    }
                }
            }

            // System tray
            let show_item = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let copy_cmd_item =
                MenuItem::with_id(app, "copy_cmd", "复制连接命令", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &copy_cmd_item, &restart_item, &quit_item],
            )?;

            let tray_state = app_state.clone();
            let tray_initial_running = tray_state
                .mcp_running
                .load(std::sync::atomic::Ordering::Relaxed);
            TrayIconBuilder::with_id("main-tray")
                .tooltip("cc-bridge")
                .menu(&menu)
                .icon(tray_icon(tray_initial_running))
                .on_tray_icon_event(move |tray_app, event| {
                    // 左键抬起：toggle 主窗口显隐（右键由 menu 接管）
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray_app.app_handle().get_webview_window("main") {
                            let _ = if w.is_visible().unwrap_or(false) {
                                w.hide()
                            } else {
                                w.show().and_then(|_| w.set_focus())
                            };
                        }
                    }
                })
                .on_menu_event(move |tray_app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = tray_app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "copy_cmd" => {
                        // 通过事件让前端（拥有 navigator.clipboard 能力）执行复制并 toast。
                        // Tauri v2 核心不提供 Rust 端剪贴板 API，故走前端通道。
                        let app_h = tray_app.app_handle().clone();
                        let _ = app_h.emit("copy-connect-command", ());
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

            // 启动后即时按真实状态刷新一次托盘图标（上面初始读取可能早于 mcp 置位）
            if let Some(tray) = app.handle().tray_by_id("main-tray") {
                let running = app_state
                    .mcp_running
                    .load(std::sync::atomic::Ordering::Relaxed);
                let _ = tray.set_icon(Some(tray_icon(running)));
            }

            // 监听前端/命令触发的状态变更事件，即时刷新托盘图标与 tooltip
            {
                let handle = app.handle().clone();
                app.listen("mcp-status-changed", move |_| {
                    let h = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let running = h
                            .state::<std::sync::Arc<state::AppState>>()
                            .mcp_running
                            .load(std::sync::atomic::Ordering::Relaxed);
                        if let Some(tray) = h.tray_by_id("main-tray") {
                            let _ = tray.set_icon(Some(tray_icon(running)));
                            let _ = tray.set_tooltip(Some(if running {
                                "cc-bridge · 服务运行中"
                            } else {
                                "cc-bridge · 已停止"
                            }));
                        }
                    });
                });
            }

            // 本机地址变更检测：定时对比 last_selected_ip 与当前网卡地址，
            // 驱动托盘 tooltip（常驻兜底）+ 系统通知（仅在“由一致变为不一致”那一刻弹一次）。
            {
                let handle = app.handle().clone();
                let watch_state = app_state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut alerting = false;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                        let last_ip = watch_state.config.read().await.last_selected_ip.clone();
                        let changed = match &last_ip {
                            Some(ip) => !network::get_lan_ips().contains(ip),
                            None => false,
                        };
                        let running = watch_state
                            .mcp_running
                            .load(std::sync::atomic::Ordering::Relaxed);
                        if let Some(tray) = handle.tray_by_id("main-tray") {
                            // tooltip：地址变化优先提示，否则显示运行状态
                            let tip = if changed {
                                "cc-bridge: 网络地址已变化，点击查看新连接命令"
                            } else if running {
                                "cc-bridge · 服务运行中"
                            } else {
                                "cc-bridge · 已停止"
                            };
                            let _ = tray.set_tooltip(Some(tip));
                            // 图标随运行状态刷新（地址变化不改变图标）
                            let _ = tray.set_icon(Some(tray_icon(running)));
                        }
                        if changed && !alerting {
                            let _ = handle
                                .notification()
                                .builder()
                                .title("cc-bridge")
                                .body("网络地址已变化，点击查看新连接命令")
                                .show();
                        }
                        alerting = changed;
                    }
                });
            }

            // 后台命令定时清理：每 60s 扫一次，把超过 5 分钟宽限期的已结束命令从
            // running_commands 注册表里移除（见 commands::cleanup_finished_commands）。
            {
                let cleanup_state = app_state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        commands::cleanup_finished_commands(&cleanup_state).await;
                    }
                });
            }

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
            commands::set_selected_ip,
            commands::get_autostart,
            commands::set_autostart,
            commands::list_running_commands,
            commands::stop_running_command,
            commands::get_command_output,
            commands::start_update,
            commands::export_config,
            commands::import_config,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())?
        .run(|_app_handle, _event| {});

    Ok(())
}
