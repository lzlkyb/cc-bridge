//! 远程文件的「读内容 / 写回 / 用本机编辑器打开」——文件面板从「只能另存为」
//! 升级到「双击即编辑」的后端通道（A+C 方案的 A 与 C）。
//!
//! ## 为什么读/写走 helper 而不是 scp
//! 列目录已经复用常驻 helper 会话（`run_via_helper`），读一个小文件再单独 scp 握手
//! 是白付一次 TCP + 认证。所以**读内容、写回都走同一条 helper**：读用 `base64`
//! （PTY 会把原始字节里的控制字符吃掉，base64 全是可打印 ASCII，天然抗 PTY），
//! 写用「base64 -d 到临时文件再 `mv -f`」原子替换。helper 起不来时退回一次性 ssh。
//!
//! ## 大文件与二进制不硬扛
//! 超过 `MAX_EDIT_BYTES`（2 MB）只读预览前一段；不是 UTF-8 的文件直接拒绝内联编辑，
//! 两者都把「用本机编辑器打开」（C 路线，scp 全量下载）作为出路交回用户。
//!
//! ## 安全边界（与 ssh_cmds 一致）
//! 全部经 `ssh_enabled` 总闸；只经 Tauri IPC 给本机面板，**不注册为 MCP 工具**、
//! 不进审计、不向远程 Claude Code 暴露。凭据明文仅在登录一瞬存在（`PendingCreds`）。
//! 写回带 mtime 乐观锁：远端在打开后被改过就拒绝，除非用户显式 `force`（对应 UI 的
//! 「仍然覆盖保存」），不做二次确认弹窗（R17）。

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use tauri::State;

use crate::ssh_proxy::PendingCreds;
use crate::state::AppState;

use super::ssh_cmds::{
    fetch_link, find_scp, find_ssh, resolve_link_secrets, run_scp, run_via_helper, shell_quote,
    spawn_capture_off_runtime, ssh_base_args, ScpJob, SshLink, TransferHooks, PART_SUFFIX,
};

/// 内联编辑的字节上限。`pub(super)`：`ssh_russh_file` 的限流读必须用**同一个**值，
/// 否则 russh 路径与旧路径的「能编辑多大的文件」会出现分歧。
/// base64 后约 2.7 MB，仍在 helper 的 4 MB 输出缓冲内。
///
/// 🔴 曾经还有一个 `PREVIEW_BYTES = 256 KB`，配一条恒定 `f.read(PREVIEW_BYTES)` 的
/// 远端脚本，而 `truncated` 只在 >2 MB 时置位——两者错位导致 256KB–2MB 的文件
/// 「打开只见到一段却显示可编辑」，保存即静默截断（P0-2）。那个常量已删除：
/// 限量读与截断判据必须同源，分开定义就是在制造下一个错位。
pub(super) const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
/// 远端被改、拒绝写回的错误前缀。前端据此切到冲突态，而不是匹配文案。
pub const ERR_FILE_CONFLICT: &str = "CCB_FILE_CONFLICT";
/// 文件不是 UTF-8、不能内联编辑的错误前缀。前端据此引导「用本机编辑器打开」。
pub const ERR_FILE_BINARY: &str = "CCB_FILE_BINARY";
/// 本机临时副本已被外部编辑器改过之外、远端也变了的写回冲突（C 路线回传用）。
const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// `ssh_file_read` 的返回。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileContent {
    /// UTF-8 文本（已把 CRLF 归一成 LF；写回时按 `line_ending` 还原）。
    pub content: String,
    /// 文件总字节数（不是 content 的长度——截断时二者不同）。
    pub size: u64,
    /// 打开时的 mtime（Unix 秒），写回乐观锁用。取不到为 0（此时不做冲突检测）。
    pub mtime: i64,
    /// 是否因超限只取了前一段（只读预览）。
    pub truncated: bool,
    /// 原文件换行符："lf" | "crlf"。
    pub line_ending: String,
}

/// `ssh_file_write` 的返回。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileWrite {
    /// 写入后的 mtime（Unix 秒），前端据此刷新乐观锁基线。
    pub mtime: i64,
    /// 写入字节数。
    pub size: u64,
}

/// `ssh_file_open_external` 的返回。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEdit {
    /// 本机临时副本的绝对路径（回传时原样带回）。
    pub local_path: String,
    /// 下载时的远端 mtime，回传乐观锁用。
    pub mtime: i64,
}

/// 在远端跑一条「请求-响应」命令：先 helper（零握手），起不来退回一次性 ssh。
///
/// 与 `ssh_sftp_list` 同一套回退纪律：helper **拿到响应**（哪怕非零码）就不再走旧路径，
/// 真实错误重跑一遍只是白垃一次握手。一次性路径用 `printf __CCB_RC_%d__ $?` 把退出码
/// 缀在输出末尾，从而和 helper 一样能区分「命令失败」与「ssh 本身失败」。
async fn remote_exec(
    state: &Arc<AppState>,
    link: &SshLink,
    ssh_path: &std::path::Path,
    creds: PendingCreds,
    cmd: String,
) -> Result<(String, i32), String> {
    if let Ok((out, code)) = run_via_helper(state, link, ssh_path, creds.clone(), cmd.clone()).await
    {
        return Ok((out, code));
    }
    let mut args = ssh_base_args(link, "-p");
    args.push(format!("{}@{}", link.conn.username, link.conn.host));
    args.push(format!("{cmd}; printf '\\n__CCB_RC_%d__\\n' $?"));
    let out = spawn_capture_off_runtime(ssh_path.to_path_buf(), args, creds).await?;
    let (body, code) = split_rc(&out);
    Ok((body, code))
}

/// 从一次性路径的输出里拆出末尾的 `__CCB_RC_<n>__` 退出码标记。
/// 没有标记（极少数 shell 不认 printf）时按成功处理，输出原样返回。
fn split_rc(out: &str) -> (String, i32) {
    if let Some(idx) = out.rfind("__CCB_RC_") {
        let rest = &out[idx + "__CCB_RC_".len()..];
        if let Some(end) = rest.find("__") {
            if let Ok(code) = rest[..end].trim().parse::<i32>() {
                let body = out[..idx].trim_end_matches(['\n', '\r']).to_string();
                return (body, code);
            }
        }
    }
    (out.trim_end_matches(['\n', '\r']).to_string(), 0)
}

/// 读远程文件内容。超过 2 MB 只读预览前 256 KB；非 UTF-8 拒绝内联编辑。
#[tauri::command]
pub async fn ssh_file_read(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
) -> Result<RemoteFileContent, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    // D 方案： russh 长连接优先。**同时修掉 P0-2**：旧路径 `read_script` 恒定只读
    // 前 256 KB 却把 `truncated` 留到 >2 MB 才置位，导致 256KB–2MB 的文件
    // 「打开只见到一段、却显示可编辑」，保存即静默截断远端文件。
    // russh 路径的 truncated 由「实际读到的字节数 < 文件总大小」推导，那条缝不存在。
    if let Ok(r) =
        super::ssh_russh_file::russh_read_file(state.inner(), &link, creds.clone(), &path).await
    {
        return Ok(RemoteFileContent {
            content: r.content,
            size: r.size,
            mtime: r.mtime,
            truncated: r.truncated,
            line_ending: r.line_ending,
        });
    }
    let cmd = read_script(&path);
    let (out, code) = remote_exec(&state, &link, &ssh_path, creds, cmd).await?;
    if code != 0 {
        return Err(if out.trim().is_empty() {
            format!("读取失败（退出码 {code}）：{path}")
        } else {
            out.trim().to_string()
        });
    }
    parse_read_output(&out)
}

/// 远端读取脚本：python3 做「stat + 限量读 + UTF-8 校验 + base64」，结果用自定义哨兵框起。
///
/// 为什么用 python3 而不是 `head -c | base64`：要同时拿到 size/mtime、判 UTF-8、
/// 按字节截断且不劈坏多字节字符——这些 shell 拼起来又脆又长。项目本就依赖远端 python3
/// （stable_remote 整套），这里复用同一假设；没有 python3 时给「用本机编辑器打开」的出路。
///
/// 🔴 P0-2 修复（2026-11-23）：这里原本恒定 `f.read(PREVIEW_BYTES)`（256 KB），
/// 而 `truncated` 却在 `st.st_size > MAX_EDIT_BYTES`（2 MB）时才置位。两者一错位：
/// 一个 1 MB 的配置文件打开只拿到前 256 KB、`truncated=false`、前端判定「可编辑」，
/// 一保存就把远端文件静默截断成 256 KB（数据丢失，且用户完全看不出）。
/// 现在限量读与 truncated 判据**同一个值**（`MAX_EDIT_BYTES`）：
/// ≤2 MB 读全量，>2 MB 读前 2 MB 并标记截断。
fn read_script(path: &str) -> String {
    let py = format!(
        "import os,sys,base64\n\
         p={path_lit}\n\
         try:\n\
         \x20   st=os.stat(p)\n\
         \x20   f=open(p,'rb')\n\
         \x20   data=f.read({limit})\n\
         \x20   f.close()\n\
         \x20   trunc=st.st_size>{limit}\n\
         \x20   try:\n\
         \x20       text=data.decode('utf-8')\n\
         \x20   except UnicodeDecodeError:\n\
         \x20       sys.stdout.write('__CCB_F_BIN__\\n')\n\
         \x20       sys.exit(0)\n\
         \x20   meta='{{\"size\":%d,\"mtime\":%d,\"truncated\":%s}}'%(st.st_size,int(st.st_mtime),'true' if trunc else 'false')\n\
         \x20   sys.stdout.write('__CCB_F_META__'+meta+'\\n')\n\
         \x20   sys.stdout.write(base64.b64encode(data).decode('ascii')+'\\n')\n\
         except Exception as e:\n\
         \x20   sys.stdout.write('__CCB_F_ERR__'+str(e)+'\\n')\n",
        path_lit = python_str(path),
        limit = MAX_EDIT_BYTES,
    );
    format!(
        "if command -v python3 >/dev/null 2>&1; then python3 -c {py}; \
         else printf '__CCB_F_ERR__%s\\n' '服务器没有 python3，无法内联读取，请用本机编辑器打开'; fi",
        py = shell_quote(&py),
    )
}

/// 把任意字符串包成 python 单引号字面量（转义反斜杠与单引号），防注入。
fn python_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// 解析读取脚本的哨兵输出。
fn parse_read_output(out: &str) -> Result<RemoteFileContent, String> {
    let mut meta: Option<(u64, i64, bool)> = None;
    let mut b64 = String::new();
    for raw in out.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix("__CCB_F_META__") {
            meta = Some(parse_meta(rest)?);
        } else if let Some(rest) = line.strip_prefix("__CCB_F_ERR__") {
            return Err(rest.to_string());
        } else if line == "__CCB_F_BIN__" {
            return Err(format!(
                "{ERR_FILE_BINARY}: 文件不是 UTF-8 文本，请用本机编辑器打开"
            ));
        } else if meta.is_some() && !line.is_empty() {
            b64.push_str(line);
        }
    }
    let (size, mtime, truncated) =
        meta.ok_or_else(|| "读取结果不完整（远端 python3 输出异常）".to_string())?;
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|e| format!("内容解码失败：{e}"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("{ERR_FILE_BINARY}: 文件不是 UTF-8 文本，请用本机编辑器打开"))?;
    let line_ending = if text.contains("\r\n") { "crlf" } else { "lf" };
    let content = text.replace("\r\n", "\n");
    Ok(RemoteFileContent {
        content,
        size,
        mtime,
        truncated,
        line_ending: line_ending.to_string(),
    })
}

/// 解析 `{"size":N,"mtime":N,"truncated":bool}`。手写极简解析，避免为三个字段引 serde_json
/// 进这条热路径（项目里 serde_json 已有，但这里字段固定、手写更直观且可单测）。
fn parse_meta(s: &str) -> Result<(u64, i64, bool), String> {
    let get = |key: &str| -> Option<&str> {
        let pat = format!("\"{key}\":");
        let start = s.find(&pat)? + pat.len();
        let rest = s[start..].trim_start();
        let end = rest.find([',', '}']).unwrap_or(rest.len());
        Some(rest[..end].trim())
    };
    let size = get("size")
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| "读取结果缺少 size".to_string())?;
    let mtime = get("mtime")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let truncated = get("truncated").map(|v| v == "true").unwrap_or(false);
    Ok((size, mtime, truncated))
}

/// 写回远程文件：base64 -d 到同目录临时文件再 `mv -f` 原子替换。
///
/// `expected_mtime` 是打开时的 mtime；远端当前 mtime 与之不符且 `force=false` 时拒绝
/// （返回 `ERR_FILE_CONFLICT` 前缀），由 UI 给「重新加载 / 仍然覆盖保存」两条出路。
/// `expected_mtime=0` 表示跳过检测（读时没拿到 mtime 的兜底）。
#[tauri::command]
pub async fn ssh_file_write(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
    content: String,
    line_ending: String,
    expected_mtime: i64,
    force: bool,
) -> Result<RemoteFileWrite, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    // D 方案： russh 长连接优先（乐观锁 + 临时文件 + 服务端原子 rename 语义对齐）。
    // 🔴 必须放在下面 `normalized` 之前：那里 else 分支会**move** `content`，
    // 而本块要 `&content`。放在这里还顺带省掉 russh 成功时白算的一次 base64（最大 2MB）。
    if let Ok(w) = super::ssh_russh_file::russh_write_file(
        state.inner(),
        &link,
        creds.clone(),
        &path,
        &content,
        &line_ending,
        expected_mtime,
        force,
    )
    .await
    {
        return Ok(RemoteFileWrite {
            mtime: w.mtime,
            size: w.size,
        });
    }
    // 还原换行符：读时归一成 LF，写回按原文件的风格，避免把整个文件的换行改掉。
    let normalized = if line_ending == "crlf" {
        content.replace('\n', "\r\n")
    } else {
        content
    };
    let bytes = normalized.as_bytes();
    if bytes.len() as u64 > MAX_EDIT_BYTES {
        return Err(format!(
            "内容超过内联编辑上限（{} MB），请用本机编辑器打开后回传",
            MAX_EDIT_BYTES / 1024 / 1024
        ));
    }
    let b64 = B64.encode(bytes);
    let cmd = write_script(&path, &b64, expected_mtime, force);
    let (out, code) = remote_exec(&state, &link, &ssh_path, creds, cmd).await?;
    parse_write_output(&out, code)
}

/// 远端写回脚本。临时文件落在**同目录**（保证 `mv` 是同文件系统 rename，原子），
/// 名字带 pid 与固定后缀；任何失败分支都 `rm -f` 清掉临时文件，绝不碰原文件。
fn write_script(path: &str, b64: &str, expected_mtime: i64, force: bool) -> String {
    let py = format!(
        "import os,sys,base64\n\
         p={path_lit}\n\
         data=base64.b64decode({b64_lit})\n\
         try:\n\
         \x20   st=os.stat(p)\n\
         \x20   cur=int(st.st_mtime)\n\
         except FileNotFoundError:\n\
         \x20   cur=0\n\
         if {expected}!=0 and cur!=0 and cur!={expected} and not {force}:\n\
         \x20   sys.stdout.write('__CCB_W_CONFLICT__%d\\n'%cur)\n\
         \x20   sys.exit(0)\n\
         d=os.path.dirname(p) or '.'\n\
         tmp=os.path.join(d,'.ccb-write-%d.tmp'%os.getpid())\n\
         try:\n\
         \x20   f=open(tmp,'wb')\n\
         \x20   f.write(data)\n\
         \x20   f.close()\n\
         \x20   try:\n\
         \x20       os.chmod(tmp,st.st_mode & 0o7777)\n\
         \x20   except Exception:\n\
         \x20       pass\n\
         \x20   os.replace(tmp,p)\n\
         except Exception as e:\n\
         \x20   try:\n\
         \x20       os.remove(tmp)\n\
         \x20   except Exception:\n\
         \x20       pass\n\
         \x20   sys.stdout.write('__CCB_W_ERR__'+str(e)+'\\n')\n\
         \x20   sys.exit(0)\n\
         st2=os.stat(p)\n\
         sys.stdout.write('__CCB_W_OK__{{\"mtime\":%d,\"size\":%d}}\\n'%(int(st2.st_mtime),st2.st_size))\n",
        path_lit = python_str(path),
        b64_lit = python_str(b64),
        expected = expected_mtime,
        force = if force { "True" } else { "False" },
    );
    format!(
        "if command -v python3 >/dev/null 2>&1; then python3 -c {py}; \
         else printf '__CCB_W_ERR__%s\\n' '服务器没有 python3，无法内联保存，请用本机编辑器打开后回传'; fi",
        py = shell_quote(&py),
    )
}

/// 解析写回脚本输出。冲突 / 错误用可识别前缀，前端据此分流。
fn parse_write_output(out: &str, code: i32) -> Result<RemoteFileWrite, String> {
    for raw in out.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix("__CCB_W_OK__") {
            let mtime = parse_meta_field(rest, "mtime").unwrap_or(0);
            let size = parse_meta_field(rest, "size").unwrap_or(0) as u64;
            return Ok(RemoteFileWrite { mtime, size });
        }
        if let Some(rest) = line.strip_prefix("__CCB_W_CONFLICT__") {
            let cur = rest.trim().parse::<i64>().unwrap_or(0);
            return Err(format!(
                "{ERR_FILE_CONFLICT}: 服务器上的文件在你打开之后被改过（远端 mtime {cur}）"
            ));
        }
        if let Some(rest) = line.strip_prefix("__CCB_W_ERR__") {
            return Err(rest.to_string());
        }
    }
    Err(if out.trim().is_empty() {
        format!("保存失败（退出码 {code}）")
    } else {
        out.trim().to_string()
    })
}

/// 从 `{"mtime":N,"size":N}` 取一个整数字段。
fn parse_meta_field(s: &str, key: &str) -> Option<i64> {
    let pat = format!("\"{key}\":");
    let start = s.find(&pat)? + pat.len();
    let rest = s[start..].trim_start();
    let end = rest.find([',', '}']).unwrap_or(rest.len());
    rest[..end].trim().parse::<i64>().ok()
}

/// C 路线：把远程文件 scp 到本机临时副本，用系统默认应用打开。
///
/// 临时副本落在 `temp_dir/cc-bridge-edit/<连接id>/<文件名>`，按连接隔离避免同名覆盖。
/// 返回本机路径与下载时 mtime，前端编辑完调 `ssh_file_upload_edited` 回传（带乐观锁）。
#[tauri::command]
pub async fn ssh_file_open_external(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
) -> Result<ExternalEdit, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    // 先拿 mtime（回传乐观锁基线）。拿不到不致命，回传时退化为不做冲突检测。
    // D 方案： russh 优先，失败落回 helper 上的 `stat -c %Y`。
    let mtime = match super::ssh_russh_file::russh_mtime(state.inner(), &link, creds.clone(), &path)
        .await
    {
        Ok(m) => m,
        Err(_) => remote_mtime(&state, &link, &creds, &path)
            .await
            .unwrap_or(0),
    };
    let local = external_local_path(&connection_id, &path)?;
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建临时目录失败：{e}"))?;
    }
    // 先下到临时名再 rename：取消/失败不碰上一次留下的副本。
    let part = format!("{}{}", local.display(), PART_SUFFIX);
    // D 方案： russh 长连接优先下载——省掉一次 scp 进程 + 一次 11 秒握手。
    {
        let tried = super::ssh_russh_file::russh_download(
            state.inner(),
            &link,
            creds.clone(),
            &path,
            std::path::Path::new(&part),
            &TransferHooks::default(),
        )
        .await;
        if tried.is_ok() {
            if let Err(e) = std::fs::rename(&part, &local) {
                let _ = std::fs::remove_file(&part);
                return Err(format!("下载完成但改名失败：{e}"));
            }
            let local_str = local.to_string_lossy().to_string();
            tauri_plugin_opener::open_path(&local_str, None::<&str>)
                .map_err(|e| format!("打开本机编辑器失败：{e}"))?;
            return Ok(ExternalEdit {
                local_path: local_str,
                mtime,
            });
        }
        let _ = std::fs::remove_file(&part);
    }
    let (scp, c, r, p) = (scp_path, link, path, part.clone());
    let joined = tokio::task::spawn_blocking(move || {
        let job = ScpJob {
            link: &c,
            remote: &r,
            local: &p,
            upload: false,
        };
        run_scp(&scp, job, creds, TransferHooks::default())
    })
    .await;
    let res = joined.map_err(|e| format!("下载任务异常终止：{e}"))?;
    match res {
        Ok(()) => std::fs::rename(&part, &local).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("下载完成但改名失败：{e}")
        })?,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    }
    let local_str = local.to_string_lossy().to_string();
    tauri_plugin_opener::open_path(&local_str, None::<&str>)
        .map_err(|e| format!("打开本机编辑器失败：{e}"))?;
    Ok(ExternalEdit {
        local_path: local_str,
        mtime,
    })
}

/// C 路线回传：把本机临时副本 scp 回远端，带 mtime 乐观锁。
///
/// 远端在打开后被改过且 `force=false` 时拒绝（`ERR_FILE_CONFLICT`），与内联写回同一语义。
/// 上传同样先传到远端临时名再 `mv -f`，避免把原文件写成半个。
#[tauri::command]
pub async fn ssh_file_upload_edited(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
    local_path: String,
    expected_mtime: i64,
    force: bool,
) -> Result<RemoteFileWrite, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    if !std::path::Path::new(&local_path).exists() {
        return Err("本机临时副本已不存在，无法回传".into());
    }
    // 乐观锁：远端当前 mtime 与打开时不符就拒绝（force 除外）。
    if expected_mtime != 0 && !force {
        // D 方案： russh 优先取 mtime；取不到再落回 helper 的 `stat`。
        let cur =
            match super::ssh_russh_file::russh_mtime(state.inner(), &link, creds.clone(), &path)
                .await
            {
                Ok(m) => m,
                Err(_) => remote_mtime(&state, &link, &creds, &path)
                    .await
                    .unwrap_or(0),
            };
        if cur != 0 && cur != expected_mtime {
            return Err(format!(
                "{ERR_FILE_CONFLICT}: 服务器上的文件在你打开之后被改过（远端 mtime {cur}）"
            ));
        }
    }
    // D 方案： russh 长连接优先上传（同样先落远端临时名再 rename，原子替换语义对齐）。
    {
        let tried = super::ssh_russh_file::russh_upload(
            state.inner(),
            &link,
            creds.clone(),
            std::path::Path::new(&local_path),
            &path,
            &TransferHooks::default(),
        )
        .await;
        if let Ok(w) = tried {
            return Ok(RemoteFileWrite {
                mtime: w.mtime,
                size: w.size,
            });
        }
    }
    // 远端临时名（同目录，保证 mv 原子）。
    // 🔴 nonce 必须**每次调用都不同**。这里原来是 `std::process::id()`，而注释
    // 写着「随机数」——注释与实现不符（对抗视角第 2 条：假设注释是错的）。
    // pid 在整个 app 生命周期里是固定的，于是两次回传同一文件会落到同一个远端
    // 临时名上互相截断。注意这和上面 `write_script` 不一样：那个的 pid 是
    // **远端 shell** 的，每次保存新起一个 ssh 会话所以天然唯一；这里是**本机** pid。
    // 与 russh 路径共用同一个自增序号，保证两条路径的唯一性语义一致。
    let nonce = super::ssh_russh_file::next_write_seq();
    let remote_tmp = format!("{path}.ccb-up-{nonce}.tmp");
    let (scp, c, r, l) = (scp_path, link.clone(), remote_tmp.clone(), local_path);
    // 闭包按值捕获：先克隆一份给 scp，原 creds 留给后面的清理 / finalize。
    let scp_creds = creds.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let job = ScpJob {
            link: &c,
            remote: &r,
            local: &l,
            upload: true,
        };
        run_scp(&scp, job, scp_creds, TransferHooks::default())
    })
    .await;
    let res = joined.map_err(|e| format!("回传任务异常终止：{e}"))?;
    if let Err(e) = res {
        // 清掉远端可能残留的半个临时文件。
        let cleanup = format!("rm -f {}", shell_quote(&remote_tmp));
        let _ = remote_exec(&state, &link, &ssh_path, creds.clone(), cleanup).await;
        return Err(e);
    }
    // 原子替换 + 取新 mtime。
    let finalize = format!(
        "mv -f {tmp} {dst} && python3 -c \"import os;st=os.stat({dst_lit});print('__CCB_W_OK__{{\\\"mtime\\\":%d,\\\"size\\\":%d}}'%(int(st.st_mtime),st.st_size))\"",
        tmp = shell_quote(&remote_tmp),
        dst = shell_quote(&path),
        dst_lit = python_str(&path),
    );
    let (out, code) = remote_exec(&state, &link, &ssh_path, creds, finalize).await?;
    parse_write_output(&out, code)
}

/// 取远端文件 mtime（Unix 秒）。失败返回 Err，调用方自行兜底。
///
/// `stat -c %Y` 是 GNU coreutils；BSD/macOS 用 `stat -f %m`。两条都试，取先成功的。
/// 输出只有一个数字（可能带 PTY 的 `\r`），trim 后 parse。
async fn remote_mtime(
    state: &Arc<AppState>,
    link: &SshLink,
    creds: &PendingCreds,
    path: &str,
) -> Result<i64, String> {
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let cmd = format!(
        "stat -c %Y {p} 2>/dev/null || stat -f %m {p} 2>/dev/null",
        p = shell_quote(path)
    );
    let (out, code) = remote_exec(state, link, &ssh_path, creds.clone(), cmd).await?;
    if code != 0 {
        return Err(format!("stat 失败（退出码 {code}）"));
    }
    out.trim()
        .parse::<i64>()
        .map_err(|_| format!("无法解析 mtime：{}", out.trim()))
}

/// 本机临时副本路径：temp_dir/cc-bridge-edit/<连接id>/<文件名>。
fn external_local_path(connection_id: &str, remote: &str) -> Result<PathBuf, String> {
    let name = remote
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "远程路径无效".to_string())?;
    // 文件名里不该有路径分隔符；保险起见再剔一次，防止 `../` 逃逸临时目录。
    let name = name.replace(['/', '\\'], "_");
    let mut dir = std::env::temp_dir();
    dir.push("cc-bridge-edit");
    dir.push(connection_id);
    Ok(dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴🔴 P0-2 回归（数据丢失级）：**限量读的上限必须与 `truncated` 判据同源**。
    ///
    /// 曾经的 bug：远端脚本恒定 `f.read(PREVIEW_BYTES)`（256 KB），而
    /// `truncated` 写的是 `st.st_size > MAX_EDIT_BYTES`（2 MB）。于是一个
    /// 1 MB 的配置文件：只读到前 256 KB，`truncated=false`，前端 `readOnly`
    /// 只认 `truncated` ⇒ 判定「可编辑」⇒ 用户一保存，远端 1 MB 文件变成 256 KB。
    ///
    /// 这条测试同时钉住生成脚本里的两个数字**相等**。若有人再把限量读改回
    /// 256 KB（或给 `truncated` 换个阈值），这里立刻红。
    #[test]
    fn read_script_limit_and_truncated_judgement_are_the_same_value() {
        let script = read_script("/etc/hosts");
        // 脚本里只能出现一个限量值：读的上限 与 截断判据 都是它
        let limit = MAX_EDIT_BYTES.to_string();
        assert!(
            script.contains(&format!("f.read({limit})")),
            "限量读必须用 MAX_EDIT_BYTES（当前脚本：{script}）"
        );
        assert!(
            script.contains(&format!("st.st_size>{limit}")),
            "truncated 判据必须用同一个 MAX_EDIT_BYTES（当前脚本：{script}）"
        );
        // 反证：旧的 256 KB 常量不许再以任何形式回到脚本里
        assert!(
            !script.contains(&(256 * 1024).to_string()),
            "256 KB 的旧限量值又回到了读取脚本里"
        );
    }

    /// 上一条只钉「两个数相等」，这条钉「值本身正确」：上限就是 2 MB，
    /// 不能为了省流量偷偷调小——那会把「能整份编辑的文件」越缩越少。
    #[test]
    fn edit_limit_is_two_megabytes() {
        assert_eq!(MAX_EDIT_BYTES, 2 * 1024 * 1024);
    }

    #[test]
    fn split_rc_extracts_trailing_code() {
        let (body, code) = split_rc("hello\nworld\n__CCB_RC_2__\n");
        assert_eq!(body, "hello\nworld");
        assert_eq!(code, 2);
    }

    #[test]
    fn split_rc_without_marker_defaults_success() {
        let (body, code) = split_rc("plain output\n");
        assert_eq!(body, "plain output");
        assert_eq!(code, 0);
    }

    #[test]
    fn parse_meta_reads_three_fields() {
        let (size, mtime, trunc) =
            parse_meta(r#"{"size":1234,"mtime":1700000000,"truncated":true}"#).unwrap();
        assert_eq!(size, 1234);
        assert_eq!(mtime, 1700000000);
        assert!(trunc);
    }

    #[test]
    fn parse_read_output_decodes_and_normalizes_crlf() {
        let b64 = B64.encode("line1\r\nline2\r\n");
        let out = format!("__CCB_F_META__{{\"size\":14,\"mtime\":5,\"truncated\":false}}\n{b64}\n");
        let r = parse_read_output(&out).unwrap();
        assert_eq!(r.content, "line1\nline2\n");
        assert_eq!(r.line_ending, "crlf");
        assert_eq!(r.size, 14);
        assert!(!r.truncated);
    }

    #[test]
    fn parse_read_output_binary_is_rejected() {
        let err = parse_read_output("__CCB_F_BIN__\n").unwrap_err();
        assert!(err.starts_with(ERR_FILE_BINARY));
    }

    #[test]
    fn parse_read_output_error_marker_propagates() {
        let err = parse_read_output("__CCB_F_ERR__No such file\n").unwrap_err();
        assert_eq!(err, "No such file");
    }

    #[test]
    fn parse_write_conflict_has_prefix() {
        let err = parse_write_output("__CCB_W_CONFLICT__1700000009\n", 0).unwrap_err();
        assert!(err.starts_with(ERR_FILE_CONFLICT));
    }

    #[test]
    fn parse_write_ok_returns_mtime() {
        let r = parse_write_output("__CCB_W_OK__{\"mtime\":42,\"size\":10}\n", 0).unwrap();
        assert_eq!(r.mtime, 42);
        assert_eq!(r.size, 10);
    }

    #[test]
    fn python_str_escapes_quotes_and_backslashes() {
        assert_eq!(python_str("a'b\\c"), "'a\\'b\\\\c'");
    }

    #[test]
    fn external_path_isolates_per_connection_and_strips_traversal() {
        let p = external_local_path("conn-1", "/home/u/../etc/passwd").unwrap();
        assert!(p.ends_with("passwd"));
        assert!(p.to_string_lossy().contains("conn-1"));
        // 文件名部分不含分隔符
        assert_eq!(p.file_name().unwrap(), "passwd");
        // 末尾带分隔符（目录路径）取不到文件名
        assert!(external_local_path("conn-1", "/home/u/dir/").is_err());
        // 反斜杠也要剔：Windows 上 join 一个含 `\` 的名字会钻出临时目录
        let q = external_local_path("conn-1", r"/home/u/..\evil\a.txt").unwrap();
        assert_eq!(q.file_name().unwrap(), ".._evil_a.txt");
        assert!(q.starts_with(std::env::temp_dir().join("cc-bridge-edit")));
    }

    #[test]
    fn write_script_embeds_force_flag() {
        let s = write_script("/a.txt", "aGk=", 5, true);
        assert!(s.contains("not True"));
        let s2 = write_script("/a.txt", "aGk=", 5, false);
        assert!(s2.contains("not False"));
    }
}
