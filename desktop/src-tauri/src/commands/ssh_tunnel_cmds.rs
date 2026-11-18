//! 端口转发（`ssh -L / -R / -D`）：每条连接一个常驻 SSH 进程。
//! Claude Code 托管隧道在同一条连接内运行心跳与失联回收程序。
//!
//! 跑在 PTY 里是为了复用终端那套凭据自动填充（密码 / 口令 / 跳板机两段登录）。
//! 状态从 `-v` 输出解析（`crate::ssh_tunnel`），经 `ssh_tunnel_status` 事件推给前端。
//! 进程意外退出按指数退避重连；认证失败一类重试无意义的失败直接停住。
//!
//! 🔴 与终端同一安全边界：只经 Tauri IPC 暴露，不注册 MCP 工具；受 `ssh_enabled` 总开关约束。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use portable_pty::ChildKiller;
use tauri::{AppHandle, Emitter, State};

use super::ssh_cmds::{
    find_ssh, load_link_parts, passphrase_prompt_in, password_prompt_in, prompt_tail,
    resolve_connect_secrets, ssh_base_args, strip_ansi, SshLink, CREDENTIAL_FILL_WINDOW,
};
use super::ssh_tunnel_process::{self as process, GuardRun, Output};
use crate::config::{ForwardAuto, ForwardKind, ForwardRule};
use crate::ssh_proxy::PendingCreds;
use crate::ssh_tunnel::{forward_args, is_fatal, TunnelState, TunnelStatus};
use crate::ssh_tunnel_guard::{reclaim_command, ManagedGuard, ReclaimResult};
use crate::state::{AppState, SshTunnel, SshTunnelRestart};
use crate::tunnel_traffic::{ByteDelta, Relay};

const STATUS_EVENT: &str = "ssh_tunnel_status";
const RETRY_MIN: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(60);

pub(super) type Killer = Box<dyn ChildKiller + Send + Sync>;
type SharedStatus = Arc<StdMutex<TunnelStatus>>;

/// 一条转发重连时不变的部分。
struct Plan {
    id: String,
    link: SshLink,
    ssh: PathBuf,
    rules: Vec<ForwardRule>,
    data_dir: PathBuf,
    /// 启动时临时输入的密码 / 口令：要留到停止为止，否则断线后没法自动重连。
    /// 包 Mutex 是为了监管线程退出时能 `take` 清零（明文不过夜）。
    password: StdMutex<Option<String>>,
    passphrase: StdMutex<Option<String>>,
    guard: Option<Arc<ManagedGuard>>,
    state: Weak<AppState>,
}

/// 开启（或按最新配置重启）一条连接的端口转发。
#[tauri::command]
pub async fn ssh_tunnel_start(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<TunnelStatus, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用，请先在设置中开启".into());
    }
    match start_tunnel(
        app,
        state.inner().clone(),
        connection_id.clone(),
        password,
        passphrase,
    )
    .await
    {
        Ok(st) => {
            audit_tunnel(&state, "ssh_tunnel_start", &connection_id, st.state, None).await;
            Ok(st)
        }
        // 失败也要记：用户看到的是「点了没反应」，日志里得留下到底哪一步不认。
        Err(e) => {
            audit_tunnel(
                &state,
                "ssh_tunnel_start",
                &connection_id,
                TunnelState::Error,
                Some(e.clone()),
            )
            .await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
) -> Result<(), String> {
    let _start_guard = state.ssh_tunnel_start_lock.lock().await;
    // 只有真停到了才记审计：对不存在的连接也记「停止」，日志里会出现没有对应
    // 「开始」的无主记录，把真正要看的成对事件埋掉。
    if stop_and_release(state.inner(), &connection_id).await {
        audit_tunnel(
            &state,
            "ssh_tunnel_stop",
            &connection_id,
            TunnelState::Stopped,
            None,
        )
        .await;
    }
    let _ = app.emit(STATUS_EVENT, TunnelStatus::stopped(connection_id));
    Ok(())
}

/// 端口转发的审计。
///
/// 与终端、`ssh_reveal_credential` 那条「本机操作不进审计」的边界不同：转发是一条
/// **长期驻留的网络通道**，事后必须能回答「什么时候开的、从哪到哪、谁关的」。
///
/// 只记**用户主动**的启停（命令层）：autostart 与 stable_connect 的拉起会随监管
/// 线程的退避重连反复发生，逐次记会在日志里刷屏、把真正要看的东西埋掉。
/// 因此 `start` / `stop` **不保证成对**——读日志时按事件看，不要按会话配对。
///
/// `state` 一并记进参数：命令返回时只是「监管线程已接管」，此时通常还是 `connecting`，
/// 记录里带上真实状态，才不会读成「已经连上了」。关闭审计开关时不写。
async fn audit_tunnel(
    state: &Arc<AppState>,
    tool: &str,
    connection_id: &str,
    tunnel_state: TunnelState,
    err: Option<String>,
) {
    let (enabled, name, rules) = {
        let config = state.config.read().await;
        let found = config
            .ssh_connections
            .iter()
            .find(|c| c.id == connection_id);
        (
            config.audit_enabled,
            found.map(|c| c.name.clone()).unwrap_or_default(),
            found
                .map(|c| {
                    c.forwards
                        .iter()
                        .filter(|r| r.enabled)
                        .map(describe_rule)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        )
    };
    if !enabled {
        return;
    }
    let params = serde_json::json!({
        "connectionId": connection_id,
        "name": name,
        "rules": rules,
        "state": tunnel_state_label(tunnel_state),
    })
    .to_string();
    let entry = crate::audit::new_entry(
        tool,
        &params,
        err.is_none(),
        err,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    let _ = crate::audit::write_audit_log(&state.data_dir, &entry);
}

/// 与前端 `TunnelState` 的序列化名同口径（`serde(rename_all = "lowercase")`）。
fn tunnel_state_label(s: TunnelState) -> &'static str {
    match s {
        TunnelState::Connecting => "connecting",
        TunnelState::Up => "up",
        TunnelState::Reconnecting => "reconnecting",
        TunnelState::Error => "error",
        TunnelState::Stopped => "stopped",
    }
}

/// 规则的一行人话，与抽屉里显示的形态一致：`本机 127.0.0.1:15432 → 10.0.3.7:5432`。
fn describe_rule(r: &ForwardRule) -> String {
    let listen = format!("{}:{}", r.listen_host, r.listen_port);
    match r.kind {
        ForwardKind::Local => format!("本机 {listen} → {}:{}", r.target_host, r.target_port),
        ForwardKind::Remote => format!("远端 {listen} → {}:{}", r.target_host, r.target_port),
        ForwardKind::Dynamic => format!("本机 {listen} → SOCKS5"),
    }
}

/// 前端首次进入终端工作区时拉一次全量，之后靠事件增量更新。
#[tauri::command]
pub async fn ssh_tunnel_list(state: State<'_, Arc<AppState>>) -> Result<Vec<TunnelStatus>, String> {
    Ok(state
        .ssh_tunnels
        .iter()
        .map(|e| e.status.lock().unwrap_or_else(|p| p.into_inner()).clone())
        .collect())
}

/// 应用启动时拉起「自动开启转发 = 随 cc-bridge 启动」的连接。只用已保存的凭据。
pub async fn autostart_ssh_tunnels(app: AppHandle, state: Arc<AppState>) {
    let ids: Vec<String> = {
        let c = state.config.read().await;
        if !c.ssh_enabled {
            return;
        }
        c.ssh_connections
            .iter()
            .filter(|c| {
                c.forward_auto == ForwardAuto::Launch && c.forwards.iter().any(|r| r.enabled)
            })
            .map(|c| c.id.clone())
            .collect()
    };
    for id in ids {
        if let Err(e) = start_tunnel(app.clone(), state.clone(), id.clone(), None, None).await {
            log::warn!("自动开启端口转发失败（{id}）：{e}");
        }
    }
}

async fn start_tunnel(
    app: AppHandle,
    state: Arc<AppState>,
    id: String,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<TunnelStatus, String> {
    let _start_guard = state.ssh_tunnel_start_lock.lock().await;
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return Err("SSH 终端未启用，请先在设置中开启".into());
    }
    let (conn, jump) = load_link_parts(&state, &id).await?;
    let context = super::forward_context_cmds::context_for(&config, &state, &conn, &conn.forwards);
    if let Some(conflict) = context.conflicts.first() {
        return Err(conflict.message.clone());
    }
    let rules: Vec<_> = context
        .manual_rules
        .iter()
        .filter(|r| r.enabled)
        .cloned()
        .collect();
    if rules.is_empty() {
        if !context.managed_rule_ids.is_empty() {
            stop_and_wait(&state, &id).await;
            let mut status = TunnelStatus::stopped(id);
            status.message = Some("Claude Code 隧道由接入卡管理，无需额外开启转发。".into());
            let _ = app.emit(STATUS_EVENT, status.clone());
            return Ok(status);
        }
        return Err("这条连接还没有启用的转发规则".into());
    }
    let link = SshLink::new(conn, jump)?;
    start_plan(app, state.clone(), id, link, rules, password, passphrase).await
}

/// Isolated runtime key: managing stable Claude access never stops the user's other forwarding rules.
pub(super) async fn start_owned_tunnel(
    app: AppHandle,
    state: Arc<AppState>,
    link: SshLink,
    rules: Vec<ForwardRule>,
    credentials: (Option<String>, Option<String>),
    takeover: &mut super::forward_takeover::Takeover,
    configuring: bool,
) -> Result<(), String> {
    let _start_guard = state.ssh_tunnel_start_lock.lock().await;
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return Err("SSH 终端未启用，请先在设置中开启".into());
    }
    let operation = state.stable_operations.get(&link.conn.id);
    let active = operation
        .as_ref()
        .is_some_and(|op| op.active.load(Ordering::SeqCst));
    if active && !configuring {
        return Err("这台服务器正在配置接入。".into());
    }
    if active
        && operation
            .as_ref()
            .is_some_and(|op| op.cancel.load(Ordering::SeqCst))
    {
        return Err("操作已取消".into());
    }
    if !active
        && config
            .stable_connect
            .connections
            .iter()
            .any(|s| s.connection_id == link.conn.id && !s.enabled)
    {
        return Err("隧道连接已暂停，请从接入卡恢复。".into());
    }
    drop(operation);
    if !SshLink::from_config(&config, &link.conn.id)?.same_login(&link) {
        return Err("服务器登录配置已变化，请重新接入。".into());
    }
    let runtime_id = crate::stable_connect::runtime_id(&link.conn.id);
    if owned_tunnel_is_ready(&state, &runtime_id, &link, &rules) {
        return Ok(());
    }
    find_ssh().ok_or("未检测到系统 OpenSSH 客户端，无法开启端口转发")?;
    let original = super::forward_takeover::RunningForward::capture(&state, &runtime_id)?;
    // 🔴 先登记再动进程：下面任何一步失败，外层 restore 都要能认出「这条连接
    // 原来跑的是什么」。曾经登记放在 start_plan 成功之后，中途失败时 map 已空、
    // 登记没写上，回滚就丢了这条隧道（B3）。
    takeover.record(&state, runtime_id.clone(), original);
    let outcome = match super::forward_takeover::prepare_owned(
        &app, &state, &config, &link, &rules, takeover,
    )
    .await
    {
        Ok(()) => start_plan(
            app,
            state.clone(),
            runtime_id.clone(),
            link,
            rules,
            credentials.0,
            credentials.1,
        )
        .await
        .map(|_| ()),
        Err(e) => Err(e),
    };
    // 成功 = 留下新 stable 隧道句柄；失败 = None（map 已空，该恢复原样了）。
    takeover.settle(&state, &runtime_id);
    outcome
}

pub(super) fn owned_tunnel_is_ready(
    state: &AppState,
    id: &str,
    link: &SshLink,
    rules: &[ForwardRule],
) -> bool {
    let Some(tunnel) = state.ssh_tunnels.get(id) else {
        return false;
    };
    let status = tunnel.status.lock().unwrap_or_else(|p| p.into_inner());
    !tunnel.stop.load(Ordering::SeqCst)
        && status.state == TunnelState::Up
        && status.rules.len() == rules.len()
        && status.rules.iter().zip(rules).all(|(entry, rule)| {
            entry.state == crate::ssh_tunnel::RuleState::Listening
                && crate::forward_ownership::same_route(&entry.rule, rule)
        })
        && tunnel.restart.as_ref().is_some_and(|restart| {
            SshLink::new(restart.connection.clone(), restart.jump.clone())
                .is_ok_and(|original| original.same_login(link))
        })
}

pub(super) async fn start_plan(
    app: AppHandle,
    state: Arc<AppState>,
    id: String,
    link: SshLink,
    rules: Vec<ForwardRule>,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<TunnelStatus, String> {
    let ssh = find_ssh().ok_or("未检测到系统 OpenSSH 客户端，无法开启端口转发")?;
    let managed = id == crate::stable_connect::runtime_id(&link.conn.id);
    if managed
        && (rules.len() != 1 || rules[0].kind != ForwardKind::Remote || rules[0].listen_port == 0)
    {
        return Err("托管隧道需要一个固定的远端监听端口。".into());
    }
    // 重启时必须等旧进程真正退出：它还占着本地端口，新进程会 bind 失败。
    stop_and_wait(&state, &id).await;

    let guard = managed.then(|| {
        let route = link
            .jump
            .as_ref()
            .map(|jump| (&jump.host, jump.port, &jump.username));
        let scope = serde_json::to_vec(&(
            &id,
            &link.conn.host,
            link.conn.port,
            &link.conn.username,
            route,
        ))
        .unwrap();
        Arc::new(ManagedGuard::new(
            &state.data_dir,
            &scope,
            rules[0].listen_port,
        ))
    });
    let mut status = TunnelStatus::new(id.clone(), &rules);
    if managed {
        status.require_guard();
    }
    let tunnel = SshTunnel {
        stop: Arc::new(AtomicBool::new(false)),
        status: Arc::new(StdMutex::new(status.clone())),
        killer: Arc::new(StdMutex::new(None)),
        thread: StdMutex::new(None),
        restart: Some(Arc::new(SshTunnelRestart {
            connection: link.conn.clone(),
            jump: link.jump.clone(),
            password: StdMutex::new(password.clone().filter(|v| !v.is_empty())),
            passphrase: StdMutex::new(passphrase.clone().filter(|v| !v.is_empty())),
        })),
        // 同一份句柄也留在隧道本体上：停止时（`SshTunnel::release_receipt`）要靠它的
        // 身份确认盘上凭据是不是自己写的，才能安全删掉。
        guard: guard.clone(),
    };
    let plan = Plan {
        id: id.clone(),
        link,
        ssh,
        rules,
        data_dir: state.data_dir.clone(),
        password: StdMutex::new(password.filter(|v| !v.is_empty())),
        passphrase: StdMutex::new(passphrase.filter(|v| !v.is_empty())),
        guard,
        state: Arc::downgrade(&state),
    };
    let (stop, shared, killer, app2) = (
        tunnel.stop.clone(),
        tunnel.status.clone(),
        tunnel.killer.clone(),
        app.clone(),
    );
    // 监管线程拿走一份 clone：`shared` 后面还要读一次当前快照。
    let shared_in_thread = shared.clone();
    let handle =
        std::thread::spawn(move || supervise(&app2, &plan, &stop, &shared_in_thread, &killer));
    *tunnel.thread.lock().unwrap() = Some(handle);
    // 🔴 并发启动的兜底：两次 start 可能都越过上面的 `stop_and_wait` 才走到这里，
    // 后插入的会顶掉先插入的那条。被顶掉的监管线程再也等不到 stop 标志，ssh 进程
    // 和它占的监听端口会一直挂着（用户以为停了，其实端口还被占着）。
    // 这里把它一并收掉，并**等它真的退出**——端口不放，新进程 bind 不上。
    if let Some(displaced) = state.ssh_tunnels.insert(id, tunnel) {
        displaced.halt();
        let old = displaced
            .thread
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(h) = old {
            let _ = tauri::async_runtime::spawn_blocking(move || h.join()).await;
        }
    }
    // 状态以共享快照为准，不能发上面构造的那份：线程可能已经先跑出结果
    // （解密失败、PTY 打不开、进程起不来），随后发一份 Connecting 会把它盖回去，
    // 前端就永远停在「连接中」，连失败原因都看不到。
    let snapshot = shared.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let _ = app.emit(STATUS_EVENT, snapshot.clone());
    Ok(snapshot)
}

pub(super) fn tunnel_args(link: &SshLink, id: &str, rules: &[ForwardRule]) -> Vec<String> {
    let mut args = ssh_base_args(link, "-p");
    // A managed tunnel has one required listener: exit and retry while an old VPN peer releases it.
    // Manual mixed rules keep their successful listeners when another rule fails.
    if id == crate::stable_connect::runtime_id(&link.conn.id) {
        for argument in &mut args {
            if argument.starts_with("ServerAliveInterval=") {
                // OpenSSH uses the first value; appending a second -o would leave the old 30s interval active.
                *argument = "ServerAliveInterval=10".into();
            }
        }
        // Windows OpenSSH needs terminal mode to forward submitted heartbeat frames promptly.
        args.extend(["-tt".into(), "-v".into()]);
        args.extend(["-o".into(), "ExitOnForwardFailure=yes".into()]);
        // A stalled VPN handshake must finish before the 30s credential fill window expires.
        args.extend(["-o".into(), "ConnectTimeout=10".into()]);
    } else {
        args.extend(["-N".into(), "-v".into()]);
    }
    args.extend(forward_args(rules));
    args.push(format!("{}@{}", link.conn.username, link.conn.host));
    args
}

pub(super) async fn stop_and_wait(state: &Arc<AppState>, id: &str) {
    stop_tunnel(state, id, false).await;
}

/// 真正的停止：用户断开、连接被删。与 [`stop_and_wait`] 的区别只有一个 ——
/// 顺手清掉远端监听的恢复凭据，因为后面不会立刻用新参数重启。返回值见 `stop_tunnel`。
pub(super) async fn stop_and_release(state: &Arc<AppState>, id: &str) -> bool {
    stop_tunnel(state, id, true).await
}

/// `release` 只在**不会紧跟一次重启**时传 true。重启路径（`start_plan`、接管替换）
/// 必须保留凭据：旧远端监听可能还在释放端口，下一次启动要靠它去回收。
///
/// 返回值：是否真的停掉了一条在跑的隧道（调用方据此决定要不要记审计）。
async fn stop_tunnel(state: &Arc<AppState>, id: &str, release: bool) -> bool {
    let Some(old) = state.halt_ssh_tunnel(id) else {
        return false;
    };
    let handle = old.thread.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(h) = handle {
        let _ = tauri::async_runtime::spawn_blocking(move || h.join()).await;
    }
    // 线程退出后再清：`register` 在 stop 置位后就不再写凭据，此时删是终态。
    if release {
        old.release_receipt();
    }
    true
}

/// 改状态并推给前端。已停止的转发不再发事件：同一连接可能已经换成了新进程，
/// 旧线程收尾时的状态会盖掉新的。
fn publish(
    app: &AppHandle,
    stop: &AtomicBool,
    status: &StdMutex<TunnelStatus>,
    f: impl FnOnce(&mut TunnelStatus) -> bool,
) {
    let snap = {
        let mut s = status.lock().unwrap_or_else(|p| p.into_inner());
        if !f(&mut s) {
            return;
        }
        s.clone()
    };
    if !stop.load(Ordering::SeqCst) {
        if let Some(id) = snap.connection_id.strip_prefix("stable:") {
            let _ = app.emit(
                "stable_connect_changed",
                serde_json::json!({"connectionId":id}),
            );
        }
        let _ = app.emit(STATUS_EVENT, snap);
    }
}

/// 服务器拒绝监听 = 这个端口被别人占了，重连多少次都撞在同一个号上。
/// 只有托管隧道（稳定接入）按致命处理并转成可操作提示；手动转发的端口可能等对方
/// 释放后就好了，保持原来的无限重连行为。
fn port_taken_stops_retry(managed: bool, reason: &str) -> bool {
    managed && reason.contains("服务器拒绝监听")
}

fn supervise(
    app: &AppHandle,
    plan: &Plan,
    stop: &Arc<AtomicBool>,
    status: &SharedStatus,
    killer: &StdMutex<Option<Killer>>,
) {
    supervise_loop(app, plan, stop, status, killer);
    // 停机即清零：监管线程退出后凭据不该继续留在 Plan 里过夜。
    *plan.password.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *plan.passphrase.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

fn supervise_loop(
    app: &AppHandle,
    plan: &Plan,
    stop: &Arc<AtomicBool>,
    status: &SharedStatus,
    killer: &StdMutex<Option<Killer>>,
) {
    let mut delay = RETRY_MIN;
    loop {
        // 重连前确认登录身份没被「保存连接」改掉。手动隧道的 `Plan.link` 钉着启动
        // 时的服务器/凭据，保存路径按产品语义不停它（不打断用户正在用的转发），
        // 所以这里是把最后一道关：改过还按旧信息连，等于用户改了服务器我们却连
        // 旧的，断线后还会拿旧凭据无限重连。托管隧道保存时已被停，走不到这。
        if !login_still_current(plan) {
            publish(app, stop, status, |s| {
                s.state = TunnelState::Error;
                s.message =
                    Some("服务器登录信息已更改，转发已停止。请在端口转发面板重新开启。".into());
                true
            });
            return;
        }
        let fatal = run_once(app, plan, stop, status, killer);
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let (was_up, last) = {
            let s = status.lock().unwrap_or_else(|p| p.into_inner());
            (connected_for_retry(&s), retry_error(&s))
        };
        let needs_secret = matches!(fatal, Some(Fatal::NeedsSecret(_)));
        // 判定必须在取出 reason 之前做：`fatal` 在下面被 move 掉。
        let stop_here = give_up(fatal.as_ref());
        let reason = match fatal {
            Some(
                Fatal::NeedsSecret(r)
                | Fatal::Interactive(r)
                | Fatal::Other(r)
                | Fatal::GuardUnavailable(r),
            ) => r,
            None => last.unwrap_or_else(|| "SSH 进程已退出".into()),
        };
        let is_stable = status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connection_id
            .starts_with("stable:");
        if is_stable {
            log::warn!("托管隧道本次未连通：{reason}");
        }
        // 服务器拒绝监听是「这个端口被别人占了」，重连多少次都一样，只会每 60 秒撞一次。
        // 只有托管隧道按致命处理：手动转发的端口可能等对方释放后就好了，保持原行为。
        let port_taken = port_taken_stops_retry(is_stable, &reason);
        if stop_here || is_fatal(&reason) || port_taken {
            publish(app, stop, status, |s| {
                s.state = TunnelState::Error;
                // SSH may report a rejected credential only when exiting, without another prompt.
                s.needs_secret = needs_secret || reason.contains("Permission denied");
                s.message = Some(if port_taken {
                    format!(
                        "{reason}。共享服务器上每个账号需要各自的端口，请在接入页点「重新接入」分配专属端口。"
                    )
                } else {
                    reason
                });
                true
            });
            return;
        }
        if was_up {
            delay = RETRY_MIN;
        }
        publish(app, stop, status, |s| {
            s.state = TunnelState::Reconnecting;
            s.message = Some(format!("{reason}（{} 秒后重连）", delay.as_secs()));
            true
        });
        let wake = Instant::now() + delay;
        while Instant::now() < wake {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        delay = (delay * 2).min(RETRY_MAX);
    }
}

/// 当前配置里的登录身份是否还是这条隧道启动时的那一个。
///
/// `try_read` 读不到（配置正在写）时放行：写配置是低频操作，宁可多连一轮也不要
/// 因为一次读锁竞争把好端端的隧道误停。连接被删 / 读不到时返回 false——没有对应
/// 连接的隧道没有继续连的道理。
fn login_still_current(plan: &Plan) -> bool {
    let Some(state) = plan.state.upgrade() else {
        return true;
    };
    let Ok(config) = state.config.try_read() else {
        return true;
    };
    SshLink::from_config(&config, &plan.link.conn.id)
        .is_ok_and(|current| current.same_login(&plan.link))
}

fn connected_for_retry(status: &TunnelStatus) -> bool {
    // 认证成功但一条监听都没打通（sshd 拒绝绑定 / 端口全冲突）时，若还按
    // 「曾连上过」重置退避，重连就固定成 2s 一次完整登录——fail2ban 视角就是攻击。
    // 手动与托管一视同仁：至少要有一条规则真的在监听，才算「通过」。
    if !status.was_up {
        return false;
    }
    if status.connection_id.starts_with("stable:") {
        // 托管隧道只有一条规则，还要恢复程序（guard）就绪。
        status.guard_is_ready()
            && status
                .rules
                .iter()
                .all(|r| r.state == crate::ssh_tunnel::RuleState::Listening)
    } else {
        // 手动可能是混合规则：部分失败时网络确实是通的，按 any 放行。
        status
            .rules
            .iter()
            .any(|r| r.state == crate::ssh_tunnel::RuleState::Listening)
    }
}

fn retry_error(status: &TunnelStatus) -> Option<String> {
    if status.connection_id.starts_with("stable:") {
        if let Some(message) = status
            .rules
            .iter()
            .find(|r| r.state == crate::ssh_tunnel::RuleState::Failed)
            .and_then(|r| r.message.clone())
        {
            return Some(message);
        }
        // A previously rendered login prompt is not SSH's reason for exiting.
        return status.last_error.clone().filter(|line| {
            !password_prompt_in(line.as_bytes()) && !passphrase_prompt_in(line.as_bytes())
        });
    }
    status.last_error.clone()
}

#[derive(Clone)]
pub(super) enum Fatal {
    NeedsSecret(String),
    /// 后台转发**没有人能手输**：2FA 验证码、密码过期强制改密一类。重试只会一次次
    /// 拿同样的输出撞服务器，除了喂 fail2ban 没有任何意义，所以必须停住。
    /// 🔴 不能混进 `Other`：`Other` 是环境性失败（PTY 打不开、ssh 起不来），那些值得重连。
    Interactive(String),
    /// 环境性失败，可以重连。
    Other(String),
    GuardUnavailable(String),
}

/// 这一轮结束后还要不要重连。`reason` 里的关键词另由 `is_fatal` 兜（`Permission denied`
/// 这类是 ssh 自己退出时报的，不经过 `Fatal`）。
fn give_up(fatal: Option<&Fatal>) -> bool {
    matches!(
        fatal,
        Some(Fatal::NeedsSecret(_) | Fatal::Interactive(_) | Fatal::GuardUnavailable(_))
    )
}

/// 跑一轮 ssh 进程直到它退出。返回不该重试的失败原因；普通退出的原因在 `status.last_error`。
fn run_once(
    app: &AppHandle,
    plan: &Plan,
    stop: &Arc<AtomicBool>,
    status: &SharedStatus,
    killer: &StdMutex<Option<Killer>>,
) -> Option<Fatal> {
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    publish(app, stop, status, |s| {
        s.begin_attempt();
        true
    });
    let creds = match resolve_connect_secrets(
        &plan.link,
        &plan.data_dir,
        plan.password
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
        plan.passphrase
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
    ) {
        Ok(c) => c,
        Err(e) => return Some(Fatal::Other(e)),
    };
    if let Some(guard) = &plan.guard {
        if let Err(failure) =
            reclaim_previous(guard, &plan.link, &plan.ssh, creds.clone(), stop, killer)
        {
            return Some(failure);
        }
    }
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    let mut rules = plan.rules.clone();
    // Keep the logical rule in TunnelStatus so matching, rollback and fixed remote ports
    // are independent of the disposable localhost listener for this SSH attempt.
    let _relay = plan
        .guard
        .as_ref()
        .and_then(|_| attach_traffic_relay(app, plan, &mut rules[0], stop, status));
    let mut args = tunnel_args(&plan.link, &plan.id, &rules);
    let guard_run = plan.guard.as_ref().map(|guard| {
        let attempt = guard.attempt();
        args.push(attempt.command());
        Arc::new(GuardRun::serve(guard.clone(), attempt, stop.clone()))
    });
    let (app, stop_for_output, status) = (app.clone(), stop.clone(), status.clone());
    process::run(
        &plan.ssh,
        &args,
        creds,
        stop,
        killer,
        guard_run,
        move |output| {
            publish(&app, &stop_for_output, &status, |state| match output {
                Output::SshLine(line) => state.apply_line(line),
                Output::GuardReady => state.guard_started(),
            });
        },
    )
}

fn attach_traffic_relay(
    app: &AppHandle,
    plan: &Plan,
    rule: &mut ForwardRule,
    stop: &Arc<AtomicBool>,
    status: &SharedStatus,
) -> Option<Relay> {
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Activity<'a> {
        connection_id: &'a str,
        at: u64,
        to_local: u64,
        to_remote: u64,
    }

    let (app, stop, status) = (app.clone(), stop.clone(), status.clone());
    let state = plan.state.clone();
    let connection_id = plan.link.conn.id.clone();
    let target = (rule.target_host.clone(), rule.target_port);
    // This runs on the SSH supervisor thread. Bind before spawning ssh so the
    // reverse forward never points at an unreserved port.
    let result = tauri::async_runtime::block_on(Relay::start(target, move |delta: ByteDelta| {
        if stop.load(Ordering::SeqCst)
            || status.lock().unwrap_or_else(|p| p.into_inner()).state != TunnelState::Up
        {
            return;
        }
        let Some(state) = state.upgrade() else { return };
        // Telemetry can skip a batch during a config write. Forwarding never waits for UI state.
        let selected = state.config.try_read().is_ok_and(|config| {
            crate::stable_connect::selected_saved(&config)
                .is_some_and(|saved| saved.enabled && saved.connection_id == connection_id)
        });
        if !selected || !state.mcp_running.load(Ordering::Relaxed) {
            return;
        }
        let _ = app.emit(
            "stable_tunnel_traffic",
            Activity {
                connection_id: &connection_id,
                at: crate::connection_access::now_ms(),
                to_local: delta.to_local,
                to_remote: delta.to_remote,
            },
        );
    }));
    match result {
        Ok(relay) => {
            rule.target_host = std::net::Ipv4Addr::LOCALHOST.to_string();
            rule.target_port = relay.port;
            Some(relay)
        }
        Err(error) => {
            log::debug!("隧道流量监测不可用，继续使用原转发目标：{error}");
            None
        }
    }
}

pub(super) fn reclaim_previous(
    guard: &ManagedGuard,
    link: &SshLink,
    ssh: &PathBuf,
    creds: PendingCreds,
    stop: &Arc<AtomicBool>,
    killer: &StdMutex<Option<Killer>>,
) -> Result<(), Fatal> {
    let Some(receipt) = guard.previous() else {
        return Ok(());
    };
    let (command, nonce) = reclaim_command(&receipt);
    let mut args = tunnel_args(link, &crate::stable_connect::runtime_id(&link.conn.id), &[]);
    args.push(command);
    let control = Arc::new(GuardRun::reclaim(nonce, stop.clone()));
    let last_error = Arc::new(StdMutex::new(None::<String>));
    let captured = last_error.clone();
    let fatal = process::run(
        ssh,
        &args,
        creds,
        stop,
        killer,
        Some(control.clone()),
        move |output| {
            if let Output::SshLine(line) = output {
                capture_reclaim_error(line, &captured);
            }
        },
    );
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(failure) = fatal {
        return Err(failure);
    }
    match control.reply() {
        Some(ReclaimResult::Released | ReclaimResult::Gone) => {
            if control.reply() == Some(ReclaimResult::Released) {
                log::info!(
                    "托管隧道旧会话已回收：端口 {}，PID {}",
                    receipt.port,
                    receipt.pid
                );
            }
            guard.forget(&receipt).map_err(Fatal::Other)
        }
        Some(ReclaimResult::Unverified) => Err(Fatal::Other(
            "旧隧道身份未能核验，正在等待原端口释放。".into(),
        )),
        None => Err(Fatal::Other(
            last_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
                .unwrap_or_else(|| "暂时无法确认旧隧道已释放，请等待自动重连。".into()),
        )),
    }
}

fn capture_reclaim_error(line: &str, captured: &StdMutex<Option<String>>) {
    let line = line.trim();
    if !line.is_empty()
        && !line.starts_with("debug")
        && !line.starts_with("OpenSSH")
        && !password_prompt_in(line.as_bytes())
        && !passphrase_prompt_in(line.as_bytes())
    {
        *captured.lock().unwrap_or_else(|p| p.into_inner()) = Some(line.into());
    }
}

pub(super) fn read_loop(
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    mut creds: PendingCreds,
    mut killer: Killer,
    mut emit_line: impl FnMut(&str),
) -> Option<Fatal> {
    let mut dec = crate::utf8_stream::Utf8Stream::new();
    let mut line = String::new();
    // 当前这一行提示是否已经处理过：填完密码到换行到达之间，ConPTY 可能还会补几字节控制序列，
    // 不记住的话同一个提示会被再判一次，而凭据已经取走，就会误报「需要密码」。
    let mut prompt_done = false;
    let mut fatal = None;
    let deadline = Instant::now() + CREDENTIAL_FILL_WINDOW;
    let mut buf = [0u8; 4096];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if Instant::now() >= deadline {
            creds.clear();
        }
        for ch in dec.push(&buf[..n]).chars() {
            if ch != '\n' {
                line.push(ch);
                continue;
            }
            let clean = strip_ansi(&line);
            emit_line(&clean);
            // ConPTY can append a newline to a login prompt in the same read: handle it before
            // discarding the line, using the same guard as a prompt split across multiple reads.
            reply_to_prompt(
                &clean,
                &mut creds,
                writer.as_mut(),
                killer.as_mut(),
                &mut prompt_done,
                &mut fatal,
            );
            line.clear();
            prompt_done = false;
        }
        reply_to_prompt(
            &strip_ansi(&line),
            &mut creds,
            writer.as_mut(),
            killer.as_mut(),
            &mut prompt_done,
            &mut fatal,
        );
    }
    line.push_str(&dec.flush());
    let clean = strip_ansi(&line);
    // ConPTY can close without rendering the last newline; retain SSH's actual exit error.
    if !clean.trim().is_empty() {
        emit_line(&clean);
    }
    fatal
}

fn reply_to_prompt(
    tail: &str,
    creds: &mut PendingCreds,
    writer: &mut dyn Write,
    killer: &mut dyn ChildKiller,
    prompt_done: &mut bool,
    fatal: &mut Option<Fatal>,
) {
    if *prompt_done || fatal.is_some() {
        return;
    }
    let Some(answer) = prompt_answer(tail, creds) else {
        return;
    };
    *prompt_done = true;
    match answer {
        Ok(secret) => {
            let _ = writer.write_all(secret.as_bytes());
            // ConPTY interprets CR as the Enter key; LF can leave Windows OpenSSH waiting to submit.
            let _ = writer.write_all(if cfg!(windows) { b"\r" } else { b"\n" });
            let _ = writer.flush();
        }
        Err(f) => {
            *fatal = Some(f);
            let _ = killer.kill();
        }
    }
}

/// 一行若是登录提示，给出要填的凭据；填不了就是致命错误——后台转发没有人能手输。
/// `debug` 开头的是被读取边界截断的日志行，不是提示。
fn prompt_answer(tail: &str, creds: &mut PendingCreds) -> Option<Result<String, Fatal>> {
    if tail.trim_start().starts_with("debug") {
        return None;
    }
    let bytes = tail.as_bytes();
    prompt_tail(bytes)?;
    let secret = if password_prompt_in(bytes) {
        creds.take_password(tail)
    } else if passphrase_prompt_in(bytes) {
        creds.take_passphrase(tail)
    } else {
        // 既不是密码也不是口令：2FA 验证码、改密提示、主机密钥交互……都是后台答不了的。
        // 归到 `Interactive` 而不是 `Other`，否则会按「环境性失败」无限重连。
        return Some(Err(Fatal::Interactive(format!(
            "服务器要求交互式输入（{}），后台转发无法应答：请先用终端手动登录一次，或改用密钥认证",
            tail.trim()
        ))));
    };
    Some(secret.ok_or_else(|| {
        Fatal::NeedsSecret("需要密码或密钥口令：请在连接设置里保存，或开启转发时输入".into())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BridgeConfig, SshConnection};
    use std::io::Cursor;

    #[derive(Clone)]
    struct CapturedInput(Arc<StdMutex<Vec<u8>>>);

    impl Write for CapturedInput {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Debug)]
    struct TestKiller(Arc<AtomicBool>);

    impl ChildKiller for TestKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Killer {
            Box::new(self.clone())
        }
    }

    fn read_prompt(output: &str, password: Option<&str>) -> (Option<Fatal>, Vec<u8>, bool) {
        read_output(
            Box::new(Cursor::new(output.as_bytes().to_vec())),
            PendingCreds::direct(&SshConnection::default(), password.map(str::to_owned), None),
        )
    }

    fn read_output(
        reader: Box<dyn Read + Send>,
        creds: PendingCreds,
    ) -> (Option<Fatal>, Vec<u8>, bool) {
        let input = CapturedInput(Arc::new(StdMutex::new(Vec::new())));
        let killer = TestKiller(Arc::new(AtomicBool::new(false)));
        let fatal = read_loop(
            reader,
            Box::new(input.clone()),
            creds,
            Box::new(killer.clone()),
            |_| {},
        );
        let written = input.0.lock().unwrap().clone();
        (fatal, written, killer.0.load(Ordering::SeqCst))
    }

    #[test]
    fn newline_login_prompt_fills_available_credential_once() {
        let (fatal, input, killed) =
            read_prompt("dev@server.test's password: \r\n", Some("test-secret"));
        assert_eq!(
            input,
            if cfg!(windows) {
                b"test-secret\r"
            } else {
                b"test-secret\n"
            }
        );
        assert!(fatal.is_none());
        assert!(!killed);
    }

    #[test]
    fn newline_login_prompt_without_credential_stops_for_login() {
        let (fatal, input, killed) = read_prompt("dev@server.test's password: \r\n", None);
        assert!(matches!(fatal, Some(Fatal::NeedsSecret(_))));
        assert!(input.is_empty());
        assert!(killed);
    }

    #[test]
    fn newline_key_prompt_uses_passphrase_instead_of_password() {
        let creds = PendingCreds::direct(
            &SshConnection::default(),
            Some("login-secret".into()),
            Some("key-secret".into()),
        );
        let (fatal, input, killed) = read_output(
            Box::new(Cursor::new(
                b"Enter passphrase for key '/keys/id_rsa': \r\n".to_vec(),
            )),
            creds,
        );
        assert_eq!(
            input,
            if cfg!(windows) {
                b"key-secret\r"
            } else {
                b"key-secret\n"
            }
        );
        assert!(fatal.is_none());
        assert!(!killed);
    }

    #[test]
    fn newline_debug_log_does_not_consume_login_credential() {
        let (fatal, input, killed) = read_prompt(
            "debug1: next authentication method: password:\r\ndev@server.test's password: \r\n",
            Some("test-secret"),
        );
        assert_eq!(
            input,
            if cfg!(windows) {
                b"test-secret\r"
            } else {
                b"test-secret\n"
            }
        );
        assert!(fatal.is_none());
        assert!(!killed);
    }

    #[test]
    fn newline_interactive_and_password_change_prompts_never_fill_login_password() {
        for prompt in ["Verification code: \r\n", "New password: \r\n"] {
            let (fatal, input, killed) = read_prompt(prompt, Some("old-secret"));
            assert!(matches!(fatal, Some(Fatal::Interactive(_))));
            assert!(input.is_empty());
            assert!(killed);
        }
    }

    #[test]
    fn split_login_prompt_with_late_newline_does_not_fill_twice() {
        struct Chunks(std::collections::VecDeque<Vec<u8>>);
        impl Read for Chunks {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let Some(chunk) = self.0.pop_front() else {
                    return Ok(0);
                };
                assert!(chunk.len() <= buf.len());
                buf[..chunk.len()].copy_from_slice(&chunk);
                Ok(chunk.len())
            }
        }
        let reader = Chunks(
            [
                "dev@server.test's password: ",
                "\x1b[1C\x1b[?25h\r\n",
                "Authenticated to server.test ([10.0.0.1]:22) using \"password\".\r\n",
            ]
            .into_iter()
            .map(|s| s.as_bytes().to_vec())
            .collect(),
        );
        let creds =
            PendingCreds::direct(&SshConnection::default(), Some("test-secret".into()), None);
        let (fatal, input, killed) = read_output(Box::new(reader), creds);
        assert_eq!(
            input,
            if cfg!(windows) {
                b"test-secret\r"
            } else {
                b"test-secret\n"
            }
        );
        assert!(fatal.is_none());
        assert!(!killed);
    }

    #[test]
    fn final_forward_failure_without_newline_updates_the_listener_state() {
        let config = crate::config::BridgeConfig::default();
        let mut status = TunnelStatus::new(
            crate::stable_connect::runtime_id("server"),
            &[crate::stable_connect::rule(7823, &config)],
        );
        let input = CapturedInput(Arc::new(StdMutex::new(Vec::new())));
        let fatal = read_loop(
            Box::new(Cursor::new(
                b"Error: remote port forwarding failed for listen port 7823".to_vec(),
            )),
            Box::new(input),
            PendingCreds::direct(&SshConnection::default(), None, None),
            Box::new(TestKiller(Arc::new(AtomicBool::new(false)))),
            |line| {
                status.apply_line(line);
            },
        );
        assert!(fatal.is_none());
        assert_eq!(status.rules[0].state, crate::ssh_tunnel::RuleState::Failed);
    }

    #[test]
    fn a_taken_port_stops_only_the_managed_tunnel() {
        let reason = "服务器拒绝监听（端口已被占用，或 sshd 不允许绑定该地址，见 GatewayPorts）";
        assert!(port_taken_stops_retry(true, reason));
        // 手动转发的端口等对方释放后还能用，不能因为一次占用就永久停掉。
        assert!(!port_taken_stops_retry(false, reason));
        // 其他失败原因仍旧走退避重连，别把网络抖动也当成端口冲突。
        assert!(!port_taken_stops_retry(true, "Connection reset by peer"));
    }

    #[test]
    fn managed_listener_failure_takes_priority_over_an_old_password_prompt() {
        let config = crate::config::BridgeConfig::default();
        let mut status = TunnelStatus::new(
            crate::stable_connect::runtime_id("server"),
            &[crate::stable_connect::rule(7823, &config)],
        );
        status.apply_line("dev@server.test's password:");
        assert!(retry_error(&status).is_none());
        status.apply_line("Error: remote port forwarding failed for listen port 7823");
        assert!(retry_error(&status).unwrap().contains("服务器拒绝监听"));
        status.connection_id = "server".into();
        assert_eq!(retry_error(&status).unwrap(), "dev@server.test's password:");
    }

    #[test]
    fn final_authentication_error_without_newline_requires_login() {
        let mut status = TunnelStatus::stopped("server".into());
        let fatal = read_loop(
            Box::new(Cursor::new(
                b"Permission denied (publickey,password).".to_vec(),
            )),
            Box::new(CapturedInput(Arc::new(StdMutex::new(Vec::new())))),
            PendingCreds::direct(&SshConnection::default(), None, None),
            Box::new(TestKiller(Arc::new(AtomicBool::new(false)))),
            |line| {
                status.apply_line(line);
            },
        );
        assert!(fatal.is_none());
        assert!(is_fatal(status.last_error.as_deref().unwrap()));
    }

    #[test]
    fn vpn_owned_tunnel_retries_listener_failure_on_the_same_fixed_port() {
        let config = crate::config::BridgeConfig::default();
        let link = SshLink::new(
            SshConnection {
                id: "server".into(),
                host: "server.test".into(),
                username: "dev".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let args = tunnel_args(
            &link,
            &crate::stable_connect::runtime_id("server"),
            &[crate::stable_connect::rule(7823, &config)],
        );
        assert!(!args.iter().any(|argument| argument == "-N"));
        assert!(args.iter().any(|argument| argument == "-tt"));
        let alive: Vec<_> = args
            .iter()
            .filter(|argument| argument.starts_with("ServerAliveInterval="))
            .collect();
        assert_eq!(alive, [&"ServerAliveInterval=10".to_string()]);
        assert!(args.windows(2).any(|a| a == ["-o", "ExitOnForwardFailure=yes"]),
            "A failed managed listener must exit so the supervisor can retry; ssh -N otherwise stays alive forever");
        assert!(args
            .windows(2)
            .any(|a| a[0] == "-R" && a[1].starts_with("127.0.0.1:7823:")));
        let timeout = args
            .iter()
            .find_map(|arg| arg.strip_prefix("ConnectTimeout="))
            .expect("A VPN outage must not leave one connection attempt waiting indefinitely")
            .parse::<u64>()
            .unwrap();
        assert!(timeout > 0 && Duration::from_secs(timeout) < CREDENTIAL_FILL_WINDOW);
        assert!(!is_fatal(
            "Error: remote port forwarding failed for listen port 7823"
        ));
    }

    #[test]
    fn vpn_manual_mixed_rules_keep_partial_success_and_authentication_still_stops() {
        let link = SshLink::new(
            SshConnection {
                id: "server".into(),
                host: "server.test".into(),
                username: "dev".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let args = tunnel_args(&link, "server", &[ForwardRule::default()]);
        assert!(!args.iter().any(|a| a == "ExitOnForwardFailure=yes"));
        assert!(is_fatal("Permission denied (publickey,password)."));
        assert!(give_up(Some(&Fatal::NeedsSecret("需要密码".into()))));
    }

    #[test]
    fn vpn_failed_listener_does_not_reset_backoff_but_a_connected_tunnel_does() {
        let config = crate::config::BridgeConfig::default();
        let mut status = TunnelStatus::new(
            crate::stable_connect::runtime_id("server"),
            &[crate::stable_connect::rule(7823, &config)],
        );
        status.apply_line("Authenticated to server.test ([10.0.0.1]:22) using \"password\".");
        status.apply_line("Warning: remote port forwarding failed for listen port 7823");
        assert!(!connected_for_retry(&status));
        status.begin_attempt();
        status.apply_line("Authenticated to server.test ([10.0.0.1]:22) using \"password\".");
        status.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:7823, connect 127.0.0.1:7823",
        );
        assert!(connected_for_retry(&status));
    }

    /// 手动隧道「认证成功但一条监听都没上」不得重置退避。
    ///
    /// 曾经只有托管隧道收紧这条：手动隧道认证过就重置，若服务器稳定拒绝监听
    /// （sshd 不允许 / 端口全冲突）且 ssh 会退出，重连就固定成 2s 一次完整登录，
    /// 在 fail2ban 视角里就是攻击。
    #[test]
    fn manual_authenticated_without_any_listener_does_not_reset_backoff() {
        let mut status = TunnelStatus::new(
            "server".into(),
            &[ForwardRule {
                listen_port: 8080,
                ..Default::default()
            }],
        );
        status.apply_line("Authenticated to server.test ([10.0.0.1]:22) using \"password\".");
        assert!(status.was_up);
        status.apply_line("channel_setup_fwd_listener_tcpip: cannot listen to port: 8080");
        assert_eq!(status.rules[0].state, crate::ssh_tunnel::RuleState::Failed);
        assert!(
            !connected_for_retry(&status),
            "一条监听都没上，手动隧道也不能重置退避"
        );
        // 至少一条监听就位就放行：混合规则下网络确实是通的。
        status.begin_attempt();
        status.apply_line("Authenticated to server.test ([10.0.0.1]:22) using \"password\".");
        status.apply_line("debug1: Local forwarding listening on 127.0.0.1 port 8080.");
        assert!(connected_for_retry(&status));
    }

    /// 2FA 验证码这类「后台没人能应答」的提示必须直接放弃。
    ///
    /// 曾经它落在 `Fatal::Other` 里，而 `supervise` 只认「需要密码」和 4 个关键词
    /// （`Permission denied` 一类），于是这种提示会走重连分支：2s→60s 退避地无限
    /// 撞服务器，每次都是一次真实认证尝试。
    #[test]
    fn interactive_prompt_stops_instead_of_retrying() {
        let mut creds = PendingCreds::direct(&SshConnection::default(), None, None);
        let answer = prompt_answer("Verification code: ", &mut creds).expect("冒号结尾就是提示");
        let Err(fatal) = answer else {
            panic!("没有可用凭据，不该返回要填的内容");
        };
        assert!(
            matches!(fatal, Fatal::Interactive(_)),
            "交互式提示必须归到不可重试的 Interactive"
        );
        assert!(give_up(Some(&fatal)), "交互式提示不该重连");
        // 关键词表拦不住这类提示（`is_fatal` 只看 ssh 自己退出时报的那几句），
        // 所以必须在 `Fatal` 上分出来 —— 这条断言就是那个「为什么」。
        assert!(!is_fatal(
            "服务器要求交互式输入（Verification code:），后台转发无法应答"
        ));
    }

    /// 环境性失败仍要重连；缺凭据仍要把「要密码」的旗子交给前端。
    #[test]
    fn env_failures_still_retry() {
        assert!(!give_up(Some(&Fatal::Other("打开 PTY 失败".into()))));
        assert!(!give_up(None));
        assert!(give_up(Some(&Fatal::NeedsSecret("需要密码".into()))));
    }

    fn plan_for(state: &Arc<AppState>, conn: &SshConnection) -> Plan {
        Plan {
            id: conn.id.clone(),
            link: SshLink::new(conn.clone(), None).unwrap(),
            ssh: PathBuf::from("ssh"),
            rules: vec![],
            data_dir: std::env::temp_dir(),
            password: StdMutex::new(None),
            passphrase: StdMutex::new(None),
            guard: None,
            state: Arc::downgrade(state),
        }
    }

    /// B1 的回归：保存连接改了登录信息后，重连前必须发现「连的是旧服务器」。
    /// 手动隧道按产品语义不在保存路径停（不打断用户），这道校验就是最后一道关。
    #[tokio::test]
    async fn reconnect_stops_instead_of_dialing_the_old_server_after_a_login_change() {
        let mut config = BridgeConfig {
            port: 7823,
            token: "private-test-token".into(),
            ..Default::default()
        };
        let connection = SshConnection {
            id: "server".into(),
            host: "server.test".into(),
            username: "dev".into(),
            ..Default::default()
        };
        config.ssh_connections = vec![connection.clone()];
        let state = Arc::new(AppState::new(
            rusqlite::Connection::open_in_memory().unwrap(),
            config,
            std::env::temp_dir().join("cc-bridge-login-check-no-io"),
        ));
        let plan = plan_for(&state, &connection);
        assert!(login_still_current(&plan), "配置没变必须放行");

        state.config.write().await.ssh_connections[0].host = "elsewhere.test".into();
        assert!(
            !login_still_current(&plan),
            "登录身份变了必须停住，不能按旧 host 重连"
        );

        state.config.write().await.ssh_connections.clear();
        assert!(!login_still_current(&plan), "连接被删后没有继续连的道理");
    }
}
