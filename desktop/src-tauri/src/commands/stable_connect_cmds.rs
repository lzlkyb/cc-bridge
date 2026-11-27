//! Local-only one-click configuration; no MCP registration or credential persistence.
use super::stable_connect_run;
use crate::config::BridgeConfig;
use crate::ssh_tunnel::{RuleState, TunnelState};
use crate::stable_connect::{self as stable, StableOperation, StableRecord, StableSaved};
use crate::stable_discovery::{ReplacedTarget, StableTarget};
use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StableSnapshot {
    method: String,
    selected_connection_id: Option<String>,
    connections: Vec<StableRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replaced: Option<ReplacedTarget>,
}

pub(super) fn changed(app: &AppHandle, id: Option<&str>) {
    let _ = app.emit(
        "stable_connect_changed",
        serde_json::json!({"connectionId":id}),
    );
}

fn saved_record(saved: &StableSaved, config: &BridgeConfig, state: &AppState) -> StableRecord {
    let mut record = StableRecord {
        connection_id: saved.connection_id.clone(),
        port: saved.port,
        scope: saved.scope.clone(),
        project_path: saved.project_path.clone(),
        multi_device: saved.multi_device,
        configured: true,
        enabled: saved.enabled,
        phase: "stopped".into(),
        step: 4,
        message: None,
        needs_secret: false,
        config_matches: saved.fingerprint == stable::fingerprint(config, &saved.connection_id),
        target: saved.target.clone(),
        verified_at: saved.verified_at,
    };
    if let Some(t) = state
        .ssh_tunnels
        .get(&stable::runtime_id(&saved.connection_id))
    {
        let t = t.status.lock().unwrap_or_else(|p| p.into_inner());
        record.needs_secret = t.needs_secret;
        record.message = t.message.clone();
        record.phase = match t.state {
            TunnelState::Connecting => "reconnecting",
            TunnelState::Reconnecting => "reconnecting",
            TunnelState::Error => "error",
            TunnelState::Stopped => "stopped",
            TunnelState::Up => {
                if t.rules.iter().any(|r| r.state == RuleState::Failed) {
                    record.message = Some(format!(
                        "固定端口 {} 暂时无法监听，正在按原 MCP 地址自动重试。若持续失败，请检查端口占用或服务器转发权限。",
                        saved.port
                    ));
                    "reconnecting"
                } else if t.rules.iter().all(|r| r.state == RuleState::Listening) {
                    "ready"
                } else {
                    "reconnecting"
                }
            }
        }
        .into();
    }
    record
}

pub fn stable_records(config: &BridgeConfig, state: &AppState) -> Vec<StableRecord> {
    let mut connections: Vec<_> = config
        .stable_connect
        .connections
        .iter()
        .map(|s| saved_record(s, config, state))
        .collect();
    for op in state.stable_operations.iter() {
        let record = op.record.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let active = op.active.load(Ordering::SeqCst);
        // An ended connection attempt cannot mask the live recovery of the unchanged saved endpoint.
        // Configuration/write errors (step 3+) and active progress still own their result.
        let obsolete_connection_error = !active
            && record.phase == "error"
            && record.step == 2
            && op.access.is_none()
            && state
                .ssh_tunnels
                .contains_key(&stable::runtime_id(&record.connection_id))
            && connections.iter().any(|saved| {
                saved.connection_id == record.connection_id
                    && saved.configured
                    && saved.enabled
                    && saved.config_matches
                    && saved.port == record.port
                    && saved.scope == record.scope
                    && saved.project_path == record.project_path
                    && saved.multi_device == record.multi_device
                    && saved.target.as_ref().map(|t| &t.id) == record.target.as_ref().map(|t| &t.id)
            });
        if !obsolete_connection_error && (active || record.phase == "error" || !record.configured) {
            if let Some(slot) = connections
                .iter_mut()
                .find(|r| r.connection_id == record.connection_id)
            {
                *slot = record;
            } else {
                connections.push(record);
            }
        }
    }
    connections
}

pub(super) async fn snapshot(state: &Arc<AppState>) -> StableSnapshot {
    let config = state.config.read().await;
    StableSnapshot {
        method: stable::method(&config),
        selected_connection_id: config.stable_connect.selected_connection_id.clone(),
        connections: stable_records(&config, state),
        replaced: None,
    }
}

#[tauri::command]
pub async fn stable_connect_get(state: State<'_, Arc<AppState>>) -> Result<StableSnapshot, String> {
    Ok(snapshot(state.inner()).await)
}

#[tauri::command]
pub async fn stable_connect_select(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    method: String,
    connection_id: Option<String>,
) -> Result<StableSnapshot, String> {
    if !["stable", "direct"].contains(&method.as_str()) {
        return Err("未知连接方式".into());
    }
    {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;
        if connection_id
            .as_ref()
            .is_some_and(|id| !config.ssh_connections.iter().any(|c| &c.id == id))
        {
            return Err("服务器不存在，请重新选择".into());
        }
        let mut next = config.stable_connect.clone();
        next.method = Some(method);
        next.selected_connection_id = connection_id;
        crate::config::save_config_field(
            &db,
            "stable_connect",
            &serde_json::to_value(&next).map_err(|e| e.to_string())?,
        )?;
        config.stable_connect = next;
    }
    changed(&app, None);
    Ok(snapshot(state.inner()).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields match the shared connection-card form.
pub async fn stable_connect_start(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    scope: String,
    project_path: String,
    multi_device: bool,
    password: Option<String>,
    passphrase: Option<String>,
    access: Option<crate::stable_discovery::StableAccessRequest>,
) -> Result<StableSnapshot, String> {
    stable::validate_setup(&scope, &project_path, multi_device)?;
    let start_guard = state.ssh_tunnel_start_lock.lock().await;
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return Err("请先启用 SSH 连接功能".into());
    }
    if !state.mcp_running.load(Ordering::SeqCst) {
        return Err("请先启动本机 MCP 服务".into());
    }
    if config.remote_tls_enabled {
        return Err("当前已启用 HTTPS。自动接入暂不支持配置服务器证书信任，请使用 IP 直连的现有 HTTPS 接入步骤。".into());
    }
    if config.transport != "http" {
        return Err(
            "隧道连接目前支持 HTTP 接入。请先将传输协议切换为 HTTP，或继续使用原有 SSE 接入方式。"
                .into(),
        );
    }
    if !config.ssh_connections.iter().any(|c| c.id == connection_id) {
        return Err("服务器不存在，请重新选择".into());
    }
    let saved = config
        .stable_connect
        .connections
        .iter()
        .find(|s| s.connection_id == connection_id);
    if let Some(access) = &access {
        crate::stable_discovery::validate_access(
            &config,
            &connection_id,
            &scope,
            &project_path,
            access,
        )?;
    } else if saved.is_none_or(|saved| {
        saved.fingerprint != stable::fingerprint(&config, &connection_id)
            || saved.scope != scope
            || saved.project_path != project_path.trim()
            || saved.multi_device != multi_device
    }) {
        return Err("请先检查服务器上的原有接入，再继续配置。".into());
    }
    let link = super::ssh_cmds::SshLink::from_config(&config, &connection_id)?;
    // 规划与真正建隧道必须用同一个端口：用户主动接入时以服务器分配的号为准备，
    // 后台恢复沿用已确认的号，否则 takeover 检查会对着一个不会被监听的端口做判断。
    // 服务器分配不出端口时返回 0，按「没分配」处理，与 candidate_ports 的过滤保持一致。
    let allocated = access
        .as_ref()
        .and_then(|request| request.tunnel_port)
        .filter(|port| *port >= 1024);
    let planned_port = allocated.unwrap_or_else(|| saved.map_or(config.port, |s| s.port));
    super::forward_takeover::plan_owned(
        state.inner(),
        &config,
        &link,
        &[stable::rule(planned_port, &config)],
    )?;
    let op = Arc::new(StableOperation {
        cancel: Arc::new(AtomicBool::new(false)),
        active: AtomicBool::new(true),
        record: Mutex::new(StableRecord {
            connection_id: connection_id.clone(),
            port: planned_port,
            scope: scope.clone(),
            project_path: project_path.trim().into(),
            multi_device,
            configured: saved.is_some(),
            enabled: saved.is_some_and(|s| s.enabled),
            phase: "running".into(),
            step: 0,
            message: None,
            needs_secret: false,
            config_matches: false,
            target: if let Some(access) = &access {
                access.target.clone()
            } else {
                saved.and_then(|s| s.target.clone())
            },
            verified_at: saved.and_then(|s| s.verified_at),
        }),
        access,
    });
    // One in-flight writer per server, including the interval while cancellation is being acknowledged.
    match state.stable_operations.entry(connection_id.clone()) {
        dashmap::mapref::entry::Entry::Occupied(mut e) => {
            if e.get().active.load(Ordering::SeqCst) {
                return Err("正在处理这台服务器，请等待当前操作结束".into());
            }
            e.insert(op.clone());
        }
        dashmap::mapref::entry::Entry::Vacant(e) => {
            e.insert(op.clone());
        }
    }
    drop(start_guard);
    changed(&app, Some(&connection_id));
    let outcome = stable_connect_run::configure(
        &app,
        state.inner(),
        &config,
        &op,
        (password, passphrase),
        true,
    )
    .await;
    let replaced = match outcome {
        Ok(replaced) => replaced,
        Err(error) => {
            let mut record = op.record.lock().unwrap_or_else(|p| p.into_inner());
            if op.cancel.load(Ordering::SeqCst) {
                record.phase = "stopped".into();
                let detail = stable::friendly_error(&error, &config.token);
                record.message = Some(if record.step >= 3 {
                    format!("{detail}。请重新检查服务器上的接入配置。")
                } else {
                    detail
                });
            } else {
                record.phase = "error".into();
                record.needs_secret |= error.contains("Permission denied")
                    || error.contains("需要密码")
                    || error.contains("CCB_AUTH_REQUIRED");
                record.message = Some(stable::friendly_error(&error, &config.token));
            }
            None
        }
    };
    op.active.store(false, Ordering::SeqCst);
    changed(&app, Some(&connection_id));
    let mut result = snapshot(state.inner()).await;
    result.replaced = replaced;
    Ok(result)
}

#[tauri::command]
pub fn stable_connect_cancel(state: State<'_, Arc<AppState>>, connection_id: String) {
    if let Some(op) = state.stable_operations.get(&connection_id) {
        op.cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn stable_connect_stop(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
) -> Result<StableSnapshot, String> {
    let _start_guard = state.ssh_tunnel_start_lock.lock().await;
    if state
        .stable_operations
        .get(&connection_id)
        .is_some_and(|op| op.active.load(Ordering::SeqCst))
    {
        return Err("正在配置接入，请先取消本次操作。".into());
    }
    // 用户主动断开：远端监听会随会话关闭释放，恢复凭据一并清掉，
    // 免得下次连接白等一次回收 SSH。
    super::ssh_tunnel_cmds::stop_and_release(state.inner(), &stable::runtime_id(&connection_id))
        .await;
    {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;
        let mut next = config.stable_connect.clone();
        if let Some(saved) = next
            .connections
            .iter_mut()
            .find(|s| s.connection_id == connection_id)
        {
            saved.enabled = false;
        }
        crate::config::save_config_field(
            &db,
            "stable_connect",
            &serde_json::to_value(&next).map_err(|e| e.to_string())?,
        )?;
        config.stable_connect = next;
    }
    if let Some(op) = state.stable_operations.get(&connection_id) {
        let mut r = op.record.lock().unwrap_or_else(|p| p.into_inner());
        r.phase = "stopped".into();
        r.enabled = false;
        r.message = None;
    }
    changed(&app, Some(&connection_id));
    Ok(snapshot(state.inner()).await)
}

/// Check the exact failed instance. A new tunnel can reuse the same runtime ID.
fn port_conflict_is_current(
    state: &AppState,
    runtime_id: &str,
    failed_stop: &Arc<AtomicBool>,
) -> bool {
    state.ssh_tunnels.get(runtime_id).is_some_and(|tunnel| {
        Arc::ptr_eq(&tunnel.stop, failed_stop)
            && !tunnel.stop.load(Ordering::SeqCst)
            && crate::ssh_tunnel::port_taken(
                &tunnel.status.lock().unwrap_or_else(|p| p.into_inner()),
            )
    })
}

/// 重新读一次服务器上的接入，拼出 `configure` 需要的 access 载荷。
///
/// 只挑本机在原范围里的条目。优先使用已保存的条目，找不到时由配置脚本尝试新建。
async fn own_access(
    state: &Arc<AppState>,
    saved: &StableSaved,
    config: &BridgeConfig,
) -> Result<crate::stable_discovery::StableAccessRequest, String> {
    let path = (saved.scope == "project").then_some(saved.project_path.as_str());
    let (output, signature) = super::stable_discovery_cmds::read_remote(
        state,
        &saved.connection_id,
        (path, None),
        false,
        None,
        None,
        None,
        Some(true),
    )
    .await?;
    let result: crate::stable_discovery::StableDiscovery =
        crate::stable_discovery::parse_result(&output, "CCB_DISCOVERED")?;
    if result.signature != signature || !result.complete {
        return Err("服务器检查没有返回完整结果".into());
    }
    let own_name = format!("cc-bridge-{}", config.device_id);
    let target = result
        .targets
        .iter()
        .find(|t| {
            adopts_entry(saved, &own_name, t)
                && saved.target.as_ref().is_some_and(|old| old.id == t.id)
        })
        .or_else(|| {
            result
                .targets
                .iter()
                .find(|t| adopts_entry(saved, &own_name, t))
        })
        .cloned();
    Ok(crate::stable_discovery::StableAccessRequest {
        target,
        inspection: crate::stable_discovery::StableInspection {
            signature: result.signature.clone(),
            complete: result.complete,
            files: result.files.clone(),
        },
        scope_change: false,
        tunnel_port: result.tunnel_port,
    })
}

/// Only the supervisor of the failed instance may hand off a port repair.
pub(super) async fn recover_multi_port(
    app: &AppHandle,
    state: &Arc<AppState>,
    connection_id: &str,
    failed_stop: Arc<AtomicBool>,
) {
    let id = stable::runtime_id(connection_id);
    if !port_conflict_is_current(state, &id, &failed_stop) {
        return;
    }
    if state
        .stable_operations
        .get(connection_id)
        .is_some_and(|op| op.active.load(Ordering::SeqCst))
    {
        decline(app, state, &id, &failed_stop);
        return;
    }
    let saved = {
        let config = state.config.read().await;
        config
            .stable_connect
            .connections
            .iter()
            .find(|saved| {
                saved.connection_id == connection_id && saved.enabled && saved.multi_device
            })
            .cloned()
    };
    if let Some(saved) = saved {
        heal_multi_port(app, state, &saved, &failed_stop).await;
    } else {
        decline(app, state, &id, &failed_stop);
    }
}

/// 这条服务器条目算不算「本机那一份、而且范围对得上」。
///
/// 🔴 自愈会拿认到的条目名去写服务器（`configure.py` 里 `name = selected['name']`），
/// 所以这里认错不是「多显示一条」，而是替别人改配置。两个条件缺一不可：
///   · 范围与保存的连接一致（用户级只认全局条目；项目级认项目条目与旧版本地条目）；
///   · 名字是本机尾号，或令牌匹配且沿用旧固定名或用户已保存的自定义条目。
/// 另一台电脑的 `cc-bridge-<别家尾号>` 一律不认。
fn adopts_entry(saved: &StableSaved, own_name: &str, target: &StableTarget) -> bool {
    let owned = target.name == own_name
        || (target.token_matches
            && !target.name.starts_with("cc-bridge-")
            && (target.name == "cc-bridge"
                || saved
                    .target
                    .as_ref()
                    .is_some_and(|entry| entry.id == target.id)));
    // 路径比较要容忍尾斜杠：`/work` 与 `/work/` 是同一个项目。认不出来会退成「没有
    // target」，而 `configure.py` 在「同名条目已存在又没有 target」时直接
    // `CCB_TARGET_REQUIRED` —— 自愈就白跑一趟，还给不出人话。
    let same_path =
        target.project_path.trim_end_matches('/') == saved.project_path.trim_end_matches('/');
    let scope_ok = if saved.scope == "user" {
        target.scope == "user" && target.project_path.is_empty()
    } else {
        matches!(target.scope.as_str(), "project" | "local") && same_path
    };
    scope_ok && owned
}

/// 自愈没接手时，把提示改成「下一步该干什么」。
///
/// 监管线程在触发自愈前已经写了「正在自动换号重接」：如果自愈因为用户刚断开、正在配置、
/// 或者读不到服务器这几条路退出，那句提示就成了一句永远不发生的承诺。只改还停在错误态的
/// 隧道——用户主动停掉的那条不该被我们改回错误。
fn announce(
    app: &AppHandle,
    state: &Arc<AppState>,
    runtime_id: &str,
    failed_stop: &Arc<AtomicBool>,
    message: &str,
) {
    let Some(tunnel) = state.ssh_tunnels.get(runtime_id) else {
        return;
    };
    if !Arc::ptr_eq(&tunnel.stop, failed_stop) || failed_stop.load(Ordering::SeqCst) {
        return;
    }
    super::ssh_tunnel_cmds::publish(app, &tunnel.stop, &tunnel.status, |s| {
        if s.state != TunnelState::Error {
            return false;
        }
        s.message = Some(message.into());
        true
    });
}

/// 自愈「不接手」时给出可操作的提示。
fn decline(
    app: &AppHandle,
    state: &Arc<AppState>,
    runtime_id: &str,
    failed_stop: &Arc<AtomicBool>,
) {
    announce(
        app,
        state,
        runtime_id,
        failed_stop,
        "服务器无法监听原隧道端口。请在接入页点「重新接入」。",
    );
}

/// 多设备连接端口被占后的自愈：走一次「重新接入」，只换本机自己的号与条目。
///
/// 🔴 只在 `multi_device` 为真的连接上调用。单设备连接的账本本来就是本机独享，
/// 撞号只可能是别人手工占了端口，那种情况下让用户点「重新接入」更诚实；
/// 而同一个 SSH 账号的两台电脑共用端口命名空间，另一台丢账本后占号是**常态**，
/// 每次都要人去点一下就等于这个功能没做完。
async fn heal_multi_port(
    app: &AppHandle,
    state: &Arc<AppState>,
    saved: &StableSaved,
    failed_stop: &Arc<AtomicBool>,
) {
    let id = stable::runtime_id(&saved.connection_id);
    let config = state.config.read().await.clone();
    // 与服务端接入同款前置条件：用户已经切到 HTTPS / SSE、关了 SSH、或本机 MCP 没在跑时，
    // 后台跑去改服务器条目只会留下一条连不上的配置——那种情况交给用户自己发起「重新接入」。
    if !config.ssh_enabled
        || config.remote_tls_enabled
        || config.transport != "http"
        || !state.mcp_running.load(Ordering::SeqCst)
        || stable::fingerprint(&config, &saved.connection_id) != saved.fingerprint
    {
        return decline(app, state, &id, failed_stop);
    }
    let access = match own_access(state, saved, &config).await {
        Ok(access) => access,
        Err(error) => {
            log::warn!("多设备端口自愈：重新读取接入失败：{error}");
            return decline(app, state, &id, failed_stop);
        }
    };
    let project_path = access.target.as_ref().map_or_else(
        || {
            let trimmed = saved.project_path.trim_end_matches('/');
            if trimmed.is_empty() {
                saved.project_path.as_str()
            } else {
                trimmed
            }
        },
        |target| target.project_path.as_str(),
    );
    if let Err(error) = crate::stable_discovery::validate_access(
        &config,
        &saved.connection_id,
        &saved.scope,
        project_path,
        &access,
    ) {
        log::warn!("多设备端口自愈：检查结果不可用：{error}");
        return decline(app, state, &id, failed_stop);
    }
    let start_guard = state.ssh_tunnel_start_lock.lock().await;
    // The server scan runs without the start lock. A user could have stopped or
    // reconfigured this connection, or replaced the failed tunnel, during that scan.
    let current = state.config.read().await;
    let same_config = current.ssh_enabled
        && !current.remote_tls_enabled
        && current.transport == "http"
        && state.mcp_running.load(Ordering::SeqCst)
        && stable::fingerprint(&current, &saved.connection_id) == saved.fingerprint
        && current.stable_connect.connections.iter().any(|entry| {
            entry.enabled && entry.multi_device && stable::same_saved_endpoint(entry, saved)
        });
    drop(current);
    if !same_config || !port_conflict_is_current(state, &id, failed_stop) {
        drop(start_guard);
        return decline(app, state, &id, failed_stop);
    }
    let op = Arc::new(StableOperation {
        cancel: Arc::new(AtomicBool::new(false)),
        active: AtomicBool::new(true),
        record: Mutex::new(StableRecord {
            connection_id: saved.connection_id.clone(),
            port: saved.port,
            scope: saved.scope.clone(),
            project_path: project_path.to_string(),
            multi_device: true,
            configured: true,
            enabled: true,
            phase: "running".into(),
            step: 0,
            message: None,
            needs_secret: false,
            config_matches: false,
            target: access.target.clone().or_else(|| saved.target.clone()),
            verified_at: saved.verified_at,
        }),
        access: Some(access),
    });
    match state.stable_operations.entry(saved.connection_id.clone()) {
        dashmap::mapref::entry::Entry::Occupied(mut entry) => {
            if entry.get().active.load(Ordering::SeqCst) {
                drop(start_guard);
                return decline(app, state, &id, failed_stop);
            }
            entry.insert(op.clone());
        }
        dashmap::mapref::entry::Entry::Vacant(entry) => {
            entry.insert(op.clone());
        }
    }
    drop(start_guard);
    changed(app, Some(&saved.connection_id));
    log::info!(
        "多设备隧道端口被占用，正在换号重接：{}",
        saved.connection_id
    );
    let outcome =
        stable_connect_run::configure(app, state, &config, &op, (None, None), false).await;
    match outcome {
        Ok(_) => {
            // 换号成功意味着这台的地址变了：条目已由 configure 改写，但用户可能把地址
            // 复制到别处（另一个客户端、自己的脚本）。不说明白，下次它会连到一个死端口。
            let port = op.record.lock().unwrap_or_else(|p| p.into_inner()).port;
            if port != saved.port {
                if let Some(tunnel) = state.ssh_tunnels.get(&id) {
                    super::ssh_tunnel_cmds::publish(app, &tunnel.stop, &tunnel.status, |status| {
                        if status.state != TunnelState::Up
                            || !status.rules.iter().any(|rule| {
                                rule.rule.listen_port == port && rule.state == RuleState::Listening
                            })
                        {
                            return false;
                        }
                        status.message = Some(format!(
                            "已自动换到端口 {port} 并重新接入。若在别处保存过这台的地址，请重新复制。"
                        ));
                        true
                    });
                }
            }
        }
        Err(error) => {
            let friendly = stable::friendly_error(&error, &config.token);
            // 隧道那条提示还停在「正在自动换号重接」：失败后必须换成真正的原因，
            // 否则用户等的是一个已经结束的流程。
            announce(app, state, &id, failed_stop, &friendly);
            let mut record = op.record.lock().unwrap_or_else(|p| p.into_inner());
            record.phase = if op.cancel.load(Ordering::SeqCst) {
                "stopped"
            } else {
                "error"
            }
            .into();
            record.message = Some(friendly);
        }
    }
    op.active.store(false, Ordering::SeqCst);
    changed(app, Some(&saved.connection_id));
}

pub async fn autostart_stable_connections(app: AppHandle, state: Arc<AppState>) {
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return;
    }
    for saved in config
        .stable_connect
        .connections
        .iter()
        .filter(|s| s.enabled)
    {
        if saved.fingerprint != stable::fingerprint(&config, &saved.connection_id) {
            continue;
        }
        let Ok(link) = super::ssh_cmds::SshLink::from_config(&config, &saved.connection_id) else {
            continue;
        };
        let mut takeover = super::forward_takeover::Takeover::default();
        if let Err(e) = super::ssh_tunnel_cmds::start_owned_tunnel(
            app.clone(),
            state.clone(),
            link,
            vec![stable::rule(saved.port, &config)],
            (None, None),
            &mut takeover,
            false,
        )
        .await
        {
            if let Err(error) = takeover.restore(&app, &state).await {
                log::warn!(
                    "恢复原有转发失败：{}",
                    stable::friendly_error(&error, &config.token)
                );
            }
            log::warn!(
                "隧道连接自动恢复失败：{}",
                stable::friendly_error(&e, &config.token)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(scope: &str, project_path: &str) -> StableSaved {
        StableSaved {
            connection_id: "c1".into(),
            port: 17900,
            scope: scope.into(),
            project_path: project_path.into(),
            multi_device: true,
            enabled: true,
            fingerprint: "f".into(),
            token_fingerprint: String::new(),
            target: None,
            verified_at: None,
        }
    }

    fn target(name: &str, scope: &str, project_path: &str, token_matches: bool) -> StableTarget {
        StableTarget {
            id: format!("id-{name}"),
            name: name.into(),
            scope: scope.into(),
            project_path: project_path.into(),
            project_key: None,
            config_file: "/home/u/.claude.json".into(),
            url: "http://127.0.0.1:17900/mcp".into(),
            fingerprint: "0".repeat(64),
            recognized: true,
            token_matches,
        }
    }

    /// 自愈只认「本机那一份、范围也对得上」的条目：认错就会拿别人的名字去写服务器
    /// （`configure.py` 写的是 `selected['name']`），等于替另一台电脑改配置。
    #[test]
    fn heal_only_adopts_its_own_entry_in_the_saved_scope() {
        let user = saved("user", "");
        let own = "cc-bridge-aaaa";
        assert!(adopts_entry(&user, own, &target(own, "user", "", true)));
        // 令牌轮换之后本机条目会失配，但名字仍是本机尾号：照样认，否则自愈永远修不回来。
        assert!(adopts_entry(&user, own, &target(own, "user", "", false)));
        // 另一台电脑的条目：名字不是本机尾号。
        assert!(!adopts_entry(
            &user,
            own,
            &target("cc-bridge-bbbb", "user", "", true)
        ));
        // 老固定名：令牌是本机才算自己（老用户原地升级），令牌不符就是别人的。
        assert!(adopts_entry(
            &user,
            own,
            &target("cc-bridge", "user", "", true)
        ));
        assert!(!adopts_entry(
            &user,
            own,
            &target("cc-bridge", "user", "", false)
        ));
        // 范围不符不认：全局连接不该去改项目条目。
        assert!(!adopts_entry(
            &user,
            own,
            &target(own, "project", "/work", true)
        ));

        let project = saved("project", "/work");
        assert!(adopts_entry(
            &project,
            own,
            &target(own, "project", "/work", true)
        ));
        // 旧版把项目条目存在 projects[<key>] 里，scope 是 local，仍算项目级。
        assert!(adopts_entry(
            &project,
            own,
            &target(own, "local", "/work", true)
        ));
        assert!(!adopts_entry(
            &project,
            own,
            &target(own, "project", "/other", true)
        ));
        assert!(!adopts_entry(&project, own, &target(own, "user", "", true)));
        // 尾斜杠只是写法差异，仍算同一个项目；认不出来会退化成「没有 target」，
        // 而 configure.py 那时会直接报 CCB_TARGET_REQUIRED。
        assert!(adopts_entry(
            &saved("project", "/work/"),
            own,
            &target(own, "project", "/work", true)
        ));
    }

    #[test]
    fn heal_keeps_a_saved_custom_entry_with_the_local_token() {
        let own_name = "cc-bridge-aaaa";
        let mut saved = saved("user", "");
        let mut custom = target("custom-name", "user", "", true);
        assert!(!adopts_entry(&saved, own_name, &custom));
        saved.target = Some(custom.clone());
        assert!(adopts_entry(&saved, own_name, &custom));
        custom.token_matches = false;
        assert!(!adopts_entry(&saved, own_name, &custom));
        let foreign = target("cc-bridge-bbbb", "user", "", true);
        saved.target = Some(foreign.clone());
        assert!(!adopts_entry(&saved, own_name, &foreign));
    }
}
