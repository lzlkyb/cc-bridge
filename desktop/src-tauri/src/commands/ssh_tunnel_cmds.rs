//! 端口转发（`ssh -L / -R / -D`）：每条连接一个常驻 `ssh -N -v` 进程。
//!
//! 跑在 PTY 里是为了复用终端那套凭据自动填充（密码 / 口令 / 跳板机两段登录）。
//! 状态从 `-v` 输出解析（`crate::ssh_tunnel`），经 `ssh_tunnel_status` 事件推给前端。
//! 进程意外退出按指数退避重连；认证失败一类重试无意义的失败直接停住。
//!
//! 🔴 与终端同一安全边界：只经 Tauri IPC 暴露，不注册 MCP 工具；受 `ssh_enabled` 总开关约束。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, State};

use super::ssh_cmds::{
    find_ssh, load_link_parts, passphrase_prompt_in, password_prompt_in, prompt_tail,
    resolve_connect_secrets, ssh_base_args, strip_ansi, SshLink, CREDENTIAL_FILL_WINDOW,
};
use crate::config::ForwardAuto;
use crate::ssh_proxy::PendingCreds;
use crate::ssh_tunnel::{forward_args, is_fatal, TunnelState, TunnelStatus};
use crate::state::{AppState, SshTunnel};

const STATUS_EVENT: &str = "ssh_tunnel_status";
const RETRY_MIN: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(60);

type Killer = Box<dyn ChildKiller + Send + Sync>;
type SharedStatus = Arc<StdMutex<TunnelStatus>>;

/// 一条转发重连时不变的部分。
struct Plan {
    link: SshLink,
    ssh: PathBuf,
    args: Vec<String>,
    data_dir: PathBuf,
    /// 启动时临时输入的密码 / 口令：要留到停止为止，否则断线后没法自动重连。
    password: Option<String>,
    passphrase: Option<String>,
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
    start_tunnel(app, state.inner().clone(), connection_id, password, passphrase).await
}

#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
) -> Result<(), String> {
    stop_and_wait(state.inner(), &connection_id).await;
    let _ = app.emit(STATUS_EVENT, TunnelStatus::stopped(connection_id));
    Ok(())
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
            .filter(|c| c.forward_auto == ForwardAuto::Launch && c.forwards.iter().any(|r| r.enabled))
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
    let (conn, jump) = load_link_parts(&state, &id).await?;
    let rules: Vec<_> = conn.forwards.iter().filter(|r| r.enabled).cloned().collect();
    if rules.is_empty() {
        return Err("这条连接还没有启用的转发规则".into());
    }
    let ssh = find_ssh().ok_or("未检测到系统 OpenSSH 客户端，无法开启端口转发")?;
    let link = SshLink::new(conn, jump)?;
    let mut args = ssh_base_args(&link, "-p");
    args.extend(["-N".into(), "-v".into()]);
    args.extend(forward_args(&rules));
    args.push(format!("{}@{}", link.conn.username, link.conn.host));

    // 重启时必须等旧进程真正退出：它还占着本地端口，新进程会 bind 失败。
    stop_and_wait(&state, &id).await;

    let status = TunnelStatus::new(id.clone(), &rules);
    let tunnel = SshTunnel {
        stop: Arc::new(AtomicBool::new(false)),
        status: Arc::new(StdMutex::new(status.clone())),
        killer: Arc::new(StdMutex::new(None)),
        thread: StdMutex::new(None),
    };
    let plan = Plan {
        link,
        ssh,
        args,
        data_dir: state.data_dir.clone(),
        password: password.filter(|v| !v.is_empty()),
        passphrase: passphrase.filter(|v| !v.is_empty()),
    };
    let (stop, shared, killer, app2) = (
        tunnel.stop.clone(),
        tunnel.status.clone(),
        tunnel.killer.clone(),
        app.clone(),
    );
    let handle = std::thread::spawn(move || supervise(&app2, &plan, &stop, &shared, &killer));
    *tunnel.thread.lock().unwrap() = Some(handle);
    state.ssh_tunnels.insert(id, tunnel);
    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

async fn stop_and_wait(state: &Arc<AppState>, id: &str) {
    let Some(old) = state.halt_ssh_tunnel(id) else {
        return;
    };
    let handle = old.thread.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(h) = handle {
        let _ = tauri::async_runtime::spawn_blocking(move || h.join()).await;
    }
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
        let _ = app.emit(STATUS_EVENT, snap);
    }
}

fn supervise(
    app: &AppHandle,
    plan: &Plan,
    stop: &Arc<AtomicBool>,
    status: &SharedStatus,
    killer: &StdMutex<Option<Killer>>,
) {
    let mut delay = RETRY_MIN;
    loop {
        let fatal = run_once(app, plan, stop, status, killer);
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let (was_up, last) = {
            let s = status.lock().unwrap_or_else(|p| p.into_inner());
            (s.was_up, s.last_error.clone())
        };
        let needs_secret = matches!(fatal, Some(Fatal::NeedsSecret(_)));
        let reason = match fatal {
            Some(Fatal::NeedsSecret(r) | Fatal::Other(r)) => r,
            None => last.unwrap_or_else(|| "SSH 进程已退出".into()),
        };
        if needs_secret || is_fatal(&reason) {
            publish(app, stop, status, |s| {
                s.state = TunnelState::Error;
                s.message = Some(reason);
                s.needs_secret = needs_secret;
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

enum Fatal {
    NeedsSecret(String),
    Other(String),
}

/// 跑一轮 ssh 进程直到它退出。返回不该重试的失败原因；普通退出的原因在 `status.last_error`。
fn run_once(
    app: &AppHandle,
    plan: &Plan,
    stop: &Arc<AtomicBool>,
    status: &SharedStatus,
    killer: &StdMutex<Option<Killer>>,
) -> Option<Fatal> {
    publish(app, stop, status, |s| {
        s.begin_attempt();
        true
    });
    let creds = match resolve_connect_secrets(
        &plan.link,
        &plan.data_dir,
        plan.password.clone(),
        plan.passphrase.clone(),
    ) {
        Ok(c) => c,
        Err(e) => return Some(Fatal::Other(e)),
    };
    // 宽屏：日志行不被 ConPTY 折行，解析按整行来。
    let pair = match native_pty_system().openpty(PtySize {
        rows: 24,
        cols: 400,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return Some(Fatal::Other(format!("打开 PTY 失败：{e}"))),
    };
    let mut cmd = CommandBuilder::new(&plan.ssh);
    cmd.args(&plan.args);
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return Some(Fatal::Other(format!("启动 ssh 失败：{e}"))),
    };
    drop(pair.slave);
    let io = pair
        .master
        .try_clone_reader()
        .and_then(|r| Ok((r, pair.master.take_writer()?)));
    let (reader, writer) = match io {
        Ok(rw) => rw,
        Err(e) => {
            let _ = child.kill();
            return Some(Fatal::Other(format!("获取 PTY 读写端失败：{e}")));
        }
    };
    *killer.lock().unwrap_or_else(|p| p.into_inner()) = Some(child.clone_killer());

    let read_thread = {
        let (app, stop, status) = (app.clone(), stop.clone(), status.clone());
        let own_killer = child.clone_killer();
        std::thread::spawn(move || read_loop(reader, writer, creds, own_killer, &app, &stop, &status))
    };

    loop {
        if !matches!(child.try_wait(), Ok(None)) {
            break;
        }
        if stop.load(Ordering::SeqCst) {
            let _ = child.kill();
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    *killer.lock().unwrap_or_else(|p| p.into_inner()) = None;
    // 与 `spawn_capture` 同一个 Windows 坑：conhost 要等 master 关掉才退，否则 reader 永远等不到 EOF。
    // 留一小段时间让最后几行（往往就是失败原因）冲进管道。
    std::thread::sleep(Duration::from_millis(200));
    drop(pair.master);
    read_thread.join().unwrap_or(None)
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    mut creds: PendingCreds,
    mut killer: Killer,
    app: &AppHandle,
    stop: &AtomicBool,
    status: &SharedStatus,
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
            publish(app, stop, status, |s| s.apply_line(&clean));
            line.clear();
            prompt_done = false;
        }
        if prompt_done || fatal.is_some() {
            continue;
        }
        if let Some(answer) = prompt_answer(&strip_ansi(&line), &mut creds) {
            prompt_done = true;
            match answer {
                Ok(secret) => {
                    let _ = writer.write_all(secret.as_bytes());
                    let _ = writer.write_all(b"\n");
                    let _ = writer.flush();
                }
                Err(f) => {
                    fatal = Some(f);
                    let _ = killer.kill();
                }
            }
        }
    }
    fatal
}

/// 未换行的尾行若是登录提示，给出要填的凭据；填不了就是致命错误——后台转发没有人能手输。
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
        return Some(Err(Fatal::Other(format!(
            "服务器要求交互式输入（{}），后台转发无法应答",
            tail.trim()
        ))));
    };
    Some(secret.ok_or_else(|| {
        Fatal::NeedsSecret("需要密码或密钥口令：请在连接设置里保存，或开启转发时输入".into())
    }))
}
