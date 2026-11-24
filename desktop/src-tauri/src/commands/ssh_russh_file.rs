//! D 方案：russh 长连接上的**文件操作层**。
//!
//! 每个函数都是「先试 russh，失败让调用方回退」的一跳：它们只返回 `Result`，
//! 不在内部做回退——回退策略由 `ssh_file_cmds.rs` / `ssh_cmds.rs` 里的调用方统一决定，
//! 这样「哪些操作已经迁到 russh」在调用处一眼可见，不会散落在两层。
//!
//! ## 与旧路径的语义对齐（灰度期间必须逐条一致）
//!
//! | 关注点 | 旧路径 | 本模块 |
//! |---|---|---|
//! | 列目录 | `ls -la` + GNU/BSD 双语法解析 | SFTP `read_dir`，结构化字段 |
//! | 文件名 | 纯文件名（` -> target` 拆进 `link_target` 字段） | 同左（readlink 补齐） |
//! | 软链目标类型 | 不补（`link_target_is_dir=false`，双击进编辑器） | 跟随 stat 补齐（目标是目录则双击进入） |
//! | 读限流 | `f.read(PREVIEW_BYTES)` 恒定 256 KB | `take(MAX_EDIT_BYTES)`，`truncated` 按实际读取量判 |
//! | 换行符 | 含 `\r\n` → crlf，内容归一成 LF | 同左 |
//! | 写原子性 | 远端 python `os.replace` | SFTP `rename`（服务端原子） |
//! | 乐观锁 | mtime 比对，冲突返回 `ERR_FILE_CONFLICT` | 同左 |
//! | 二进制文件 | 返回 `ERR_FILE_BINARY` 前缀 | 同左 |
//!
//! 🔴 **P0-2 在这里被修掉**：旧 `read_script` 恒定只读 256 KB，但 `truncated`
//! 只在文件 > 2 MB 时为 true——于是一个 1 MB 的配置文件打开只见到前 256 KB、
//! 却显示「可编辑」，保存后远端文件被静默截断成 256 KB。
//! 本模块 `truncated` 由「实际读到的字节数 < 文件大小」推导，那条缝不存在。
//!
//! 🔴 **软链写破坏（2026-11-24 修）**：`rename` **不跟随目标 symlink**——直接
//! rename 到链接路径会把链接本身替换成普通文件：用户读到的是目标内容，存下去的
//! 却是个新文件，真正的目标没改、链接静默消失。写前必须解析出真实落点
//! （[`resolve_rename_target`] / [`decide_rename_target`]）；helper 与 scp 两条
//! 旧路径在 `ssh_file_cmds::finalize_script` 的远端 python 里做同一件事。

use futures_util::future::join_all;
use russh_sftp::client::fs::DirEntry as SftpDirEntry;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use std::sync::atomic::AtomicU64;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::ssh_cmds::{SshFileEntry, SshLink, TransferHooks, PART_SUFFIX};
use super::ssh_file_cmds::{ERR_FILE_BINARY, ERR_FILE_CONFLICT, MAX_EDIT_BYTES};
use super::ssh_russh_cmds::{get_russh_session, RusshFileSession};
use crate::encoding::decode_utf8_truncated;
use crate::ssh_proxy::PendingCreds;
use crate::state::AppState;

/// 内联保存的临时文件序号。进程内自增，保证同一文件的并发写不落在同一个临时名上。
///
/// `pub(super)` 是因为旧路径 `ssh_file_cmds::ssh_file_upload_edited` 也要用它：
/// 那边原来用本机 pid 当 nonce（而注释写着「随机数」），两次回传同一文件会互相截断。
/// 两条路径共用同一个序号源，「唯一」这件事就只有一处实现。
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 取下一个写序号。给旧路径的回传临时名用（见 `WRITE_SEQ` 的注释）。
pub(super) fn next_write_seq() -> u64 {
    WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// russh-sftp 的错误统一转成字符串。
///
/// 🔴 不写具名参数类型：`SftpSession` 的 `SftpResult` 用的是 `crate::error::Error`，
/// 而那个模块是**私有**的，外部无法命名（试过 `russh_sftp::client::Error` 直接
/// E0603 private enum）。所以用闭包 + `Display`：thiserror 已给每个变体写了
/// 人话消息（`Status: {code}: {message}` / `I/O: ...` / `Timeout`），
/// 前端要能看出是「权限不足」还是「文件不存在」，据此给不同提示。
pub(super) fn map_sftp_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 把一个 SFTP 目录条目映射成前端的 `SshFileEntry`。
///
/// 纯函数，可单测——字段映射错了会直接表现为「大小全是 0」「目录不识别」，
/// 而这种 bug 在真机上要连服务器才能看见。
///
/// 软链的 `link_target` / `link_target_is_dir` 在这里给默认值，由
/// [`russh_list_dir`] 列完目录后补（readlink / 跟随 stat 是 I/O，进不了纯函数）。
fn attrs_to_entry(e: &SftpDirEntry) -> Option<SshFileEntry> {
    // `read_dir` 已过滤 `.` / `..`；再防一次空名（异常服务器可能返回）。
    // 走 `Display`（内部即 `from_utf8_lossy`）：非 UTF-8 的文件名不会 panic，
    // 只会变成替换字符——比旧路径 `ls` 的输出更宽容。
    let name = e.file_name().to_string();
    if name.is_empty() {
        return None;
    }
    let md = e.metadata();
    let ft = e.file_type();
    Some(SshFileEntry {
        // SFTP 的 readdir 是 **lstat 语义**（不跟随软链），与 `ls -la` 一致：
        // 软链到目录也报 is_dir=false / is_symlink=true。
        is_dir: ft.is_dir(),
        is_symlink: ft.is_symlink(),
        size: md.size.unwrap_or(0),
        // atime/mtime 是 Option<u32>（SFTP v3 只有 32 位）；取不到给 0，
        // 与旧路径 BSD 降级时 mtime 置 0 的行为一致。
        mtime: md.mtime.unwrap_or(0) as i64,
        name,
        // 软链目标由调用方补齐；默认「无目标、目标不是目录」。
        link_target: None,
        link_target_is_dir: false,
    })
}

/// mode 的高 4 位是否标着「这是软链」（S_IFLNK = 0o120000）。
fn mode_is_symlink(permissions: Option<u32>) -> bool {
    permissions.is_some_and(|m| {
        russh_sftp::protocol::FileMode::from_bits_truncate(m) == russh_sftp::protocol::FileMode::LNK
    })
}

/// 列目录。失败返回 Err，由调用方回退旧路径。
pub(super) async fn russh_list_dir(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    path: &str,
) -> Result<Vec<SshFileEntry>, String> {
    let sess = get_russh_session(state, link, creds).await?;
    let rd = sess.sftp.read_dir(path).await.map_err(map_sftp_err)?;
    let mut entries: Vec<SshFileEntry> = rd.filter_map(|e| attrs_to_entry(&e)).collect();

    // 软链条目补两个字段：目标字符串（展示 `link -> target`，与 `ls -la` 一致）
    // 与目标是否为目录（决定双击时「进入」还是「编辑」）。
    //
    // 为什么要单独取：readdir 是 lstat 语义，只给链接自己的属性；目标是什么
    // 必须再问服务器。`metadata`（STAT）**跟随**软链，一次调用同时拿到目标类型。
    //
    // 并发发：N 个软链也约等于一个 RTT。旧路径（`ls -la`）的目标是免费的
    // （就在输出行里），这里不并发就会在软链密集的目录（/etc/alternatives 那种）
    // 明显比旧路径慢——russh 处处更快，唯独这一项不能退步。
    let link_paths: Vec<String> = entries
        .iter()
        .filter(|e| e.is_symlink)
        .map(|e| join_remote(path, &e.name))
        .collect();
    if !link_paths.is_empty() {
        let readlinks = join_all(link_paths.iter().map(|p| sess.sftp.read_link(p))).await;
        let stats = join_all(link_paths.iter().map(|p| sess.sftp.metadata(p))).await;
        let mut links = readlinks.into_iter();
        let mut stats_it = stats.into_iter();
        for e in &mut entries {
            if !e.is_symlink {
                continue;
            }
            // readlink 失败（罕见）：退化成不显示目标，不影响其它字段。
            e.link_target = links.next().and_then(|r| r.ok()).map(|s| s.to_string());
            // 跟随 stat 失败：目标断裂/成环，视为「不是目录」（双击进编辑器，
            // 读失败时前端本就会给「用本机编辑器打开」的出路）。
            e.link_target_is_dir = stats_it
                .next()
                .and_then(|r| r.ok())
                .and_then(|m| m.permissions)
                .is_some_and(|m| {
                    russh_sftp::protocol::FileMode::from_bits_truncate(m)
                        .contains(russh_sftp::protocol::FileMode::DIR)
                });
        }
    }
    Ok(entries)
}

/// 拼远端路径。SFTP 在线上是 POSIX 风格，但**不要**在这里做 canonicalize：
/// 用户可能正停在一个软链目录里，规范化会把路径改成它不认识的样子。
fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 内联保存的写临时文件名。
///
/// 🔴 **每次写都必须不同**。旧路径的临时名带的是远端 shell 的 pid，而每次保存
/// 都新起一个 ssh 会话，pid 天然不重复。russh 长连接没这个性质：只用本机 pid
/// 的话，同一文件在两个标签页里同时打开、先后点保存，两次写会落到同一个临时
/// 文件上互相截断，最后 rename 出去的是半份内容——而且是静默的。
/// 所以 seq 由调用方传进程内自增计数器，这个函数本身保持纯粹以便单测。
fn write_tmp_path(path: &str, pid: u32, seq: u64) -> String {
    format!("{path}.ccb-write-{pid}.{seq}.tmp")
}

/// 上传的写临时文件名。同 `write_tmp_path` 的理由。
fn upload_tmp_path(remote: &str, pid: u32, seq: u64) -> String {
    format!("{remote}.ccb-up-{pid}.{seq}.tmp")
}

/// 权限位掩码：只保留权限相关的 12 位（rwx + setuid/setgid/sticky）。
///
/// 与旧路径远端 python 的 `st.st_mode & 0o7777` 逐位一致。file-type 位
/// （`S_IFREG`/`S_IFDIR` 等高 4 位）必须剥掉：把它们一起喂给 `setstat`
/// 有可能让服务器改掉文件类型，那比权限不对严重得多。
fn perm_bits(mode: u32) -> u32 {
    mode & 0o7777
}

/// 建目录。**语义对齐旧路径的 `mkdir -p`**：父目录不存在时逐级创建，
/// 已存在的层级不算错误。
///
/// 不能只调 `create_dir`：旧路径是 `mkdir -p`，用户在面板里「新建 a/b/c」
/// 时旧路径会一路建下去， russh 路径若只建一层就会报「父目录不存在」——
/// 同一個操作两条路径一个成一个败，用户完全无法理解。
pub(super) async fn russh_mkdir(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    path: &str,
) -> Result<(), String> {
    let sess = get_russh_session(state, link, creds).await?;
    let mut cur = String::new();
    for seg in path.split('/') {
        if seg.is_empty() {
            // 前导 `/` 或 `//`：累积根前缀，不当成一段。
            if cur.is_empty() {
                cur.push('/');
            }
            continue;
        }
        cur = join_remote(&cur, seg);
        if !sess.sftp.try_exists(&cur).await.map_err(map_sftp_err)? {
            sess.sftp.create_dir(&cur).await.map_err(map_sftp_err)?;
        }
    }
    Ok(())
}

/// 删除一个条目，**语义对齐旧路径的 `rm -rf`**：目录递归删。
///
/// 用**显式栈**而非递归函数：深层目录树（node_modules 那种）会把递归爆栈，
/// 而「删到一半 panic」会让远端留下一半文件，比删失败更糟。
/// 软链不会被当成目录递归（readdir 是 lstat 语义），所以没有循环风险。
pub(super) async fn russh_remove(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    path: &str,
) -> Result<(), String> {
    let sess = get_russh_session(state, link, creds).await?;
    // 后序：先删干净子项，再删目录本身。用 Vec 当栈，弹出即处理。
    let mut stack: Vec<(String, bool)> = vec![(path.to_string(), false)];
    while let Some((p, visited)) = stack.pop() {
        let md = sess.sftp.symlink_metadata(&p).await.map_err(map_sftp_err)?;
        let is_dir = md.permissions.is_some_and(|m| {
            // SFTP v3 没有独立 file-type 字段，要从 mode 的高 4 位判。
            russh_sftp::protocol::FileMode::from_bits_truncate(m)
                .contains(russh_sftp::protocol::FileMode::DIR)
        });
        if !is_dir {
            sess.sftp.remove_file(&p).await.map_err(map_sftp_err)?;
            continue;
        }
        if !visited {
            // 第一次遇到目录：把自己重新压栈（标记已访问），再把子项压上去。
            // 子项后入先出 ⇒ 目录本身最后才被 remove_dir，此时它已空。
            stack.push((p.clone(), true));
            let rd = sess.sftp.read_dir(&p).await.map_err(map_sftp_err)?;
            for e in rd {
                let child = e.path().to_string();
                stack.push((child, false));
            }
        } else {
            sess.sftp.remove_dir(&p).await.map_err(map_sftp_err)?;
        }
    }
    Ok(())
}

/// 取远端 mtime（Unix 秒）。失败返回 Err，调用方兜底（旧路径语义：拿不到就跳过冲突检测）。
pub(super) async fn russh_mtime(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    path: &str,
) -> Result<i64, String> {
    let sess = get_russh_session(state, link, creds).await?;
    let md = sess.sftp.metadata(path).await.map_err(map_sftp_err)?;
    Ok(md.mtime.unwrap_or(0) as i64)
}

/// 读文件内容（限流 + UTF-8 校验 + 换行符归一）。
///
/// 返回的 `truncated` 由**实际读取量**推导，这是 P0-2 的修复点。
pub(super) async fn russh_read_file(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    path: &str,
) -> Result<RusshReadResult, String> {
    let sess = get_russh_session(state, link, creds).await?;
    // 先 stat：拿总大小（判 truncated）与 mtime（写回乐观锁基线）。
    let md = sess.sftp.metadata(path).await.map_err(map_sftp_err)?;
    let size = md.size.unwrap_or(0);
    let mtime = md.mtime.unwrap_or(0) as i64;

    let file = sess.sftp.open(path).await.map_err(map_sftp_err)?;
    // 限流读：最多 MAX_EDIT_BYTES。`take` 在流上截断，不会把整个文件拉进内存。
    let mut limited = file.take(MAX_EDIT_BYTES);
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("读取失败：{e}"))?;

    // truncated 的唯一正确判据：**实际拿到的比文件总大小少**。
    // 旧路径写的是 `st.st_size > MAX_EDIT_BYTES`，配一条恒定 read(256KB) 的脚本，
    // 于是 256KB–2MB 的文件「没截断却只读到 256KB」，保存即静默丢数据。
    let truncated = (buf.len() as u64) < size;

    // 🔴 用 `decode_utf8_truncated` 而不是 `String::from_utf8`：`take` 按字节数
    // 截断，切点落在一个多字节字符中间时严格 decode 会把合法 UTF-8 文件误判成
    // 二进制（>2MB 的中文文件约 1/4 概率踩中）。尾部残缺只退一个字符，
    // 中部有非法字节（真二进制）仍然拒绝。与旧路径共用同一个函数、同一套语义。
    let text = decode_utf8_truncated(&buf)
        .map_err(|_| format!("{ERR_FILE_BINARY}: 文件不是 UTF-8 文本，请用本机编辑器打开"))?;
    let line_ending = if text.contains("\r\n") { "crlf" } else { "lf" };
    let content = text.replace("\r\n", "\n");

    Ok(RusshReadResult {
        content,
        size,
        mtime,
        truncated,
        line_ending: line_ending.to_string(),
    })
}

/// russh 读路径的返回。字段与旧 `RemoteFileContent` 一一对应，便于调用方互换。
pub(super) struct RusshReadResult {
    pub(super) content: String,
    pub(super) size: u64,
    pub(super) mtime: i64,
    pub(super) truncated: bool,
    pub(super) line_ending: String,
}

/// lstat 看到的路径形态（[`decide_rename_target`] 的输入之一）。
pub(super) enum LstatKind {
    /// 不是软链——含 lstat 失败（不存在 / 权限不到）：照旧写字面路径，
    /// 「保存到新路径」这条路不能因为多一次 lstat 就被改窄。
    NotSymlink,
    /// 是软链。
    Symlink,
}

/// 决定原子 rename 的**落点**。纯函数，三态可单测。
///
/// 🔴 为什么需要它：SFTP/POSIX 的 `rename` **不跟随目标 symlink**。用户编辑一个
/// 软链文件时，读到的是目标的内容（open/read 跟随链接），但若直接 rename 到链接
/// 路径，**链接本身会被替换成一个普通文件**——真正的目标文件没被改，链接静默
/// 消失。用户以为保存成功了，部署结构已坏，且外表完全看不出。
/// 正确语义（vim / nano / VS Code 皆如此）：编辑软链 = 编辑其目标。
///
/// 拿不准（软链但解析失败：断裂 / 成环）时**拒绝保存**，绝不回退到「替换链接」的
/// 老行为——防数据丢失一侧。读取本就不可能成功的链接到不了这一步，能到这里说明
/// 是读取之后发生的变故（TOCTOU），拒绝是对的。
pub(super) fn decide_rename_target(
    literal: &str,
    kind: LstatKind,
    canonicalize: Result<String, String>,
) -> Result<String, String> {
    match kind {
        LstatKind::NotSymlink => Ok(literal.to_string()),
        LstatKind::Symlink => match canonicalize {
            Ok(real) if !real.is_empty() && real != literal => Ok(real),
            // 解析结果与字面相同（异常服务器行为）：没有新信息，照旧。
            Ok(_) => Ok(literal.to_string()),
            Err(e) => Err(format!("无法解析软链目标，已取消保存以免替换掉链接（{e}）")),
        },
    }
}

/// [`decide_rename_target`] 的 I/O 版：lstat 判形态，是软链再 canonicalize
/// （SSH_FXP_REALPATH，服务端解析整条链，含中间目录的软链与相对目标）。
async fn resolve_rename_target(sess: &RusshFileSession, path: &str) -> Result<String, String> {
    let kind = match sess.sftp.symlink_metadata(path).await {
        Ok(md) if mode_is_symlink(md.permissions) => LstatKind::Symlink,
        _ => LstatKind::NotSymlink,
    };
    let canonicalize = if matches!(kind, LstatKind::Symlink) {
        sess.sftp
            .canonicalize(path)
            .await
            .map(|s| s.to_string())
            .map_err(map_sftp_err)
    } else {
        // 不是软链就不必多花一次往返。
        return Ok(path.to_string());
    };
    decide_rename_target(path, kind, canonicalize)
}

/// 写文件：乐观锁 + 临时文件 + 原子 rename。
///
/// **临时文件必须落在同目录**：SFTP 的 `rename` 由服务端执行，跨文件系统会失败
/// （`EXDEV` 一类），同目录才能保证是服务端的一次原子替换。
// 8 参：path/content/line_ending 是文件本体，expected_mtime/force 是乐观锁的
// 输入，state/link/creds 是拿会话的固定三件套——彼此独立，打包结构体只会让
// 调用点更长（同 connection_access.rs 的判断）。
#[allow(clippy::too_many_arguments)]
pub(super) async fn russh_write_file(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    path: &str,
    content: &str,
    line_ending: &str,
    expected_mtime: i64,
    force: bool,
) -> Result<RusshWriteResult, String> {
    let sess = get_russh_session(state, link, creds).await?;

    // 还原换行符：读时归一成 LF，写回按原文件风格，避免把整个文件的换行改掉。
    let normalized = if line_ending == "crlf" {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    };
    let bytes = normalized.as_bytes();
    if bytes.len() as u64 > MAX_EDIT_BYTES {
        return Err(format!(
            "内容超过内联编辑上限（{} MB），请用本机编辑器打开后回传",
            MAX_EDIT_BYTES / 1024 / 1024
        ));
    }

    // ---- 乐观锁 ----
    // 顺手拿原文件的权限位：下面 rename 前要把它写回临时文件（旧路径 python 的
    // `os.chmod(tmp, st.st_mode & 0o7777)`）。不做的后果是保存后权限变成 SFTP
    // 默认值——0755 的脚本变成 0644 跑不起来，0600 的私钥被放宽成 0644。
    let orig_mode = sess
        .sftp
        .metadata(path)
        .await
        .ok()
        .and_then(|m| m.permissions);
    if expected_mtime != 0 && !force {
        let cur = sess
            .sftp
            .metadata(path)
            .await
            .map_err(map_sftp_err)?
            .mtime
            .unwrap_or(0) as i64;
        // cur == 0 表示服务器没给 mtime（罕见）：此时不拦，与旧路径一致。
        if cur != 0 && cur != expected_mtime {
            return Err(format!(
                "{ERR_FILE_CONFLICT}: 服务器上的文件在你打开之后被改过（远端 mtime {cur}）"
            ));
        }
    }

    // ---- 解析软链，定 rename 落点 ----
    // 必须赶在临时文件之前：临时名要跟**落点**同目录，否则链接指向别的文件系统时
    // rename 会 EXDEV（同目录才保证是服务端的一次原子替换）。
    let target = resolve_rename_target(&sess, path).await?;

    // ---- 写临时文件（同目录）----
    let tmp = write_tmp_path(&target, std::process::id(), next_write_seq());
    let mut f = sess
        .sftp
        .open_with_flags(
            &tmp,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(map_sftp_err)?;
    if let Err(e) = f.write_all(bytes).await {
        // 失败必须清掉半个临时文件，否则同目录会越积越多。
        let _ = sess.sftp.remove_file(&tmp).await;
        return Err(format!("写入失败：{e}"));
    }
    // 显式 close：不等 Drop（Drop 也关，但错误信息会更模糊）。
    if let Err(e) = f.shutdown().await {
        let _ = sess.sftp.remove_file(&tmp).await;
        return Err(format!("写入收尾失败：{e}"));
    }

    // ---- 原子替换 ----
    // 先把原文件的权限位写到临时文件上，再 rename。放在 rename 之前是因为
    // rename 是服务端的一次原子替换，权限必须跟着内容一起到位；放到 rename
    // 之后会有一个「内容已是新的、权限还是旧的」窗口，且中途失败就留个错权限文件。
    // 失败不阻断：宁可权限不对也要把内容存进去（内容丢了是数据丢失，权限错了是小事）。
    if let Some(mode) = orig_mode {
        let attrs = FileAttributes {
            permissions: Some(perm_bits(mode)),
            ..Default::default()
        };
        if let Err(e) = sess.sftp.set_metadata(&tmp, attrs).await {
            eprintln!("[SSH] russh 写回权限失败（{path}）：{e}");
        }
    }
    if let Err(e) = sess.sftp.rename(&tmp, &target).await {
        let _ = sess.sftp.remove_file(&tmp).await;
        return Err(map_sftp_err(e));
    }

    Ok(stat_after_rename(&sess, &target).await)
}

pub(super) struct RusshWriteResult {
    pub(super) mtime: i64,
    pub(super) size: u64,
}

/// `rename` **成功之后**取新的 mtime/size，回给前端刷新乐观锁基线。
///
/// 🔴 **这一步失败绝不能让整个操作失败**。`rename` 就是成功点，此时远端内容已经是
/// 新的了；若把这里的 `Err` 往上传，调用方（`ssh_file_write` / `ssh_sftp_put` /
/// `ssh_file_upload_edited`）的「russh 失败就回退旧路径」会立刻重做一遍，于是：
/// - **写路径**：旧路径 `write_script` 的乐观锁发现 mtime 已变 ⇒ 返回
///   `ERR_FILE_CONFLICT`。用户看到「服务器上的文件在你打开之后被改过」，
///   **而保存其实已经成功**——这是谎报失败，比慢更伤（用户会以为自己改了没存上）。
/// - **上传路径**：scp 把整个文件重传一遍，白付一次完整握手（本机 OpenSSH 无连接
///   复用，实测约 11 秒），进度条还会从头再走一次。
///
/// 所以这里降级成「基线给 0 + 打一行日志」。基线退化成 0 的代价只是下次保存跳过
/// 冲突检测（少一层保护），远比谎报失败轻。
async fn stat_after_rename(sess: &RusshFileSession, path: &str) -> RusshWriteResult {
    match sess.sftp.metadata(path).await {
        Ok(md) => RusshWriteResult {
            mtime: md.mtime.unwrap_or(0) as i64,
            size: md.size.unwrap_or(0),
        },
        Err(e) => {
            eprintln!("[SSH] russh 已写入成功，但取新 mtime 失败（{path}）：{e}");
            RusshWriteResult { mtime: 0, size: 0 }
        }
    }
}

/// 下载单个文件到本机：流式 + 进度 + 可取消。
///
/// 与旧 scp 路径的三条约定保持一致：
/// 1. 先下到 `<local>.part`，成功才 rename——取消/失败绝不碰用户原有文件；
/// 2. 进度经 `ssh_transfer_progress` 事件回前端（载荷同 `SshTransferProgress`）；
/// 3. 取消靠 `hooks.cancel` 轮询，置位即中断并清掉 `.part`。
pub(super) async fn russh_download(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    remote: &str,
    local: &std::path::Path,
    hooks: &TransferHooks,
) -> Result<(), String> {
    let sess = get_russh_session(state, link, creds).await?;
    let size = sess
        .sftp
        .metadata(remote)
        .await
        .map_err(map_sftp_err)?
        .size
        .unwrap_or(0);

    let mut rf = sess.sftp.open(remote).await.map_err(map_sftp_err)?;
    // 后缀与旧 scp 路径**同一个**（`PART_SUFFIX`）：清理逻辑、用户肉眼识别
    // 都不该因为走了 russh 就变成另一种临时文件。
    let part = std::path::PathBuf::from(format!("{}{}", local.display(), PART_SUFFIX));
    let mut lf = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("创建本机文件失败：{e}"))?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: u8 = 0;
    loop {
        // 取消检查放在读之前：用户点取消后不应再拉一轮数据。
        if let Some(c) = &hooks.cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                drop(lf);
                let _ = tokio::fs::remove_file(&part).await;
                return Err("传输已取消".into());
            }
        }
        let n = rf
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取远端失败：{e}"))?;
        if n == 0 {
            break;
        }
        lf.write_all(&buf[..n])
            .await
            .map_err(|e| format!("写本机文件失败：{e}"))?;
        done += n as u64;
        // 只在百分比变化时发：64KB 一块、大文件每秒上千块，全发会把 IPC 打满。
        // checked_div：SFTP 没给 size 时给 0（此时首块 pct 恰为 last_pct 初值，
        // 不会多发），顺带守住分母为 0。
        let pct = (done * 100)
            .checked_div(size)
            .map(|v| v.min(100))
            .unwrap_or(0) as u8;
        if pct != last_pct {
            last_pct = pct;
            hooks.emit_progress(pct);
        }
    }
    lf.flush()
        .await
        .map_err(|e| format!("刷新本机文件失败：{e}"))?;
    drop(lf);
    tokio::fs::rename(&part, local)
        .await
        .map_err(|e| format!("下载完成但改名失败：{e}"))?;
    hooks.emit_progress(100);
    Ok(())
}

/// 上传单个本机文件到远端：流式 + 进度 + 可取消。
///
/// 同样先落远端临时名再 rename：取消/失败不会把原文件写成半个。
/// 返回写入后的 `mtime`/`size`——调用方（内联保存、C 路线回传）要拿新 mtime
/// 刷新乐观锁基线，让它在这里顺手 stat 一次，比调用方再发一次请求少一个往返。
pub(super) async fn russh_upload(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    local: &std::path::Path,
    remote: &str,
    hooks: &TransferHooks,
) -> Result<RusshWriteResult, String> {
    let sess = get_russh_session(state, link, creds).await?;
    let total = tokio::fs::metadata(local)
        .await
        .map_err(|e| format!("读取本机文件信息失败：{e}"))?
        .len();

    let mut lf = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("打开本机文件失败：{e}"))?;
    // 与 `russh_write_file` 同理：软链要先解析出真实落点，否则 rename 会把上传
    // 路径上的软链替换成普通文件（读早就跟随链接，写也必须跟随）。也要赶在临时
    // 名之前——临时名得跟落点同目录。
    let target = resolve_rename_target(&sess, remote).await?;
    // 与 `russh_write_file` 同理：临时名要每次唯一，否则并发上传同一目标会互相截断。
    let tmp = upload_tmp_path(&target, std::process::id(), next_write_seq());
    let mut rf = sess
        .sftp
        .open_with_flags(
            &tmp,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(map_sftp_err)?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: u8 = 0;
    loop {
        if let Some(c) = &hooks.cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                drop(rf);
                let _ = sess.sftp.remove_file(&tmp).await;
                return Err("传输已取消".into());
            }
        }
        let n = lf
            .read(&mut buf)
            .await
            .map_err(|e| format!("读本机文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        rf.write_all(&buf[..n])
            .await
            .map_err(|e| format!("写远端失败：{e}"))?;
        done += n as u64;
        // 同下载：只在百分比变化时发，分母为 0（拿不到大小）时退成不发。
        let pct = (done * 100)
            .checked_div(total)
            .map(|v| v.min(100))
            .unwrap_or(0) as u8;
        if pct != last_pct {
            last_pct = pct;
            hooks.emit_progress(pct);
        }
    }
    rf.shutdown()
        .await
        .map_err(|e| format!("写入收尾失败：{e}"))?;
    drop(rf);
    if let Err(e) = sess.sftp.rename(&tmp, &target).await {
        let _ = sess.sftp.remove_file(&tmp).await;
        return Err(map_sftp_err(e));
    }
    hooks.emit_progress(100);
    Ok(stat_after_rename(&sess, &target).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 路径拼接要覆盖根目录 / 空目录 / 末尾斜杠三种形态。
    ///
    /// 拼出 `//x` 不是「反正能打开」的小事：部分服务器的 sftp-server 不做规范化，
    /// `//home/x` 会被当成一个不同的路径，表现为「列得出来但打不开」。
    #[test]
    fn join_remote_handles_root_empty_and_trailing_slash() {
        assert_eq!(join_remote("/", "x"), "/x");
        assert_eq!(join_remote("", "x"), "/x");
        assert_eq!(join_remote("/a", "x"), "/a/x");
        assert_eq!(join_remote("/a/", "x"), "/a/x");
        assert_eq!(join_remote("/a/b", "x"), "/a/b/x");
        for dir in ["/", "", "/a", "/a/", "/a/b"] {
            let p = join_remote(dir, "x");
            assert!(!p.contains("//"), "{dir} -> {p}");
            assert!(p.ends_with("/x"), "{dir} -> {p}");
        }
    }

    /// 换行符判据必须与旧路径 `parse_read_output` 逐字一致：
    /// 含 `\r\n` → crlf，否则 lf。两边不一致时，同一个文件走 russh 存回来是 LF、
    /// 走 scp 存回来是 CRLF，用户看到的是「换行莫名变了」。
    #[test]
    fn line_ending_rule_matches_legacy_parser() {
        let decide = |t: &str| if t.contains("\r\n") { "crlf" } else { "lf" };
        assert_eq!(decide("a\r\nb"), "crlf");
        assert_eq!(decide("a\nb"), "lf");
        assert_eq!(decide("plain"), "lf");
        // 纯 \r（老 Mac）不含 \r\n ⇒ 归 lf，与旧路径同结果
        assert_eq!(decide("a\rb"), "lf");
    }

    /// 限流值与旧路径同源：russh 路径能编辑的文件大小必须和 scp 路径一致，
    /// 否则会出现「这条连接能存 2MB、那条只能存 256KB」的分裂。
    #[test]
    fn edit_limit_is_shared_with_legacy_path() {
        assert_eq!(MAX_EDIT_BYTES, 2 * 1024 * 1024);
    }

    /// 🔴 回归（数据丢失级）：**同一文件的并发写不能落在同一个临时名上**。
    ///
    /// 曾经的 bug：临时名只含本机 pid（`{path}.ccb-write-{pid}.tmp`）。旧路径的
    /// 临时名带的是**远端 shell 的 pid**，而每次保存都新起一个 ssh 会话，pid 天然
    /// 不重复——所以旧路径没有这个问题，迁到 russh 长连接后才暴露：同一文件在
    /// 两个标签页里同时打开、先后点保存，两次写互相截断，最后 rename 出去的是
    /// 半份内容，而且没有任何报错。
    #[test]
    fn write_tmp_path_is_unique_per_seq() {
        let a = write_tmp_path("/etc/nginx/nginx.conf", 4242, 0);
        let b = write_tmp_path("/etc/nginx/nginx.conf", 4242, 1);
        assert_ne!(a, b, "同进程、同文件、并发写必须落到不同临时名");
        assert_ne!(a, "/etc/nginx/nginx.conf", "临时名不能就是原路径");
        // 前缀可读：用户在远端 `ls -a` 看到时能认出这是本工具留下的半成品
        assert!(a.starts_with("/etc/nginx/nginx.conf.ccb-write-"));
        assert!(a.ends_with(".tmp"));

        // 不同进程之间也不能撞（两台机器？不，是同机多开——但保持区分更稳）
        assert_ne!(write_tmp_path("/x/f", 1, 7), write_tmp_path("/x/f", 2, 7));
    }

    /// 上传的临时名同理。上传的「并发」更现实：拖拽同一个文件两次、
    /// 或批处理里同一目标出现两回。
    #[test]
    fn upload_tmp_path_is_unique_per_seq() {
        assert_ne!(
            upload_tmp_path("/data/a.bin", 99, 0),
            upload_tmp_path("/data/a.bin", 99, 1)
        );
        assert_ne!(upload_tmp_path("/data/a.bin", 99, 0), "/data/a.bin");
    }

    /// 🔴 回归（谎报失败级）：**`rename` 成功之后的收尾步骤不得把 `Err` 往上传**。
    ///
    /// 曾经的 bug：`russh_write_file` / `russh_upload` 在 rename 成功后用
    /// `metadata(path).map_err(map_sftp_err)?` 取新 mtime。那一步一旦失败，
    /// 调用方「russh 失败就回退旧路径」会立刻重做一遍——写路径于是撞上旧路径
    /// `write_script` 的乐观锁，报 `ERR_FILE_CONFLICT`，用户看到「服务器上的文件
    /// 在你打开之后被改过」，**而保存其实已经成功**。
    ///
    /// 为什么用源级断言而不是普通单测：这个 bug 需要「rename 成功、紧接着的
    /// metadata 失败」这一瞬态，真机上得掐断连接才构造得出来，CI 里做不到。
    /// 所以守**形状**：两个成功点之后都必须走降级 helper，且不允许再出现
    /// 会把 Err 传播出去的 metadata 调用。
    #[test]
    fn no_fallible_stat_after_rename() {
        let src = include_str!("ssh_russh_file.rs");
        // 🔴 needle 必须**运行时拼**，不能在源码里写成完整字面量：
        // `include_str!` 连本测试的代码一起读进来了，字面量会自己匹配自己，
        // `matches` / `contains` 都中招（第一版就是这么翻车的）。
        let ok_call = |p: &str| format!("Ok(stat_after_rename(&sess, {p}).await)");
        let fallible =
            |p: &str| format!("let md = sess.sftp.metadata({p}).await.map_err(map_sftp_err)?;");
        assert_eq!(
            src.matches(&ok_call("&target")).count(),
            2,
            "写路径与上传路径的 rename 之后都必须走 stat_after_rename 降级"
        );
        // 只查「原子替换」注释**之后**的代码。不能全文件 `contains`：
        // `russh_read_file` 读前的 stat、乐观锁的 stat 本来就该「失败即 Err」——
        // 那时文件还没动，回退是正确行为。要禁的只有「rename 成功之后还把 Err
        // 往上传」这一种形态。`last()` 之后也覆盖到了上传路径的结尾。
        let tail = src.split("// ---- 原子替换 ----").last().unwrap_or("");
        assert!(
            !tail.contains(&fallible("path")),
            "rename 之后又出现了会把 Err 往上传的 metadata 调用"
        );
        assert!(
            !tail.contains(&fallible("remote")),
            "上传路径的 rename 之后又出现了会把 Err 往上传的 metadata 调用"
        );
    }

    /// 🔴 回归（属性丢失级）：**保存必须保留原文件的权限位**。
    ///
    /// 曾经的 bug：russh 写路径只写内容不写权限，保存后权限变成 SFTP 默认值。
    /// 旧路径远端 python 有 `os.chmod(tmp, st.st_mode & 0o7777)`，所以只有
    /// russh 路径会丢：0755 的脚本保存后变 0644（跑不起来），
    /// 0600 的私钥被放宽成 0644（安全事故）。
    /// 这里守两条：掩码值正确，且 file-type 位必须被剥掉。
    #[test]
    fn perm_bits_strips_file_type_and_keeps_permissions() {
        // 普通可执行文件：S_IFREG(0o100000) | 0755
        assert_eq!(perm_bits(0o100755), 0o755);
        // 私钥：S_IFREG | 0600
        assert_eq!(perm_bits(0o100600), 0o600);
        // 目录：S_IFDIR(0o040000) | 0755 —— 目录位必须剥掉，喂给 setstat 有风险
        assert_eq!(perm_bits(0o040755), 0o755);
        // setuid + sticky 要保留（12 位权限位的一部分）
        assert_eq!(perm_bits(0o104755), 0o4755);
        assert_eq!(perm_bits(0o100644), 0o644);
        // 全 1 也不能溢出成别的
        assert_eq!(perm_bits(u32::MAX), 0o7777);
    }

    /// 🔴 回归（数据丢失级）：软链的替换落点必须是**解析出的真实路径**。
    ///
    /// `rename` 不跟随目标 symlink：直接 rename 到链接路径会把链接本身换成
    /// 普通文件（目标没改、链接静默消失）。纯函数三态各钉一例。
    #[test]
    fn decide_rename_target_resolves_symlinks_and_refuses_when_unsure() {
        // ① 不是软链（含 lstat 失败）：照旧写字面路径。「保存到新路径」
        // 这条路不能因为多一次 lstat 就被改窄。
        assert_eq!(
            decide_rename_target("/a/b.conf", LstatKind::NotSymlink, Ok("/x".into()))
                .expect("非软链不该报错"),
            "/a/b.conf"
        );
        // ② 是软链且解析成功：落到真实路径
        assert_eq!(
            decide_rename_target(
                "/etc/nginx/conf.d/default",
                LstatKind::Symlink,
                Ok("/etc/nginx/sites-available/default".into())
            )
            .expect("解析成功不该报错"),
            "/etc/nginx/sites-available/default"
        );
        // ②b 解析结果与字面相同（异常服务器）：没有新信息，照旧
        assert_eq!(
            decide_rename_target("/a", LstatKind::Symlink, Ok("/a".into())).expect("相同照旧"),
            "/a"
        );
        // ②c 解析结果为空：当没解析到，照旧（不能 rename 到空路径）
        assert_eq!(
            decide_rename_target("/a", LstatKind::Symlink, Ok(String::new())).expect("空照旧"),
            "/a"
        );
        // ③ 是软链但解析失败（断裂/成环）：**拒绝保存**，绝不回退到替换链接
        let err = decide_rename_target(
            "/etc/nginx/conf.d/default",
            LstatKind::Symlink,
            Err("no such file".into()),
        )
        .expect_err("解析失败必须拒绝");
        assert!(
            err.contains("已取消保存以免替换掉链接"),
            "错误信息要说明为什么拒绝：{err}"
        );
    }

    /// mode 高 4 位判软链：链接自己的 mode 是 0o120000 | 权限位。
    #[test]
    fn mode_is_symlink_reads_type_bits_only() {
        assert!(mode_is_symlink(Some(0o120777)), "lrwxrwxrwx 是软链");
        assert!(mode_is_symlink(Some(0o120755)));
        assert!(!mode_is_symlink(Some(0o100644)), "普通文件不是");
        assert!(!mode_is_symlink(Some(0o040755)), "目录不是");
        assert!(
            !mode_is_symlink(None),
            "拿不到 mode 不当软链（照旧写字面路径）"
        );
    }
}
