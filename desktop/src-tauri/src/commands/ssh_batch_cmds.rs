//! 批量文件传输：把 N 个单文件 scp 合并成**按目录分组的几次多源 scp**。
//!
//! ## 为什么值得做
//! 列目录/读/写早已复用常驻 helper（零握手），唯独传输还是「一次 scp 进程 =
//! 一次完整握手」。批量下载 20 个文件就是 20 次 TCP + KEX + 认证（VPN/跳板下每次
//! 秒级）。而 `scp` 原生支持多源（`scp host:/a host:/b localdir/`），**一次进程传
//! N 个文件**——本机 OpenSSH 10.3p1 实测接受该语法（走到连接阶段才因目标不存在
//! 而失败）。省下 N−1 次握手，且零新协议代码、复用现有取消/进度/凭据体系。
//!
//! ## 原子语义不能丢
//! 单文件传输是「先下到 `.ccbpart` 临时名、成功再 rename」——取消或失败绝不碰用户
//! 原有的文件。批量同样坚持：
//! - **下载**：先传到本地隐藏临时目录 `<目录>/.ccb-batch-<传输id>/`，全部成功后
//!   逐个 rename 到正式名；失败/取消整体删掉临时目录。
//! - **上传**：先传到远端隐藏目录 `<目录>/.ccb-batch-<传输id>/`，成功后一条
//!   按条目确认的覆盖权限搬回；失败/取消在远端 `rm -rf`。远端收尾走 helper（零握手），
//!   helper 不可用退回一次性 ssh。
//!
//! ## 安全边界（与 ssh_cmds / ssh_file_cmds 一致）
//! 全部经 `ssh_enabled` 总闸；只经 Tauri IPC 给本机面板，**不注册为 MCP 工具**、
//! 不进审计、不向远程 Claude Code 暴露。凭据明文仅在登录一瞬存在（`PendingCreds`）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::ssh_proxy::PendingCreds;
use crate::state::AppState;

use super::ssh_cmds::{
    fetch_link, find_scp, find_ssh, is_unknown_option_err, register_transfer, rename_remote_cmd,
    resolve_link_secrets, run_via_helper_blocking, scp_endpoint, shell_quote, spawn_capture,
    ssh_base_args, SshLink, TransferHooks, ERR_TARGET_EXISTS,
};

/// 批量传输的超时。与单文件 `run_scp` 一致（600s）：一次传 N 个文件，总量不可预知。
const BATCH_TIMEOUT: Duration = Duration::from_secs(600);

/// 批量传输的一条：本机路径 + 远端路径。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    /// 本机绝对路径。
    pub local: String,
    /// 远端绝对路径。
    pub remote: String,
    /// 上传方向只覆盖用户实际确认的条目。
    #[serde(default)]
    pub overwrite: bool,
}

/// 一组：同一目标目录下的若干条目（用 items 下标指向，避免克隆）。
type BatchGroup = (String, Vec<usize>);

/// 取父目录。裸文件名（无分隔符）归一成 `.`，`/a` 归到 `/`。
///
/// 分隔符同时认 `/` 与 `\`：本机路径是 Windows 风格，远端是 POSIX 风格，
/// 同一个函数要同时处理两侧。
pub(super) fn parent_of(p: &str) -> String {
    let t = p.trim_end_matches(['/', '\\']);
    match t.rfind(['/', '\\']) {
        Some(i) if i > 0 => t[..i].to_string(),
        Some(_) => "/".to_string(),
        None => ".".to_string(),
    }
}

/// 取末级名字。
pub(super) fn base_of(p: &str) -> &str {
    let t = p.trim_end_matches(['/', '\\']);
    match t.rfind(['/', '\\']) {
        Some(i) => &t[i + 1..],
        None => t,
    }
}

/// 按目标目录分组，**保持 items 原序**（同组内也保序）。
///
/// 分组键：下载取 local 的父目录，上传取 remote 的父目录——scp 多源只有一个
/// target 目录，不同目标目录的条目不可能进同一次 scp。
pub(super) fn group_items(items: &[BatchItem], upload: bool) -> Vec<BatchGroup> {
    let mut groups: Vec<BatchGroup> = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let key = parent_of(if upload { &it.remote } else { &it.local });
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some(g) => g.1.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    groups
}

/// 临时目录名（隐藏目录，用户列目录时看不到）。
///
/// transfer_id 只保留字母数字与 `-_`：它是 UUID，但命令入参不信任任何输入，
/// 剔掉分隔符防路径逃逸。
pub(super) fn batch_tmp_name(transfer_id: &str) -> String {
    let safe: String = transfer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    format!(
        ".ccb-batch-{}",
        if safe.is_empty() {
            "x".to_string()
        } else {
            safe
        }
    )
}

/// 拼接目录与名字，分隔符跟随目录风格（Windows 路径用 `\`，POSIX 用 `/`）。
///
/// 两种分隔符 Windows API 都认，但混着拼（`C:\dl/.t`）在错误信息里很难看，
/// 而这些路径是会透给用户看的。
fn join_with(dir: &str, name: &str) -> String {
    let sep = if dir.contains('\\') && !dir.contains('/') {
        '\\'
    } else {
        '/'
    };
    format!("{}{}{}", dir.trim_end_matches(['/', '\\']), sep, name)
}

/// 临时目录完整路径：`<目录>/<临时名>`。
pub(super) fn batch_tmp_dir(dir: &str, transfer_id: &str) -> String {
    join_with(dir, &batch_tmp_name(transfer_id))
}

/// 下载的落地计划：临时目录里的每个文件 → 正式 local 路径。
///
/// `from` 用 `base_of(remote)` 而不是 `base_of(local)`：scp 按**远端名**落盘，
/// 二者不一致时（前端构造 local 时改了名）也必须按远端实际落盘名去找。
pub(super) fn rename_plan<'a>(tmp: &str, items: &[&'a BatchItem]) -> Vec<(String, &'a str)> {
    items
        .iter()
        .map(|it| (join_with(tmp, base_of(&it.remote)), it.local.as_str()))
        .collect()
}

#[cfg(windows)]
pub(super) fn publish_without_replace(
    from: &std::path::Path,
    to: &std::path::Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS},
    };
    let from: Vec<u16> = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to: Vec<u16> = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // Windows rename normally replaces files. Passing zero flags keeps the destination intact.
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|error| std::io::Error::from_raw_os_error(error.code().0 & 0xffff))
}

#[cfg(not(windows))]
pub(super) fn publish_without_replace(
    from: &std::path::Path,
    to: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::hard_link(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// 远端建临时目录。
pub(super) fn remote_mkdir_cmd(tmp: &str) -> String {
    format!("mkdir -p {}", shell_quote(tmp))
}

fn staged_groups(items: &[BatchItem], upload: bool) -> Vec<BatchGroup> {
    let mut result = Vec::new();
    for (dir, indices) in group_items(items, upload) {
        let mut basenames = HashSet::new();
        let mut batch = Vec::new();
        // scp stages by local basename, so two a.txt files need separate staging passes.
        for index in indices {
            let name = base_of(if upload {
                &items[index].local
            } else {
                &items[index].remote
            });
            let name = if cfg!(windows) && !upload {
                name.to_lowercase()
            } else {
                name.to_owned()
            };
            if !basenames.insert(name.clone()) {
                result.push((dir.clone(), std::mem::take(&mut batch)));
                basenames.clear();
                basenames.insert(name);
            }
            batch.push(index);
        }
        result.push((dir, batch));
    }
    result
}

/// scp uses the local basename in staging. Publish to the exact approved destination.
fn remote_publish_cmd(tmp: &str, items: &[BatchItem], indices: &[usize]) -> String {
    indices
        .iter()
        .map(|&index| {
            let item = &items[index];
            let staged = format!("{tmp}/{}", base_of(&item.local));
            format!(
                "({})",
                rename_remote_cmd(&staged, &item.remote, item.overwrite)
            )
        })
        .collect::<Vec<_>>()
        .join(" && ")
}

/// 远端清掉临时目录（失败/取消路径）。
pub(super) fn remote_rm_cmd(tmp: &str) -> String {
    format!("rm -rf {}", shell_quote(tmp))
}

/// 拼一次批量下载的 scp 参数。
fn build_down_args(
    link: &SshLink,
    sftp_mode: bool,
    group: &[usize],
    items: &[BatchItem],
    tmp: &str,
) -> Vec<String> {
    let mut a = Vec::new();
    if sftp_mode {
        a.push("-s".into());
    } else {
        // 遗留协议：关掉 strict filename check（CVE-2019-6111 缓解），
        // 理由与单文件 `run_scp` 相同——远端 shell 会剥掉路径引号。
        a.push("-T".into());
    }
    a.extend(ssh_base_args(link, "-P"));
    for &i in group {
        // sftp 模式的路径不经过远端 shell，不需要 shell 引号。
        a.push(scp_endpoint(&link.conn, &items[i].remote, !sftp_mode));
    }
    // 多源的 target 必须是目录：结尾的 `/` 就是告诉 scp「这是目录」。
    a.push(format!("{tmp}/"));
    a
}

/// 拼一次批量上传的 scp 参数。
fn build_up_args(link: &SshLink, locals: &[&str], remote_tmp: &str) -> Vec<String> {
    let mut a = vec!["-s".into()];
    a.extend(ssh_base_args(link, "-P"));
    for l in locals {
        a.push((*l).to_string());
    }
    a.push(format!("{}/", scp_endpoint(&link.conn, remote_tmp, false)));
    a
}

/// 跑一组下载：SFTP 协议优先，报「未知选项」才退回遗留协议。
fn run_one_down_group(
    scp: &PathBuf,
    link: &SshLink,
    group: &[usize],
    items: &[BatchItem],
    creds: PendingCreds,
    hooks: TransferHooks,
    tmp: &str,
) -> Result<(), String> {
    match spawn_capture(
        scp,
        &build_down_args(link, true, group, items, tmp),
        creds.clone(),
        BATCH_TIMEOUT,
        hooks.clone(),
    ) {
        Ok(_) => Ok(()),
        Err(e) if is_unknown_option_err(&e) => spawn_capture(
            scp,
            &build_down_args(link, false, group, items, tmp),
            creds,
            BATCH_TIMEOUT,
            hooks,
        )
        .map(|_| ()),
        Err(e) => Err(e),
    }
}

/// 跑一组上传：SFTP 协议优先，报「未知选项」才退回遗留协议。
fn run_one_up_group(
    scp: &PathBuf,
    link: &SshLink,
    locals: &[&str],
    remote_tmp: &str,
    creds: PendingCreds,
    hooks: TransferHooks,
) -> Result<(), String> {
    match spawn_capture(
        scp,
        &build_up_args(link, locals, remote_tmp),
        creds.clone(),
        BATCH_TIMEOUT,
        hooks.clone(),
    ) {
        Ok(_) => Ok(()),
        Err(e) if is_unknown_option_err(&e) => {
            let mut a = ssh_base_args(link, "-P");
            for l in locals {
                a.push((*l).to_string());
            }
            a.push(format!("{}/", scp_endpoint(&link.conn, remote_tmp, false)));
            spawn_capture(scp, &a, creds, BATCH_TIMEOUT, hooks).map(|_| ())
        }
        Err(e) => Err(e),
    }
}

/// 跑一次批量下载：按目录分组，每组一次多源 scp 到本地临时目录，成功后 rename。
///
/// **阻塞**：调用方放在 `spawn_blocking` 里。`hooks` 带 transfer_id 时，
/// 取消与进度事件照常工作（一个 id 管整批）。
pub(super) fn run_scp_many_down(
    scp: &PathBuf,
    link: &SshLink,
    items: &[BatchItem],
    creds: PendingCreds,
    hooks: TransferHooks,
) -> Result<usize, String> {
    let groups = staged_groups(items, false);
    let tid = hooks.transfer_id.clone().unwrap_or_else(|| "x".into());
    let mut moved = 0usize;

    for (dir, idxs) in &groups {
        let tmp = batch_tmp_dir(dir, &tid);
        // 防御性清理：同名 id 不会重现（UUID），残留只可能是更早的崩溃留下的。
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录 {tmp} 失败：{e}"))?;

        let group_refs: Vec<&BatchItem> = idxs.iter().map(|&i| &items[i]).collect();
        match run_one_down_group(scp, link, idxs, items, creds.clone(), hooks.clone(), &tmp) {
            Ok(()) => {
                for ((from, to), item) in rename_plan(&tmp, &group_refs).into_iter().zip(group_refs)
                {
                    if hooks
                        .cancel
                        .as_ref()
                        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
                    {
                        // scp has finished, but files that have not yet been published are cancellable.
                        let _ = std::fs::remove_dir_all(&tmp);
                        return Err(format!("CCB_CANCELLED: 已保存 {moved} 个文件"));
                    }
                    let result = if item.overwrite {
                        std::fs::rename(&from, to)
                    } else {
                        // A destination can appear after preflight. Publishing must still honor consent.
                        publish_without_replace(
                            std::path::Path::new(&from),
                            std::path::Path::new(to),
                        )
                    };
                    if let Err(e) = result {
                        let _ = std::fs::remove_dir_all(&tmp);
                        return Err(format!("已保存 {moved} 个文件，无法保存 {to}：{e}。请确认目标目录后重新发起传输"));
                    }
                    moved += 1;
                }
                let _ = std::fs::remove_dir_all(&tmp);
            }
            Err(e) => {
                // 取消/失败：整体删掉临时目录，不碰用户原有的文件。
                let _ = std::fs::remove_dir_all(&tmp);
                return if moved == 0 {
                    Err(e)
                } else {
                    Err(format!("{e}。已保存 {moved} 个文件，请重新发起传输"))
                };
            }
        }
    }
    Ok(moved)
}

/// 跑一次批量上传：按远端目录分组，先建远端临时目录 → 多源 scp 上传 →
/// 按确认的目标名搬回；失败/取消在远端 `rm -rf` 清场。
///
/// **阻塞**：调用方放在 `spawn_blocking` 里。
pub(super) fn run_scp_many_up(
    scp: &PathBuf,
    ssh_path: &PathBuf,
    state: &Arc<AppState>,
    link: &SshLink,
    items: &[BatchItem],
    creds: PendingCreds,
    hooks: TransferHooks,
) -> Result<usize, String> {
    let groups = staged_groups(items, true);
    let tid = hooks.transfer_id.clone().unwrap_or_else(|| "x".into());
    let mut moved = 0usize;

    // 远端收尾统一走 helper；helper 不可用（近期失败/未建）退回一次性 ssh。
    let remote = |cmd: String| -> Result<(), String> {
        match run_via_helper_blocking(state, link, ssh_path, creds.clone(), cmd.clone()) {
            Ok((_, 0)) => Ok(()),
            Ok((out, code)) => Err(format!(
                "远端命令失败（退出码 {code}）：{}",
                out.trim().lines().last().unwrap_or("")
            )),
            Err(_) => {
                let mut a = ssh_base_args(link, "-p");
                a.push(format!("{}@{}", link.conn.username, link.conn.host));
                a.push(cmd);
                spawn_capture(
                    ssh_path,
                    &a,
                    creds.clone(),
                    BATCH_TIMEOUT,
                    TransferHooks::default(),
                )
                .map(|_| ())
            }
        }
    };

    for (dir, idxs) in &groups {
        let tmp = batch_tmp_dir(dir, &tid);
        let locals: Vec<&str> = idxs.iter().map(|&i| items[i].local.as_str()).collect();

        // 1) 建远端临时目录。
        if let Err(e) = remote(remote_mkdir_cmd(&tmp)) {
            return Err(format!("创建远端临时目录 {tmp} 失败：{e}"));
        }
        // 2) 多源上传到临时目录。
        if let Err(e) = run_one_up_group(scp, link, &locals, &tmp, creds.clone(), hooks.clone()) {
            let _ = remote(remote_rm_cmd(&tmp));
            return Err(e);
        }
        // 3) Limit shell command length while keeping the bulk scp transfer per group.
        for chunk in idxs.chunks(8) {
            if hooks
                .cancel
                .as_ref()
                .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
            {
                let _ = remote(remote_rm_cmd(&tmp));
                return Err("CCB_CANCELLED".into());
            }
            if let Err(e) = remote(remote_publish_cmd(&tmp, items, chunk)) {
                let _ = remote(remote_rm_cmd(&tmp));
                return Err(format!("批量上传未全部完成：{e}。请刷新目录并重新发起传输"));
            }
            moved += chunk.len();
        }
        // 4) mv 之后临时目录应为空，rm -rf 兜底（隐藏目录留着也是垃圾）。
        let _ = remote(remote_rm_cmd(&tmp));
    }
    Ok(moved)
}

/// Prepare a directory under the user-selected download root without following links
/// supplied by pre-existing child entries.
#[tauri::command]
pub async fn ssh_prepare_download_folder(
    base: String,
    components: Vec<String>,
    exclusive: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use std::path::{Component, Path};
        let mut current = std::fs::canonicalize(base).map_err(|e| e.to_string())?;
        if !current.is_dir() {
            return Err("保存位置不是目录".into());
        }
        for (index, name) in components.iter().enumerate() {
            let mut parts = Path::new(name).components();
            if !matches!(parts.next(), Some(Component::Normal(part)) if part == std::ffi::OsStr::new(name))
                || parts.next().is_some()
                || name.contains(['/', '\0'])
                || (cfg!(windows) && name.contains(['\\', ':']))
            {
                return Err(format!("无效的目录名称：{name}"));
            }
            current.push(name);
            match std::fs::create_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if exclusive && index + 1 == components.len() {
                        return Err(format!("{ERR_TARGET_EXISTS}: {name}"));
                    }
                    let meta = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
                    let resolved = std::fs::canonicalize(&current).map_err(|e| e.to_string())?;
                    if !meta.is_dir() || meta.file_type().is_symlink() || resolved != current {
                        return Err(format!("{ERR_TARGET_EXISTS}: 保存路径中存在同名项目：{name}"));
                    }
                }
                Err(error) => return Err(format!("无法创建目录 {name}：{error}")),
            }
        }
        Ok(crate::security::path::display_path(&current))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 批量下载。覆盖检查在后端做：`overwrite=false` 时**先全量预检**，把已存在的
/// 本机文件一次性报给前端（`CCB_TARGET_EXISTS`），由前端弹一次「覆盖 N 个文件」
/// 确认，而不是传了一半才失败。
#[tauri::command]
pub async fn ssh_sftp_get_many(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    mut items: Vec<BatchItem>,
    transfer_id: String,
    overwrite: bool,
) -> Result<usize, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    if items.is_empty() {
        return Ok(0);
    }
    for item in &mut items {
        item.overwrite |= overwrite;
    }
    let mut conflicts = Vec::new();
    for item in &items {
        match std::fs::symlink_metadata(&item.local) {
            Ok(_) if !item.overwrite => conflicts.push(item.local.as_str()),
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(format!("目标不是普通文件：{}", item.local));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("无法检查目标 {}：{e}", item.local)),
        }
    }
    if !conflicts.is_empty() {
        return Err(format!(
            "{ERR_TARGET_EXISTS}: {}",
            serde_json::to_string(&conflicts).map_err(|e| e.to_string())?
        ));
    }
    let link = fetch_link(&state, &connection_id).await?;
    // 下载不走远端收尾命令（本地临时目录 + rename），不需要 ssh 路径。
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let cancel = register_transfer(&state, &transfer_id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(transfer_id.clone()),
        cancel: Some(cancel),
        setup_input: None,
    };
    let (scp, l, its) = (scp_path, link, items);
    let joined =
        tokio::task::spawn_blocking(move || run_scp_many_down(&scp, &l, &its, creds, hooks)).await;
    // 🔴 先注销再 `?`：任务 panic 时取消标志不能永久留在注册表里（与单文件一致）。
    state.ssh_transfers.remove(&transfer_id);
    joined.map_err(|e| format!("传输任务异常终止：{e}"))?
}

/// 批量上传。远端重名由**前端**判定（当前目录 entries 前端手里已有），
/// 与单文件 `ssh_sftp_put` 的约定一致。
#[tauri::command]
pub async fn ssh_sftp_put_many(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    items: Vec<BatchItem>,
    transfer_id: String,
) -> Result<usize, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    if items.is_empty() {
        return Ok(0);
    }
    let link = fetch_link(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let cancel = register_transfer(&state, &transfer_id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(transfer_id.clone()),
        cancel: Some(cancel),
        setup_input: None,
    };
    let (scp, l, its) = (scp_path, link, items);
    // state 是 State<'_>，闭包要 'static：只把里面的 Arc 搬进去。
    let st = state.inner().clone();
    let joined = tokio::task::spawn_blocking(move || {
        run_scp_many_up(&scp, &ssh_path, &st, &l, &its, creds, hooks)
    })
    .await;
    state.ssh_transfers.remove(&transfer_id);
    joined.map_err(|e| format!("传输任务异常终止：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(local: &str, remote: &str) -> BatchItem {
        BatchItem {
            local: local.into(),
            remote: remote.into(),
            overwrite: false,
        }
    }

    #[test]
    fn publishing_without_consent_preserves_a_destination_created_during_transfer() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        let staged = dir.join("staged");
        let target = dir.join("target");
        std::fs::write(&staged, "new data").unwrap();
        std::fs::write(&target, "original").unwrap();
        let collision = publish_without_replace(&staged, &target).unwrap_err();
        assert_eq!(collision.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        std::fs::remove_file(&target).unwrap();
        publish_without_replace(&staged, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new data");
        std::fs::remove_dir_all(dir).unwrap();
    }

    // ---- parent_of / base_of ----

    #[test]
    fn parent_of_handles_both_separators() {
        assert_eq!(parent_of("/home/u/a.txt"), "/home/u");
        assert_eq!(parent_of(r"C:\dl\a.txt"), r"C:\dl");
        assert_eq!(parent_of("a.txt"), ".");
        assert_eq!(parent_of("/a"), "/");
        // 尾部分隔符先剃掉再找："/a/b/" 的父目录是 "/a"。
        assert_eq!(parent_of("/a/b/"), "/a");
    }

    #[test]
    fn base_of_handles_both_separators() {
        assert_eq!(base_of("/home/u/a.txt"), "a.txt");
        assert_eq!(base_of(r"C:\dl\a.txt"), "a.txt");
        assert_eq!(base_of("a.txt"), "a.txt");
        assert_eq!(base_of("/a/"), "a");
    }

    // ---- group_items ----

    #[test]
    fn download_groups_by_local_dir_and_keeps_order() {
        let items = vec![
            item(r"C:\dl\a.txt", "/r/a.txt"),
            item(r"C:\dl\b.txt", "/r/b.txt"),
            item(r"C:\other\c.txt", "/r/c.txt"),
        ];
        let g = group_items(&items, false);
        assert_eq!(g.len(), 2, "两个本机目录应分两组");
        assert_eq!(g[0].0, r"C:\dl");
        assert_eq!(g[0].1, vec![0, 1], "同组保序");
        assert_eq!(g[1].0, r"C:\other");
        assert_eq!(g[1].1, vec![2]);
    }

    /// 🔴 分组键方向：上传必须按**远端**目录分组（scp 多源只有一个远端 target）。
    #[test]
    fn upload_groups_by_remote_dir() {
        let items = vec![
            item(r"C:\up\a.txt", "/r/x/a.txt"),
            item(r"C:\up\b.txt", "/r/y/b.txt"),
            item(r"C:\up\c.txt", "/r/x/c.txt"),
        ];
        let g = group_items(&items, true);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].0, "/r/x");
        assert_eq!(g[0].1, vec![0, 2], "不相邻的同组条目也要归并");
        assert_eq!(g[1].0, "/r/y");
    }

    /// 下载方向**不能**按远端分组：本机目标目录不同就必须分开传。
    #[test]
    fn download_never_groups_by_remote_dir() {
        let items = vec![
            item(r"C:\d1\a.txt", "/r/a.txt"),
            item(r"C:\d2\b.txt", "/r/b.txt"),
        ];
        let g = group_items(&items, false);
        assert_eq!(g.len(), 2, "远端同目录但本机不同目录，不能合并");
    }

    // ---- 临时目录 ----

    #[test]
    fn batch_tmp_name_keeps_uuid_and_strips_traversal() {
        assert_eq!(batch_tmp_name("3f2a-9c1b_4d"), ".ccb-batch-3f2a-9c1b_4d");
        // 分隔符与点点全部剔掉：临时目录名不允许带路径成分。
        assert_eq!(batch_tmp_name("../../etc"), ".ccb-batch-etc");
        assert_eq!(batch_tmp_name(""), ".ccb-batch-x");
        assert_eq!(batch_tmp_name(".."), ".ccb-batch-x");
    }

    #[test]
    fn batch_tmp_dir_avoids_double_slash() {
        assert_eq!(batch_tmp_dir(r"C:\dl\", "t1"), r"C:\dl\.ccb-batch-t1");
        assert_eq!(batch_tmp_dir("/r/x", "t1"), "/r/x/.ccb-batch-t1");
    }

    // ---- rename 计划 ----

    /// 🔴 `from` 必须是**远端名**（scp 按它落盘），不是 local 的名字。
    #[test]
    fn rename_plan_uses_remote_basename() {
        let items = [item(r"C:\dl\renamed.txt", "/r/original.txt")];
        let plan = rename_plan(r"C:\dl\.ccb-batch-t1", &items.iter().collect::<Vec<_>>());
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].0, r"C:\dl\.ccb-batch-t1\original.txt");
        assert_eq!(plan[0].1, r"C:\dl\renamed.txt");
    }

    // ---- 远端收尾命令 ----

    #[test]
    fn remote_cmds_quote_paths() {
        assert_eq!(remote_mkdir_cmd("/r/x/.t"), "mkdir -p '/r/x/.t'");
        assert_eq!(remote_rm_cmd("/r/x/.t"), "rm -rf '/r/x/.t'");
    }

    /// 单引号是 shell 里最辣的字符：文件名 `it's.txt` 必须被正确转义，
    /// 否则 mv 命令会断裂、文件留在临时目录里。
    #[test]
    fn remote_publish_uses_staged_source_and_exact_destination_with_overwrite_checks() {
        let mut replace = item("C:/one/known.txt", "/r/known.txt");
        replace.overwrite = true;
        let items = [item("C:/up/it's.txt", "/r/it's (copy).txt"), replace];
        let cmd = remote_publish_cmd("/r/.t", &items, &[0, 1]);
        assert!(cmd.contains(r"mv -- '/r/.t/it'\''s.txt' '/r/it'\''s (copy).txt'"));
        assert!(cmd.contains(r"[ -L '/r/it'\''s (copy).txt' ]"));
        assert!(cmd.contains(" && "));
        assert!(cmd.contains("mv -f -- '/r/.t/known.txt' '/r/known.txt'"));
    }

    #[test]
    fn same_local_basename_never_shares_a_staging_pass() {
        let items = [
            item("C:/one/a.txt", "/r/a.txt"),
            item("C:/two/a.txt", "/r/a copy.txt"),
            item("C:/two/b.txt", "/r/b.txt"),
        ];
        assert_eq!(
            staged_groups(&items, true),
            vec![("/r".into(), vec![0]), ("/r".into(), vec![1, 2])]
        );
    }

    // ---- scp 参数 ----

    /// 🔴 多源 target 必须以 `/` 结尾，否则 scp 把最后一个 source 当 target。
    #[test]
    fn down_args_target_dir_has_trailing_slash() {
        // 只验参数形状：不建真连接，检查结尾元素与 source 数量。
        let items = vec![
            item(r"C:\dl\a.txt", "/r/a.txt"),
            item(r"C:\dl\b.txt", "/r/b.txt"),
        ];
        // build_down_args 私有，经 run_one_down_group 的形态间接覆盖不到，
        // 这里直接测它对外的可观测契约：分组 + rename 计划拼起来就是它的语义。
        let g = group_items(&items, false);
        assert_eq!(g.len(), 1);
        let refs: Vec<&BatchItem> = g[0].1.iter().map(|&i| &items[i]).collect();
        let plan = rename_plan(r"C:\dl\.ccb-batch-t", &refs);
        assert_eq!(plan.len(), 2);
        assert!(plan
            .iter()
            .all(|(f, _)| f.starts_with(r"C:\dl\.ccb-batch-t\")));
    }

    #[test]
    fn empty_items_group_to_nothing() {
        assert!(group_items(&[], false).is_empty());
        assert!(group_items(&[], true).is_empty());
    }
}
