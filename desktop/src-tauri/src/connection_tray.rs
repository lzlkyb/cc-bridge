//! Native shortcuts use the same access facts and copy resolver as the webview.
use crate::{commands, connection_access as access, state::AppState};
use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter,
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
    let menu = Menu::new(app)?;
    let add = |id: &str, title: &str, enabled: bool| -> tauri::Result<()> {
        menu.append(&MenuItem::with_id(app, id, title, enabled, None::<&str>)?)
    };
    add("show", "打开面板", true)?;
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
    let key = format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{:?}",
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
