//! Native shortcuts use the same access facts and copy resolver as the webview.
use crate::{commands, connection_access as access, state::AppState};
use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub async fn current_access(state: &AppState) -> access::ConnectionAccess {
    let config = state.config.read().await;
    let ips = state.cached_lan_ips();
    let error = state
        .startup_error
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    access::summary(
        &config,
        &commands::stable_records(&config, state),
        &ips,
        state.mcp_running.load(Ordering::Relaxed),
        access::cached_local_probe(state, &config, &ips),
        error.as_deref(),
        access::firewall_blocked(state),
    )
}

pub fn menu(
    app: &AppHandle,
    current: Option<&access::ConnectionAccess>,
    service: &commands::ServiceControl,
    running: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    // 强制更新期间只留「打开面板 / 退出」：复制接入命令、启停服务都是绕过主窗口锁的能力，
    // 而「打开面板」仍然看到同一层强制遮罩，不构成绕过。
    let force_update = app
        .try_state::<std::sync::Arc<AppState>>()
        .map(|state| state.force_update_active.load(Ordering::SeqCst))
        .unwrap_or(false);
    if force_update {
        let menu = Menu::new(app)?;
        menu.append(&MenuItem::with_id(
            app,
            "show",
            "打开面板（需先更新）",
            true,
            None::<&str>,
        )?)?;
        // 「重新加载界面」必须留：它不绕过遮罩（重载后 ForceUpdateGate 会重新盖上），
        // 但界面若白屏，用户连更新按钮都点不到——去掉这一项等于把人锁死在白屏上。
        menu.append(&MenuItem::with_id(
            app,
            "reload_ui",
            "重新加载界面",
            true,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?)?;
        return Ok(menu);
    }

    let menu = Menu::new(app)?;
    let add = |id: &str, title: &str, enabled: bool| -> tauri::Result<()> {
        menu.append(&MenuItem::with_id(app, id, title, enabled, None::<&str>)?)
    };
    add("show", "打开面板", true)?;
    // 白屏时不必「退出再打开」：重建 webview 就够，后端（PTY / MCP / 隧道）全程不动。
    // 放在第二项——它是应急入口，不该埋在菜单底部找不着。
    add("reload_ui", "重新加载界面", true)?;
    add("storage_maintenance", "存储与维护", true)?;
    if let Some(current) = current {
        add(
            "access_summary",
            &format!(
                "{} · {} · {}",
                if current.method == "stable" {
                    "隧道连接"
                } else {
                    "IP 直连"
                },
                current.server_name,
                current.short
            ),
            false,
        )?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        add(
            "copy_address",
            if current.method == "stable" {
                "复制服务器固定接入地址"
            } else {
                "复制直连接入地址"
            },
            current.can_copy_address,
        )?;
        if current.can_copy_command {
            add("copy_cmd", "复制当前连接命令", true)?;
        } else {
            add(
                "configure_access",
                if current.configured {
                    "检查并应用原接入配置…"
                } else {
                    "一键接入隧道连接…"
                },
                true,
            )?;
        }
        add("check_access", "查看与检查当前接入…", true)?;
        if current.can_update_ip {
            add("copy_ip_sed", "复制 IP 替换命令", true)?;
        }
        if current.method == "direct" && current.token_update_pending {
            add("copy_token_update", "复制原接入 Token 更新命令", true)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let busy = service.pending.is_some();
    add(
        if running {
            "stop_service"
        } else {
            "start_service"
        },
        if busy {
            "本机服务处理中…"
        } else if running {
            "停止本机服务"
        } else {
            "启动本机服务"
        },
        !busy,
    )?;
    add("restart", "重启本机服务", !busy && running)?;
    add("quit", "退出", true)?;
    Ok(menu)
}

/// A changed target/phase changes the menu; repeating the same five-second sample does not.
pub fn refresh_menu(
    app: &AppHandle,
    state: &AppState,
    current: &access::ConnectionAccess,
    running: bool,
) {
    let service = state
        .service_control
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    // 强制标志必须进 key：它是静默变化的（前端判定后置位），不进 key 的话菜单会一直
    // 停在上一个形态，直到连接状态恰好发生变化才刷新。
    let force_update = state.force_update_active.load(Ordering::SeqCst);
    let key = format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}:{:?}",
        force_update,
        current.target_key,
        current.server_name,
        current.state,
        current.short,
        current.can_copy_address,
        current.can_copy_command,
        current.can_update_ip,
        current.token_update_pending,
        service.pending
    );
    let mut previous = state
        .tray_access_key
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if *previous == key {
        return;
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        match menu(app, Some(current), &service, running).and_then(|menu| tray.set_menu(Some(menu)))
        {
            Ok(()) => *previous = key,
            Err(error) => log::warn!("更新托盘接入菜单失败：{error}"),
        }
    }
}

pub fn request_navigation(state: &AppState, app: &AppHandle) {
    state
        .pending_connection_navigation
        .store(true, Ordering::SeqCst);
    let _ = app.emit("connection-access-navigation", ());
}

pub async fn copy(state: &AppState, app: &AppHandle, kind: &str) -> Result<(), String> {
    let result = commands::resolve_connection_copy(state, kind).await?;
    if result.text.is_empty() {
        return Err("当前接入没有可复制内容，请查看接入卡片。".into());
    }
    {
        // Keep the target stable during the native, synchronous clipboard write.
        let config = state.config.read().await;
        let ips = state.cached_lan_ips();
        let current = access::summary(
            &config,
            &commands::stable_records(&config, state),
            &ips,
            state.mcp_running.load(Ordering::Relaxed),
            access::cached_local_probe(state, &config, &ips),
            None,
            access::firewall_blocked(state),
        );
        if current.target_key != result.target_key
            || (kind == "command" && !current.can_copy_command)
        {
            return Err("接入目标已变化，请重新复制当前配置。".into());
        }
        app.clipboard()
            .write_text(&result.text)
            .map_err(|error| format!("复制失败：{error}"))?;
    }
    if kind == "command" {
        commands::record_connection_copy(state, app, &result.target_key).await?;
    } else if matches!(kind, "ip-update" | "token-update") {
        commands::record_direct_update(state, &result.target_key, false).await?;
    }
    Ok(())
}
