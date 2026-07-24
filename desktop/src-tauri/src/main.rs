#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use png::Decoder;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Listener;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
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
        // 修复：源行 sy 应按源高 h 缩放、源列 sx 应按源宽 w 缩放；此前 w/h 用反，
        // 非正方形图标下 sy 可能超过实际行数导致 si 越界 panic 或色彩错乱。
        let sy = (y as f64 * h as f64 / S as f64) as u32;
        for x in 0..S {
            let sx = (x as f64 * w as f64 / S as f64) as u32;
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

/// 托盘状态刷新（带去重）：仅当 running 或 tooltip 文本真正变化时才重设图标/tooltip。
/// 三处刷新点（初始/状态事件/地址变化循环）共享同一 `last` 缓存，消除网络抖动导致的
/// 高频 set_icon 在 Windows 上表现为的图标闪烁（同状态重复重设即闪）。
fn refresh_tray(
    tray: &tauri::tray::TrayIcon,
    running: bool,
    tip: &str,
    last: &std::sync::Arc<std::sync::Mutex<(bool, String)>>,
) {
    let mut g = last.lock().unwrap();
    if g.0 == running && g.1 == tip {
        return; // 无变化，跳过重设（防高频重绘闪烁）
    }
    let _ = tray.set_icon(Some(tray_icon(running)));
    let _ = tray.set_tooltip(Some(tip));
    *g = (running, tip.to_string());
}

/// G1 修复：后台周期任务加 panic 恢复。之前 4 个 tauri::async_runtime::spawn 循环任一 panic 后，该循环会
/// 永久静默停止（托盘不刷新/命令注册表不回收/防火墙缓存过期等），用户和日志都无感知。
/// 用 JoinHandle 的 panic 检测做自愈：内层任务 panic → 记录错误日志 → 短暂延迟后重新 spawn。
fn spawn_supervised<F>(name: &'static str, make_task: F)
where
    F: Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = tauri::async_runtime::spawn(make_task());
            match handle.await {
                Ok(()) => {
                    log::warn!("后台任务「{name}」意外正常退出（预期是永久循环），1s 后重启");
                }
                Err(e) => {
                    log::error!("后台任务「{name}」 panic，1s 后自愈重启：{e}");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();

    // 抑制子进程（如 netsh）初始化失败时的「应用程序错误」硬弹窗（0xc0000142）。
    // 必须在 spawn 任何 netsh 之前调用，错误模式会被其后创建的子进程继承。
    #[cfg(windows)]
    crate::firewall::suppress_child_error_dialogs();

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
        .plugin(tauri_plugin_clipboard_manager::init())
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

            // 注入 AppHandle 供 MCP 工具调用 Tauri 插件（notification 等）
            *app_state.app_handle.lock().unwrap() = Some(app.handle().clone());

            // 防火墙：启动探测 netsh 是否可用。不可用时置 false，停止后续查询，
            // 避免 netsh 损坏时反复 spawn 失败进程、且不再触发「应用程序错误」弹窗
            // （错误模式已在 main() 抑制）。须在后台定时刷新任务之前完成。
            #[cfg(windows)]
            {
                let available = crate::firewall::probe_netsh_available();
                *app_state.firewall_available.lock().unwrap() = available;
            }

            // D2 修复：后台周期性回收空闲路径锁，避免 path_locks 随运行时间无界增长。
            // G1 修复：套 spawn_supervised，panic 后自愈重启而非永久静默停止。
            {
                let gc_state = app_state.clone();
                spawn_supervised("path_locks/cwd_sessions GC", move || {
                    let gc_state = gc_state.clone();
                    Box::pin(async move {
                        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                        loop {
                            ticker.tick().await;
                            gc_state.gc_path_locks();
                            gc_state.gc_cwd_sessions();
                        }
                    })
                });
            }

            // Updater 插件容错注册：pubkey 已与签名私钥配对（见 tauri.conf.json 的 plugins.updater.pubkey）。
            // 更新源优先级：环境变量 CCBRIDGE_UPDATE_ENDPOINT（逗号分隔多 URL，按顺序故障转移）>
            // tauri.conf.json 的 plugins.updater.endpoints。端点解析在 commands.rs 的 build_updater() 统一处理。
            // 用 match 兜底，避免 dev 环境端点不可达或配置误改导致 updater 初始化失败时拖垮整个应用启动。
            match app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
            {
                Ok(_) => log::info!(
                    "Updater 插件已启用（更新源默认 tauri.conf.json 的 plugins.updater.endpoints，可用环境变量 CCBRIDGE_UPDATE_ENDPOINT 覆盖）"
                ),
                Err(e) => log::warn!("初始化 Updater 插件失败，已跳过：{e}"),
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
            let copy_ip_sed_item = MenuItem::with_id(
                app,
                "copy_ip_sed",
                "复制IP替换命令",
                true,
                None::<&str>,
            )?;
            let restart_item = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &copy_cmd_item, &copy_ip_sed_item, &restart_item, &quit_item],
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
                        // 直接在 Rust 端用 clipboard_manager 插件写入系统剪贴板，
                        // 不再依赖前端 webview。托盘点击时面板常处于隐藏/失焦状态，
                        // 旧的前端事件通道会因 navigator.clipboard 或插件 invoke 异常而失败。
                        let state = tray_state.clone();
                        let app_h = tray_app.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let (host, port, token, last_selected_ip, transport) = {
                                let cfg = state.config.read().await;
                                (
                                    cfg.host.clone(),
                                    cfg.port,
                                    cfg.token.clone(),
                                    cfg.last_selected_ip.clone(),
                                    cfg.transport.clone(),
                                )
                            };
                            let lan_ips = network::get_lan_ips();
                            let cmd = network::build_connect_command(
                                &host,
                                port,
                                &token,
                                &lan_ips,
                                last_selected_ip.as_deref(),
                                &transport,
                            );
                            match app_h.clipboard().write_text(cmd) {
                                Ok(_) => {
                                    let _ = app_h
                                        .notification()
                                        .builder()
                                        .title("cc-bridge")
                                        .body("连接命令已复制到剪贴板")
                                        .show();
                                }
                                Err(e) => {
                                    let _ = app_h
                                        .notification()
                                        .builder()
                                        .title("cc-bridge")
                                        .body(format!("复制失败，请手动复制：{e}"))
                                        .show();
                                }
                            }
                        });
                    }
                    "copy_ip_sed" => {
                        // 网络变动时在 Rust 端直接生成「原地替换 IP」的 sed 命令并写入剪贴板，
                        // 与连接页 IpChangedBanner 的 user 级 sed 等价；不依赖前端 webview 焦点。
                        // 托盘项跟随用户在连接页选择的作用域（config.scope / config.project_path），
                        // 与连接页 IpChangedBanner.buildSed 逐字等价（含 cd 前缀）；方案 A 已对齐，不再是固定用户级。
                        let state = tray_state.clone();
                        let app_h = tray_app.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let (host, port, last_selected_ip, scope, project_path) = {
                                let cfg = state.config.read().await;
                                (
                                    cfg.host.clone(),
                                    cfg.port,
                                    cfg.last_selected_ip.clone(),
                                    cfg.scope.clone(),
                                    cfg.project_path.clone(),
                                )
                            };
                            let lan_ips = network::get_lan_ips();
                            let display_host = network::resolve_display_host(
                                &host,
                                &lan_ips,
                                last_selected_ip.as_deref(),
                            );
                            let scope_str = scope.as_deref().unwrap_or("user");
                            let cmd =
                                network::build_ip_sed_command(port, &display_host, scope_str, &project_path);
                            let scope_label = if scope_str == "project" {
                                if project_path
                                    .as_ref()
                                    .map(|p| p.trim())
                                    .unwrap_or("")
                                    .is_empty()
                                {
                                    "项目级 .mcp.json（请在项目目录下执行）"
                                } else {
                                    "项目级 .mcp.json"
                                }
                            } else {
                                "用户级 ~/.claude.json"
                            };
                            match app_h.clipboard().write_text(cmd) {
                                Ok(_) => {
                                    let _ = app_h
                                        .notification()
                                        .builder()
                                        .title("cc-bridge")
                                        .body(format!(
                                            "IP 替换命令已复制到剪贴板（{scope_label}）"
                                        ))
                                        .show();
                                }
                                Err(e) => {
                                    let _ = app_h
                                        .notification()
                                        .builder()
                                        .title("cc-bridge")
                                        .body(format!("复制失败，请手动复制：{e}"))
                                        .show();
                                }
                            }
                        });
                    }
                    "restart" => {
                        let s = tray_state.clone();
                        tauri::async_runtime::spawn(async move {
                            mcp::http::restart_server(&s).await;
                        });
                    }
                    "quit" => {
                        tray_app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 托盘状态去重缓存：三处刷新点（初始/状态事件/地址变化循环）共享，
            // 仅在 (running, tooltip) 真正变化时才重设图标，消除网络抖动下的高频重绘闪烁。
            let last_tray =
                std::sync::Arc::new(std::sync::Mutex::new((false, String::new())));

            // 启动后即时按真实状态刷新一次托盘图标（上面初始读取可能早于 mcp 置位）
            if let Some(tray) = app.handle().tray_by_id("main-tray") {
                let running = app_state
                    .mcp_running
                    .load(std::sync::atomic::Ordering::Relaxed);
                let tip = if running {
                    "cc-bridge · 服务运行中"
                } else {
                    "cc-bridge · 已停止"
                };
                refresh_tray(&tray, running, tip, &last_tray);
            }

            // 监听前端/命令触发的状态变更事件，即时刷新托盘图标与 tooltip
            {
                let handle = app.handle().clone();
                let last_tray = last_tray.clone();
                app.listen("mcp-status-changed", move |_| {
                    let h = handle.clone();
                    let last_tray = last_tray.clone();
                    tauri::async_runtime::spawn(async move {
                        let running = h
                            .state::<std::sync::Arc<state::AppState>>()
                            .mcp_running
                            .load(std::sync::atomic::Ordering::Relaxed);
                        if let Some(tray) = h.tray_by_id("main-tray") {
                            let tip = if running {
                                "cc-bridge · 服务运行中"
                            } else {
                                "cc-bridge · 已停止"
                            };
                            refresh_tray(&tray, running, tip, &last_tray);
                        }
                    });
                });
            }

            // 本机地址变更检测（方案 C：轮询为主 + OS 事件加速）。
            // 之前用 tokio::select! 把「15s 兜底」与「OS 事件」合在一个 task，OS 事件高频时
            // 兜底分支长期抢不到执行，导致 DHCP 续租 / 同网卡换 IP 这类 OS 不通知的变化漏检、
            // 前端连接页 IP 不刷新。现拆成两个独立 task，彻底消除 select 竞争：
            //   - 轮询 task：每 5s 无条件刷新网卡缓存（保证缓存新鲜，根治漏检/饿死）。
            //   - 事件 task：OS 通知触发时做防抖合并 + 刷新缓存 + 更新托盘 tooltip / 弹通知。
            {
                let poll_state = app_state.clone();
                spawn_supervised("本机地址轮询刷新", move || {
                    let poll_state = poll_state.clone();
                    Box::pin(async move {
                        let mut poll = tokio::time::interval(std::time::Duration::from_secs(5));
                        loop {
                            poll.tick().await;
                            poll_state.refresh_lan_ips();
                        }
                    })
                });
            }
            {
                let handle = app.handle().clone();
                let watch_state = app_state.clone();
                let last_tray = last_tray.clone();
                // 事件驱动 IP 变化检测（Windows SIO_ADDRESS_LIST_CHANGE）。
                // spawn_ip_watch 在专用阻塞线程上等待 OS 通知，通过 channel 通知 async 端。
                spawn_supervised("本机地址变化事件", move || {
                    let handle = handle.clone();
                    let watch_state = watch_state.clone();
                    let last_tray = last_tray.clone();
                    // 每次 panic 自愈重启时重建 watcher（旧 socket 已随 drop 关闭）。
                    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                    let _watcher = crate::ip_watch::spawn(tx);
                    Box::pin(async move {
                        let mut alerting = false;
                        loop {
                            let _ = rx.recv().await;
                            // 防抖：收到首个通知后，在 600ms 窗口内合并后续连续的网络抖动
                            // （Wi-Fi 重连/VPN/DHCP 续租常一次变化伴随多条通知），只处理一次，
                            // 以最终状态为准，避免风暴式重扫网卡与托盘重绘。
                            while tokio::time::timeout(
                                std::time::Duration::from_millis(600),
                                rx.recv(),
                            )
                            .await
                            .is_ok()
                            {
                                // 窗口内仍有通知到达，继续吸收
                            }
                            // IP 变化通知到达：重扫网卡写回缓存，并据此判断 changed
                            // （刷新缓存与判断合一，避免二次网卡枚举）。
                            let ips = watch_state.refresh_lan_ips();
                            let last_ip = watch_state.config.read().await.last_selected_ip.clone();
                            let changed = match &last_ip {
                                Some(ip) => !ips.contains(ip),
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
                                // 去重刷新（图标随运行状态；地址变化仅改 tooltip）
                                refresh_tray(&tray, running, tip, &last_tray);
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
                    })
                });
            }

            // 后台命令定时清理：每 60s 扫一次，把超过配置的宽限期（默认 2 分钟）的已结束命令从
            // running_commands 注册表里移除（见 commands::cleanup_finished_commands）。
            {
                let cleanup_state = app_state.clone();
                // G1 修复：套 spawn_supervised，panic 后自愈重启而非永久静默停止。
                spawn_supervised("后台命令定时清理", move || {
                    let cleanup_state = cleanup_state.clone();
                    Box::pin(async move {
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                            cleanup_state.cleanup_finished_commands().await;
                        }
                    })
                });
            }

            // 防火墙状态定时刷新：初次立即检查一次（保证首屏拿到真实状态），之后每 5 分钟复查，
            // 覆盖「用户在应用运行中开关防火墙 / 增删规则」的场景。get_status 读的是缓存，
            // 不在此间隔内反复跑 netsh（守规则8 的轻量原则）。
            {
                let fw_state = app_state.clone();
                // G1 修复：套 spawn_supervised，panic 后自愈重启而非永久静默停止。
                spawn_supervised("防火墙缓存刷新", move || {
                    let fw_state = fw_state.clone();
                    Box::pin(async move {
                        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(300));
                        {
                            let port = fw_state.config.read().await.port;
                            crate::firewall::refresh_cache(&fw_state, port).await;
                        }
                        loop {
                            ticker.tick().await;
                            let port = fw_state.config.read().await.port;
                            crate::firewall::refresh_cache(&fw_state, port).await;
                        }
                    })
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
            commands::refresh_bash_detection,
            commands::set_selected_ip,
            commands::refresh_firewall,
            commands::open_firewall_port,
            commands::get_autostart,
            commands::set_autostart,
            commands::install_dir,
            commands::reveal_install_dir,
            commands::create_desktop_shortcut,
            commands::list_running_commands,
            commands::stop_running_command,
            commands::get_command_output,
            commands::start_update,
            commands::check_update,
            commands::export_config,
            commands::import_config,
            commands::restore_file,
            commands::get_file_diff,
            commands::diff_backups,
            commands::reveal_backup_dir,
            commands::list_backups,
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
