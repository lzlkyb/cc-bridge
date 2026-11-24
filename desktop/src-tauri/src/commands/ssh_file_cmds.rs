//! 远程文件的「读内容 / 写回 / 用本机编辑器打开」——文件面板从「只能另存为」
//! 升级到「双击即编辑」的后端通道（A+C 方案的 A 与 C）。
//!
//! ## 为什么读/写走 helper 而不是 scp
//! 列目录早已迁到 russh 长连接（2026-11-24 起连 helper 降级也去掉了，见
//! `ssh_cmds::ssh_sftp_list` 的注释），但**读/写仍保留 helper 兜底**：helper 会话
//! 本来就是常驻的（零握手），读一个小文件再单独 scp 握手是白付一次 TCP + 认证。
//! 读用 `base64`（PTY 会把原始字节里的控制字符吃掉，base64 全是可打印 ASCII，
//! 天然抗 PTY）；写用「base64 分块追加进同目录 part 文件，再一条小脚本做长度校验 +
//! 冲突检测 + 权限位回写 + 原子 rename」。helper 起不来、或 payload 超过
//! `HELPER_INLINE_B64_MAX` 时，写回改走 scp 把内容落到远端 part（二进制安全、
//! 不进任何命令行），收尾跑同一条脚本。
//!
//! ⚠️ 读/写的兜底与列目录不同，**刻意保留**：无权限文件的 russh 失败若也短路，
//! 用户连「权限不足」的错误都看不到更快的出路；且读路径的兜底是 helper（零握手），
//! 不是秒级的一次性 ssh——慢的根因只在列目录那一级上。
//!
//! 🔴 **PTY 单行上限 4095 字节**：Linux termios(3) canonical 模式「单行上限 4096
//! 字符（含结尾换行），超出的部分被丢弃」，内核 `N_TTY_BUF_SIZE` 硬编码，
//! `stty -echo` 只关回显、不关 canonical。helper 用 `-tt` 强制分配 PTY，写进去的
//! 每一行都受此限——所以 base64 必须拆行，绝不能一行塞完整载荷（老写法就这么干的：
//! 内容约 2.4KB 起保存必坏，详见 `write_script_chunked` 的注释）。
//!
//! ## 大文件与二进制不硬扛
//! 超过 `MAX_EDIT_BYTES`（2 MB）只读前 2 MB 并标记截断（前端据此转只读）；
//! 既不是 UTF-8 也不是 GBK/GB18030 的文件拒绝内联编辑，两者都把「用本机编辑器打开」
//! （C 路线，scp 全量下载）作为出路交回用户。编码判定在 **Rust 侧**做
//! （`encoding::decode_panel_text`，UTF-8 优先、GBK 兜底）：限流读按字节切，切点落在
//! 多字节字符中间时严格 decode 会把合法文本误判成二进制，两条路都容忍尾部残缺。
//! 读到的编码标签随内容带回前端，写回时按**原编码**编码（`encode_panel_text`），
//! GBK 文件不会再被静默转码成 UTF-8。
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

use crate::encoding::{decode_panel_text, encode_panel_text};
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
/// 文件不是 UTF-8/GBK、不能内联编辑的错误前缀。前端据此引导「用本机编辑器打开」。
pub const ERR_FILE_BINARY: &str = "CCB_FILE_BINARY";
/// 本机临时副本已被外部编辑器改过之外、远端也变了的写回冲突（C 路线回传用）。
const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// `ssh_file_read` 的返回。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileContent {
    /// UTF-8 文本（已把 CRLF 归一成 LF；写回时按 `line_ending` 还原）。
    /// GBK 文件在此已解码为 UTF-8 文本，编码标签见 `encoding`。
    pub content: String,
    /// 文件总字节数（不是 content 的长度——截断时二者不同）。
    pub size: u64,
    /// 打开时的 mtime（Unix 秒），写回乐观锁用。取不到为 0（此时不做冲突检测）。
    pub mtime: i64,
    /// 是否因超限只取了前一段（只读预览）。
    pub truncated: bool,
    /// 原文件换行符："lf" | "crlf"。
    pub line_ending: String,
    /// 原文件编码标签："utf-8" | "gbk"。写回时原样带回，按此编码落盘
    /// （不带回会把 GBK 文件静默转码成 UTF-8）。
    pub encoding: String,
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

/// `ssh_file_viewer` 的返回：远端当前登录身份。
///
/// 文件面板用它预判「你不可读」：把 `SshFileEntry` 的 `uid/gid/mode` 与这份身份
/// 一比，就知道列出来的条目里哪些打开必然 EACCES。一次会话只拉一次——身份不会
/// 在会话中途变，并进每次列目录等于每翻一个目录白付一次 exec。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteViewer {
    /// 有效 uid。
    pub uid: u32,
    /// 有效 gid（主组）。
    pub gid: u32,
    /// 附加组列表（`id -G`，通常含主组）。
    pub groups: Vec<u32>,
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
            encoding: r.encoding,
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

/// 取远端登录身份（`id -u; id -g; id -G`），供文件面板预判「你不可读」。
///
/// 与读文件走同一条 exec 通道（helper 零握手优先、一次性 ssh 兜底）。
/// 失败一律 `Err`，但**前端会静默降级**（整面板不预标）：预标是增强项，
/// 老主机上 `id` 输出异常不该让文件面板本身打不开。
#[tauri::command]
pub async fn ssh_file_viewer(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<RemoteViewer, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    // 一条命令拿三条：分开跑三次就是三次往返，而它们是同一份身份。
    // `id -u` / `id -G` 不带 `-r` 即**有效** uid 与有效组集，正是权限检查用的那份。
    let (out, code) = remote_exec(
        &state,
        &link,
        &ssh_path,
        creds,
        "id -u; id -g; id -G".to_string(),
    )
    .await?;
    if code != 0 {
        return Err(if out.trim().is_empty() {
            format!("读取远端身份失败（退出码 {code}）")
        } else {
            out.trim().to_string()
        });
    }
    parse_viewer(&out)
}

/// 解析 `id -u; id -g; id -G` 的输出。
///
/// 从**末尾**倒着取三行：helper 是长驻 PTY 会话，输出里可能挂着上一条命令的
/// 残留或 motd（一次性 ssh 路径也有 banner 风险）。末尾三行恰好是
/// 「uid / gid / 组列表」，倒推比正推稳，且不需要任何哨兵。
fn parse_viewer(out: &str) -> Result<RemoteViewer, String> {
    let lines: Vec<&str> = out
        .lines()
        .map(|l| l.trim_end_matches('\r').trim())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() < 3 {
        return Err(format!("远端身份输出不完整：{}", out.trim()));
    }
    let n = lines.len();
    let uid_line = lines[n - 3];
    let gid_line = lines[n - 2];
    let groups_line = lines[n - 1];
    let uid = uid_line
        .parse::<u32>()
        .map_err(|_| format!("无法解析远端 uid：{uid_line}"))?;
    let gid = gid_line
        .parse::<u32>()
        .map_err(|_| format!("无法解析远端 gid：{gid_line}"))?;
    // 组列表里解析不了的 token 跳过而不是整条失败：身份主体（uid/gid）已经拿到，
    // 少一个附加组只会让预标更保守（漏判），不会误标。
    let groups = groups_line
        .split_whitespace()
        .filter_map(|g| g.parse::<u32>().ok())
        .collect();
    Ok(RemoteViewer { uid, gid, groups })
}

/// 远端读取脚本：python3 做「stat + 限量读 + base64」，结果用自定义哨兵框起。
///
/// 为什么用 python3 而不是 `head -c | base64`：要同时拿到 size/mtime 并按字节限量读。
/// 项目本就依赖远端 python3（stable_remote 整套），这里复用同一假设；没有 python3 时
/// 给「用本机编辑器打开」的出路。
///
/// 🔴 **编码判定不在这里做**（曾经在）：脚本原来读完后自己 `data.decode('utf-8')`，
/// 失败就报 `__CCB_F_BIN__`。可限量读是按**字节数**切的，一个 >2MB 的中文文件有约
/// 1/4 概率把切点落进某个汉字的第 2/3 字节——合法 UTF-8 被误判成「不是文本」。
/// 现在脚本只管原样回传字节，文本/二进制由 Rust 侧 `decode_panel_text` 判定
/// （与 russh 主路径同一个函数、同一套语义）：尾部残缺只退一个字符，真二进制仍拒绝。
///
/// 🔴 P0-2 修复（2026-11-23）：这里原本恒定 `f.read(PREVIEW_BYTES)`（256 KB），
/// 而 `truncated` 却在 `st.st_size > MAX_EDIT_BYTES`（2 MB）时才置位。两者一错位：
/// 一个 1 MB 的配置文件打开只拿到前 256 KB、`truncated=false`、前端判定「可编辑」，
/// 一保存就把远端文件静默截断成 256 KB（数据丢失，且用户完全看不出）。
/// 现在限量读与 truncated 判据**同一个值**（`MAX_EDIT_BYTES`）：
/// ≤2 MB 读全量，>2 MB 读前 2 MB 并标记截断。
fn read_script(path: &str) -> String {
    let py = read_script_py(&python_str(path), MAX_EDIT_BYTES);
    format!(
        "if command -v python3 >/dev/null 2>&1; then python3 -c {py}; \
         else printf '__CCB_F_ERR__%s\\n' '服务器没有 python3，无法内联读取，请用本机编辑器打开'; fi",
        py = shell_quote(&py),
    )
}

/// 远端读取脚本的 python 源码（**不**过 shell_quote）。
///
/// 从 `read_script` 抽出来只为一件事件：执行级测试要拿这份源码直接
/// `python3 -c` 跑（真机/CI 上验语义）。从包好的 shell 命令行里反解
/// 既脆弱又没必要——2026-11-24 finalize 的教训正是「子串断言全绿、
/// 真跑才红」。
fn read_script_py(path_lit: &str, limit: u64) -> String {
    format!(
        "import os,sys,base64\n\
         p={path_lit}\n\
         try:\n\
         \x20   st=os.stat(p)\n\
         \x20   f=open(p,'rb')\n\
         \x20   data=f.read({limit})\n\
         \x20   f.close()\n\
         \x20   trunc=st.st_size>{limit}\n\
         \x20   meta='{{\"size\":%d,\"mtime\":%d,\"truncated\":%s}}'%(st.st_size,int(st.st_mtime),'true' if trunc else 'false')\n\
         \x20   sys.stdout.write('__CCB_F_META__'+meta+'\\n')\n\
         \x20   sys.stdout.write(base64.b64encode(data).decode('ascii')+'\\n')\n\
         except Exception as e:\n\
         {detail}\
         \x20   sys.stdout.write('__CCB_F_ERR__'+str(e)+d+'\\n')\n",
        path_lit = path_lit,
        limit = limit,
        detail = read_fail_detail_py(path_lit),
    )
}

/// 读失败时附带的「归属诊断」python 片段（插进 `read_script_py` 的 except 块）。
///
/// 为什么需要：2026-11-24 用户报「读取失败：[Errno 13] Permission denied:
/// /home/lizuliang/.claude/own-model.json」，我是有这个权限的」。SSH 上去
/// 查了三轮才知道：文件属 claude-svc、mode 0600，ACL 里给 lizuliang 的授权
/// 项被 `mask::---` 整个剥掉——`os.stat` 成功（目录有 x）但 `open()` 被拒。
/// 排查中**唯一有用的信息（属主/权限位/当前 uid）远端 `os.stat` 一秒就能
/// 给出**，却完全没进错误里，用户只看到一句 Errno 13，只能手工 SSH。
///
/// 这个片段把几个数字拼进错误行（单行，前端原样展示）：
///
/// ```text
/// [Errno 13] Permission denied: '/path'（属主 claude-svc，权限 0600；你 lizuliang，不在属组 claude-svc，需属主或 root 放权）
/// ```
///
/// 三个分支全部由事实推导，不猜：
/// - 文件归你但无可读位 → `chmod u+r`；
/// - 不在文件属组 → 需属主/root 放权（chmod/chown/setfacl）；
/// - 在属组且组位有 r 却被拒 → POSIX ACL mask 或 SELinux 嫌疑
///   （`getfacl` 查看）——正是上面那次事故的形状。
///
/// 🔴 绝不让诊断把原始错误搞丢：整段包在 try 里，任何一步失败（stat 也
/// 失败 / 平台没有 pwd 模块 / …）都退化成 `d=''`，错误行回到原来的裸文案。
/// 也绝不改控制流（不 exit、不 raise）。
///
/// 🔴 只丰富 EACCES（errno 13）：ENOENT/EISDIR 一类附上属主信息只会误导
/// ——「打不开目录」的解不是放权。
fn read_fail_detail_py(path_lit: &str) -> String {
    format!(
        "\x20   d=''\n\
         \x20   if getattr(e,'errno',None)==13:\n\
         \x20       try:\n\
         \x20           st=os.stat({path_lit})\n\
         \x20           me=os.getuid()\n\
         \x20           try:\n\
         \x20               import pwd,grp\n\
         \x20               on=pwd.getpwuid(st.st_uid).pw_name;og=grp.getgrgid(st.st_gid).gr_name;mn=pwd.getpwuid(me).pw_name\n\
         \x20           except Exception:\n\
         \x20               on='uid %d'%st.st_uid;og='gid %d'%st.st_gid;mn='uid %d'%me\n\
         \x20           d='（属主 %s，权限 %04o；你 %s'%(on,st.st_mode&0o7777,mn)\n\
         \x20           if st.st_uid==me:\n\
         \x20               d+='，文件归你但无可读位，可 chmod u+r 后重试'\n\
         \x20           elif st.st_gid!=os.getgid() and st.st_gid not in os.getgroups():\n\
         \x20               d+='，不在属组 %s，需属主或 root 放权'%og\n\
         \x20           elif st.st_mode&0o040:\n\
         \x20               d+='，属组权限正常却被拒，疑为 POSIX ACL mask 或 SELinux，可用 getfacl 查看'\n\
         \x20           else:\n\
         \x20               d+='，属组 %s 无可读位，需属主或 root 放权'%og\n\
         \x20           d+='）'\n\
         \x20       except Exception:\n\
         \x20           d=''\n",
        path_lit = path_lit,
    )
}

/// 把任意字符串包成 python 单引号字面量（转义反斜杠与单引号），防注入。
fn python_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// 解析读取脚本的哨兵输出。
///
/// 🔴 编码判定在**这里**做（`encoding::decode_panel_text`），远端脚本不再判：
/// 限量读按字节切，切点落在多字节字符中间时严格 decode 会把合法文本误判成二进制。
/// 尾部残缺只退一个字符；中部有非法字节（真二进制）仍然拒绝。GBK 路线另有过
/// `is_binary_content` 守卫（GBK 几乎能解码任何双字节序列，不拦会把二进制当文本）。
fn parse_read_output(out: &str) -> Result<RemoteFileContent, String> {
    let mut meta: Option<(u64, i64, bool)> = None;
    let mut b64 = String::new();
    for raw in out.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix("__CCB_F_META__") {
            meta = Some(parse_meta(rest)?);
        } else if let Some(rest) = line.strip_prefix("__CCB_F_ERR__") {
            return Err(rest.to_string());
        } else if meta.is_some() && !line.is_empty() {
            b64.push_str(line);
        }
    }
    let (size, mtime, truncated) =
        meta.ok_or_else(|| "读取结果不完整（远端 python3 输出异常）".to_string())?;
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|e| format!("内容解码失败：{e}"))?;
    let decoded = decode_panel_text(&bytes).map_err(|e| format!("{ERR_FILE_BINARY}: {e}"))?;
    let line_ending = if decoded.crlf { "crlf" } else { "lf" };
    Ok(RemoteFileContent {
        content: decoded.text,
        size,
        mtime,
        truncated,
        line_ending: line_ending.to_string(),
        encoding: decoded.encoding.to_string(),
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

/// 写回远程文件。三条路径按优先级：russh 长连接 → helper 分块写 → scp 上传
/// part，都以「同目录临时文件 + 原子替换」收尾；软链先解析真实落点再替换
/// （不跟随 symlink 会把链接本身换成普通文件，见 `symlink_resolve_py`）。
///
/// `expected_mtime` 是打开时的 mtime；远端当前 mtime 与之不符且 `force=false` 时拒绝
/// （返回 `ERR_FILE_CONFLICT` 前缀），由 UI 给「重新加载 / 仍然覆盖保存」两条出路。
/// `expected_mtime=0` 表示跳过检测（读时没拿到 mtime 的兜底）。
///
/// `encoding` 是读时带回的编码标签（"utf-8" | "gbk"），content 按它编码成字节落盘
/// ——少了这一步，GBK 文件会被静默转码成 UTF-8。标签来自前端但过
/// `label_to_encoding` 白名单，未知值直接拒绝（写路径是破坏性的，不猜）。
// 8 参：connection_id/path/content/line_ending/encoding 是文件本体与保真信息，
// expected_mtime/force 是乐观锁输入，state 是固定容器——彼此独立，打包结构体只会让
// 调用点更长（同 russh_write_file / write_via_scp 的判断）。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_file_write(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
    content: String,
    line_ending: String,
    encoding: String,
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
    // 放在编码之前：russh 成功时就省掉一次 base64（最大 2MB）。
    if let Ok(w) = super::ssh_russh_file::russh_write_file(
        state.inner(),
        &link,
        creds.clone(),
        &path,
        &content,
        &line_ending,
        &encoding,
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
    // 按**原编码 + 原换行**编码（读时把 CRLF 归一成 LF，这里按原文件风格还原；
    // GBK 文件不会被静默转码成 UTF-8）。round-trip 守卫在内：往 GBK 插 emoji
    // 这类不可表示字符时拒绝写入。
    let bytes = encode_panel_text(&content, &line_ending, &encoding)?;
    // 🔴 大小检查必须放在编码**之后**：GBK 编码后的字节数比同一文本的 UTF-8
    // 表示短，按 UTF-8 长度判会把本来存得下的 GBK 文件误杀。
    if bytes.len() as u64 > MAX_EDIT_BYTES {
        return Err(format!(
            "内容超过内联编辑上限（{} MB），请用本机编辑器打开后回传",
            MAX_EDIT_BYTES / 1024 / 1024
        ));
    }
    let b64 = B64.encode(&bytes);
    // ---- 回退路径 A：常驻 helper，base64 分块写 part 文件 ----
    // 🔴 为什么不再把整个 base64 塞进**一行**：helper 用 `-tt` 强制分配 PTY，而
    // Linux termios 的 canonical 模式单行上限 4095 字节（含结尾换行），超出的部分
    // 被**内核直接丢弃**（`stty -echo` 只关回显，不关 canonical）。老写法一条命令
    // 一行写完，内容约 2.4KB 起就被切：远端 sh 卡在半句话里等后续输入，15 秒后
    // helper 超时被拆、再退回一次性 ssh 重付一次握手（表现为保存转圈约 26 秒）；
    // payload 超过约 24KB 时连一次性 ssh 的命令行都超 Windows 32767 字符上限，
    // 保存直接失败。现在按 ≤4KB 一行拆成多条 printf 追加行，两个上限都不碰。
    if b64.len() <= HELPER_INLINE_B64_MAX {
        if let Some(cmd) = write_script_chunked(&path, &b64, expected_mtime, force) {
            // helper 拿到响应（哪怕是 __CCB_W_ERR__/__CCB_W_CONFLICT__）就算数，
            // 不再走旧路径；只有 helper 本身起不来/跑坏才落到下面的 scp 路线。
            if let Ok((out, code)) =
                run_via_helper(&state, &link, &ssh_path, creds.clone(), cmd).await
            {
                return parse_write_output(&out, code);
            }
        }
    }
    // ---- 回退路径 B：payload 走 scp，不进任何命令行 ----
    // 两种情况会到这：helper 不可用（禁 shell / MaxSessions 满 / 负缓存），或
    // payload 超过 `HELPER_INLINE_B64_MAX`——分块行数多了会把共享 helper 会话占住
    // 很久（挡住同连接的列目录/读取），且 PTY 写入没有超时与取消。
    // scp 是二进制安全的 bulk 通道：本机临时文件 → 远端 part → 同一条收尾脚本。
    write_via_scp(
        &state,
        &link,
        &ssh_path,
        creds,
        &bytes,
        &path,
        expected_mtime,
        force,
    )
    .await
}

/// PTY canonical 模式的单行上限：Linux termios(3)「单行上限 4096 字符（含结尾
/// 换行），超出的部分被丢弃」，内核 `N_TTY_BUF_SIZE` 硬编码，`stty -echo` 不关它。
/// helper 靠 `-tt` 强制分配 PTY，写进去的每一行都受此限。
const PTY_LINE_LIMIT: usize = 4095;

/// 走 helper 分块写路线最大的 base64 长度（约 96 KB 原文）。
///
/// 两条理由取这个数：① **执行预算**——分块行数 × 每行成本要压在 helper 的
/// `CMD_TIMEOUT`（15s）内，而远端 `/bin/sh` 不一定把 `printf` 做内建（外部
/// printf 每行一次 fork）；② **会话占用**——PTY 写入没有超时与取消，大 payload
/// 会把共享 helper 会话占住很久，挡住同一连接的列目录/读取。超过就走 scp。
const HELPER_INLINE_B64_MAX: usize = 128 * 1024;

/// 每条 printf 行的 base64 载荷上限（行长预算见 `write_script_chunked`）。
const WRITE_CHUNK_B64: usize = 3600;

/// helper 写路径：把 base64 拆成多条 ≤PTY 行限的 printf 追加行写进同目录 part 文件，
/// 最后一行是小 finalize（长度校验 → 冲突检测 → 权限位回写 → 原子 rename → 清场）。
///
/// part 与目标同目录 ⇒ `os.replace` 是同文件系统的一次原子替换，原文件在替换成功
/// 前一个字节都没被碰。任何失败分支都清掉 part，绝不在同目录留下半个文件。
///
/// 🔴 part 名带 `next_write_seq()` 而不是远端 shell pid：helper 是**长驻会话**，
/// 同一个 `sh` 进程会连续处理多次保存，pid 在会话内是常量——用它做临时名会让两次
/// 保存落到同一个 part 上互相截断（旧路径每次保存新起 ssh 会话，pid 天然唯一）。
///
/// 返回 None 表示路径太长，连最小载荷都塞不进一行——此时调用方应改走 scp，
/// **绝不生成超长行**（那正是这个函数要消除的 bug 形态）。
///
/// 已知取舍：helper 会话在分块写到一半时死掉（断网 / 超时被拆），那半个 part
/// 没人清——名字带唯一序号，下次保存用新序号不会互相覆盖，最坏情况是同目录
/// 多一个 `.<文件名>.ccb-write-<序号>.part` 残留（可手删）。scp 路线没有这个
/// 缝隙：上传失败与 finalize 传输失败都会补 `rm -f`。
fn write_script_chunked(path: &str, b64: &str, expected_mtime: i64, force: bool) -> Option<String> {
    let nonce = super::ssh_russh_file::next_write_seq();
    let part = format!("{path}.ccb-write-{nonce}.part");
    let part_q = shell_quote(&part);
    // 每行总长 = 包装(19) + part_q + 载荷。首行还要挂开始哨兵、末行挂结束哨兵
    // （`wrap_command` 各约 35 字节，nonce 最长按 24 计），统一留 96 字节余量。
    let budget = PTY_LINE_LIMIT
        .saturating_sub(96 + 19 + part_q.len())
        .min(WRITE_CHUNK_B64);
    if budget < 1024 {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    // base64 全是 ASCII，按字节切不会劈坏字符。空内容也要建一个空 part——
    // 否则 finalize 连要替换的文件都找不到（用户清空文件再保存是合法操作）。
    let chunks: Vec<&str> = if b64.is_empty() {
        vec![""]
    } else {
        b64.as_bytes()
            .chunks(budget)
            .map(|c| std::str::from_utf8(c).expect("base64 输出必为 ASCII"))
            .collect()
    };
    // printf 是 shell 内建（dash / bash / busybox 都是），不 fork；退化成外部
    // /usr/bin/printf 也只是慢一点，语义不变。
    for (i, c) in chunks.iter().enumerate() {
        let op = if i == 0 { ">" } else { ">>" };
        lines.push(format!("printf '%s' '{c}' {op} {part_q}"));
    }
    lines.push(finalize_script(
        &part,
        path,
        b64.len(),
        true,
        expected_mtime,
        force,
    ));
    Some(lines.join("\n"))
}

/// 「解析软链 → 断裂/成环则拒绝保存」的 python 片段，产出变量 `t`（最终落点）。
///
/// 三条旧写路径共用：helper 分块路线、scp 路线（都在 `finalize_script` 里）、
/// C 路线回传的 scp 兜底（`ssh_file_upload_edited`）。
///
/// 🔴 为什么必须有：`os.replace` / `mv` / SFTP `rename` **都不跟随目标 symlink**。
/// 用户编辑软链文件时读到的是目标内容（open 跟随链接），直接替换链接路径却会把
/// **链接本身**换成普通文件——目标没改、链接静默消失，保存却显示成功。
/// vim / nano / VS Code 的语义都是「编辑软链 = 编辑其目标」，这里对齐。
///
/// 拿不准（软链但 realpath 出的目标不存在）时**拒绝保存**：能走到保存这一步，
/// 说明读取时链接是好的，此时断裂只能是读取之后发生的变故，拒绝是对的。
///
/// 自包含：拒绝分支自己删临时文件（此时 part 已经写完并通过校验，留着就是垃圾），
/// 不依赖调用方定义 `cleanup()`——两个调用点（finalize / 回传兜底）的临时变量名
/// 不同（`part` / `tmp`），靠隐式契约迟早出一个只在错误路径上触发的 NameError。
fn symlink_resolve_py(path_lit: &str, tmp_lit: &str) -> String {
    format!(
        "t={path_lit}\n\
         if os.path.islink({path_lit}):\n\
         \x20   rp=os.path.realpath({path_lit})\n\
         \x20   if not os.path.exists(rp):\n\
         \x20       try:\n\
         \x20           os.remove({tmp_lit})\n\
         \x20       except Exception:\n\
         \x20           pass\n\
         \x20       sys.stdout.write('__CCB_W_ERR__软链目标不存在或无法解析（%s），已取消保存\\n'%rp)\n\
         \x20       sys.exit(0)\n\
         \x20   t=rp\n",
        path_lit = path_lit,
        tmp_lit = tmp_lit,
    )
}

/// 写失败时附带的「归属诊断」python 片段（插进 `finalize_script_py` 的 replace except 块）。
///
/// 与读取侧的 `read_fail_detail_py` 同形状、同取向：**只丰富 EACCES**，其余 errno
/// 原样透出；片段自身失败免疫（任何异常都退化成空串，绝不影响原始报错）；
/// 绝不改控制流（不 `sys.exit`、不 `raise`）。
///
/// 🔴 为什么 stat 的是**父目录**而不是文件本身：`os.replace(part, t)` 是 rename
/// 语义，内核要的是「目标目录可写 + 可进入」，与目标文件自身的 mode 无关——
/// 把一个 0444 的只读文件替换掉是允许的（只要目录可写），而目录 0555 时文件
/// 就算 0666 也换不了。2026-11-24 的事故正是「看着像文件权限、其实是目录/ACL」
/// 的误判，所以文案必须点明「目标目录」，否则用户会去 chmod 文件白费一轮。
///
/// `target_var`：脚本里最终落点（解析软链后的 `t`）的变量名。片段自包含、
/// 可独立执行——执行级测试拿它直接跑。
fn write_fail_detail_py(target_var: &str) -> String {
    format!(
        "\x20   d=''\n\
         \x20   if getattr(e,'errno',None)==13:\n\
         \x20       try:\n\
         \x20           dp=os.path.dirname({t}) or '.'\n\
         \x20           st=os.stat(dp)\n\
         \x20           me=os.getuid()\n\
         \x20           try:\n\
         \x20               import pwd,grp\n\
         \x20               on=pwd.getpwuid(st.st_uid).pw_name;og=grp.getgrgid(st.st_gid).gr_name;mn=pwd.getpwuid(me).pw_name\n\
         \x20           except Exception:\n\
         \x20               on='uid %d'%st.st_uid;og='gid %d'%st.st_gid;mn='uid %d'%me\n\
         \x20           d='（目标目录 %s 属主 %s，权限 %04o；你 %s'%(dp,on,st.st_mode&0o7777,mn)\n\
         \x20           if st.st_uid==me:\n\
         \x20               d+='，目录归你但无可写位，可 chmod u+w 后重试'\n\
         \x20           elif st.st_gid!=os.getgid() and st.st_gid not in os.getgroups():\n\
         \x20               d+='，不在属组 %s，需属主或 root 放权'%og\n\
         \x20           elif st.st_mode&0o020:\n\
         \x20               d+='，属组权限正常却被拒，疑为 POSIX ACL mask 或 SELinux，可用 getfacl 查看'\n\
         \x20           else:\n\
         \x20               d+='，属组 %s 无可写位，需属主或 root 放权'%og\n\
         \x20           d+='）'\n\
         \x20       except Exception:\n\
         \x20           d=''\n",
        t = target_var,
    )
}

/// 收尾脚本（helper 分块路线与 scp 路线**共用**）：读 part → 校验长度 → 冲突检测 →
/// 保留权限位 → 原子 rename → 清场。**小命令**：helper 与一次性 ssh 的命令行都放得下。
///
/// `is_b64`：helper 路线的 part 里是 base64 文本（分块 printf 落的），必须
/// **解码后写回 part** 再 rename——part 里躺着 base64 原文，直接 rename 会把
/// base64 文本当成文件内容存进去（用户存什么进去、读出来就是 base64 串）。
/// 🔴 这一步在 2026-11-24 的 part 化重构里丢过一次：`data` 解出来没有任何
/// 写回，子串断言全绿，是**执行级**语义测试（真建软链真跑脚本）逮出来的。
/// scp 路线 part 里是原始字节（`is_b64=false`），整段跳过。
///
/// 🔴 软链：替换落点是解析出的**真实路径** `t`（`symlink_resolve_py`）。`os.replace`
/// 不跟随目标 symlink，直接替换链接路径会把链接本身换成普通文件——目标没改、
/// 链接静默消失、保存却显示成功。解析失败（断裂/成环）拒绝保存，不回退老行为。
///
/// 两处**故意**的非致命处理（与旧路径、russh 路径逐条对齐）：
/// ① chmod 失败不阻断——权限错了是小事，内容存不进去是数据丢失（russh 路径
///    `set_metadata` 失败同样只打日志）；
/// ② `os.replace` **成功之后**的 stat 失败不让整个操作失败，只把 mtime/size 降级
///    成 0（代价仅是下次保存跳过冲突检测）。反过来做就是「谎报失败」：保存其实
///    已经成功，用户却看到报错，可能再 force 存一遍。
fn finalize_script(
    part: &str,
    path: &str,
    expected_len: usize,
    is_b64: bool,
    expected_mtime: i64,
    force: bool,
) -> String {
    let py = finalize_script_py(
        &python_str(part),
        &python_str(path),
        expected_len,
        is_b64,
        expected_mtime,
        force,
    );
    format!(
        "if command -v python3 >/dev/null 2>&1; then python3 -c {py}; \
         else printf '__CCB_W_ERR__%s\\n' '服务器没有 python3，无法内联保存，请用本机编辑器打开后回传'; fi",
        py = shell_quote(&py),
    )
}

/// 收尾脚本的 python 源码（**不**过 `shell_quote`）。
///
/// 从 `finalize_script` 抽出来的理由与读取侧 `read_script_py` 完全一致：
/// 执行级测试要拿这份源码直接 `python3 -c` 跑（真造只读目录、真撞 EACCES），
/// 从包好的 shell 命令行里反解既脆弱又没必要。
fn finalize_script_py(
    part_lit: &str,
    path_lit: &str,
    expected_len: usize,
    is_b64: bool,
    expected_mtime: i64,
    force: bool,
) -> String {
    format!(
        "import os,sys,base64\n\
         p={path_lit}\n\
         part={part_lit}\n\
         n={expected_len}\n\
         def cleanup():\n\
         \x20   try:\n\
         \x20       os.remove(part)\n\
         \x20   except Exception:\n\
         \x20       pass\n\
         try:\n\
         \x20   raw=open(part,'rb').read()\n\
         except Exception as e:\n\
         \x20   sys.stdout.write('__CCB_W_ERR__临时文件读取失败：'+str(e)+'\\n')\n\
         \x20   sys.exit(0)\n\
         if len(raw)!=n:\n\
         \x20   cleanup()\n\
         \x20   sys.stdout.write('__CCB_W_ERR__分块写入不完整（%d/%d 字节），已放弃保存\\n'%(len(raw),n))\n\
         \x20   sys.exit(0)\n\
         data=raw\n\
         if {is_b64}:\n\
         \x20   try:\n\
         \x20       data=base64.b64decode(raw,validate=True)\n\
         \x20   except Exception as e:\n\
         \x20       cleanup()\n\
         \x20       sys.stdout.write('__CCB_W_ERR__分块内容损坏：'+str(e)+'\\n')\n\
         \x20       sys.exit(0)\n\
         \x20   try:\n\
         \x20       f=open(part,'wb')\n\
         \x20       f.write(data)\n\
         \x20       f.close()\n\
         \x20   except Exception as e:\n\
         \x20       cleanup()\n\
         \x20       sys.stdout.write('__CCB_W_ERR__解码后写回临时文件失败：'+str(e)+'\\n')\n\
         \x20       sys.exit(0)\n\
         try:\n\
         \x20   st=os.stat(p)\n\
         \x20   cur=int(st.st_mtime)\n\
         \x20   mode=st.st_mode & 0o7777\n\
         except FileNotFoundError:\n\
         \x20   cur=0\n\
         \x20   mode=None\n\
         if {expected}!=0 and cur!=0 and cur!={expected} and not {force}:\n\
         \x20   cleanup()\n\
         \x20   sys.stdout.write('__CCB_W_CONFLICT__%d\\n'%cur)\n\
         \x20   sys.exit(0)\n\
         {resolve}\
         try:\n\
         \x20   if mode is not None:\n\
         \x20       try:\n\
         \x20           os.chmod(part,mode)\n\
         \x20       except Exception:\n\
         \x20           pass\n\
         \x20   os.replace(part,t)\n\
         except Exception as e:\n\
         \x20   cleanup()\n\
         {detail}\
         \x20   sys.stdout.write('__CCB_W_ERR__'+str(e)+d+'\\n')\n\
         \x20   sys.exit(0)\n\
         try:\n\
         \x20   st2=os.stat(t)\n\
         \x20   sys.stdout.write('__CCB_W_OK__{{\"mtime\":%d,\"size\":%d}}\\n'%(int(st2.st_mtime),st2.st_size))\n\
         except Exception:\n\
         \x20   sys.stdout.write('__CCB_W_OK__{{\"mtime\":0,\"size\":0}}\\n')\n",
        path_lit = path_lit,
        part_lit = part_lit,
        expected_len = expected_len,
        is_b64 = if is_b64 { "True" } else { "False" },
        expected = expected_mtime,
        force = if force { "True" } else { "False" },
        // 软链解析片段插在冲突检测之后、replace 之前：`t` 即最终落点。
        // 拒绝时片段自己删 part（此时 part 已写完并通过校验）。
        resolve = symlink_resolve_py(path_lit, part_lit),
        // 写失败（EACCES）时附带的归属诊断。注意 rename 要的是**目标目录**可写，
        // 不是文件本身可写——片段 stat 的是 `t` 的父目录，不是 `t`。
        detail = write_fail_detail_py("t"),
    )
}

/// 回退路径 B：内容走 scp 落到远端 part 文件（二进制安全，不进任何命令行），
/// 再跑同一条 finalize。用于 helper 不可用、或 payload 超过 `HELPER_INLINE_B64_MAX`。
// 8 参：state/link/ssh_path/creds 是拿连接的四件套，bytes/path/expected_mtime/force
// 是载荷与乐观锁输入——彼此独立，打包结构体只会让调用点更长（同 russh_write_file）。
#[allow(clippy::too_many_arguments)]
async fn write_via_scp(
    state: &Arc<AppState>,
    link: &SshLink,
    ssh_path: &std::path::Path,
    creds: PendingCreds,
    bytes: &[u8],
    path: &str,
    expected_mtime: i64,
    force: bool,
) -> Result<RemoteFileWrite, String> {
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let nonce = super::ssh_russh_file::next_write_seq();
    // 本机临时文件：内容原样落盘，scp 二进制安全，不走 base64。
    let local = std::env::temp_dir().join(format!(
        "cc-bridge-write-{}-{nonce}.tmp",
        std::process::id()
    ));
    if let Err(e) = std::fs::write(&local, bytes) {
        return Err(format!("写入本机临时文件失败：{e}"));
    }
    let remote_part = format!("{path}.ccb-write-{nonce}.part");
    let (scp, c, r, l) = (
        scp_path,
        link.clone(),
        remote_part.clone(),
        local.to_string_lossy().to_string(),
    );
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
        let _ = std::fs::remove_file(&local);
        // 清掉远端可能残留的半个 part，别在同目录里越积越多。
        let cleanup = format!("rm -f {}", shell_quote(&remote_part));
        let _ = remote_exec(state, link, ssh_path, creds, cleanup).await;
        return Err(e);
    }
    let _ = std::fs::remove_file(&local);
    let cmd = finalize_script(
        &remote_part,
        path,
        bytes.len(),
        false,
        expected_mtime,
        force,
    );
    // finalize 传输层失败（ssh 本身没跑起来）时，远端 part 不会有人清——补一次
    // rm -f，别在用户目录里越积越多。脚本自己报的错（__CCB_W_ERR__ 等）它内部
    // 已经清过场，走到这里只会是更外层的失败。
    let finalized = remote_exec(state, link, ssh_path, creds.clone(), cmd).await;
    let (out, code) = match finalized {
        Ok(v) => v,
        Err(e) => {
            let cleanup = format!("rm -f {}", shell_quote(&remote_part));
            let _ = remote_exec(state, link, ssh_path, creds, cleanup).await;
            return Err(e);
        }
    };
    parse_write_output(&out, code)
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
/// 上传同样先传到远端临时名再原子替换（软链解析真实落点，见 `symlink_resolve_py`），
/// 避免把原文件写成半个。
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
    // 临时名上互相截断。与 russh 路径、helper 分块写路径共用同一个自增序号，
    // 三条路径的唯一性语义一致。
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
    // 🔴 软链：这里原来是 `mv -f {tmp} {dst}`——`mv` 走 rename，**不跟随目标
    // symlink**，会把链接本身替换成普通文件（目标没改、链接静默消失）。与
    // `finalize_script` 用同一个解析片段；python3 不可用时明确报错（原来的
    // `mv && python3 -c stat` 在这种服务器上本来也会以 127 失败）。
    let finalize = format!(
        "if command -v python3 >/dev/null 2>&1; then python3 -c {py}; \
         else printf '__CCB_W_ERR__%s\\n' '服务器没有 python3，无法完成回传'; fi",
        py = shell_quote(&format!(
            "import os,sys\n\
             {resolve}\
             os.replace({tmp_lit},t)\n\
             st=os.stat(t)\n\
             sys.stdout.write('__CCB_W_OK__{{\"mtime\":%d,\"size\":%d}}\\n'%(int(st.st_mtime),st.st_size))\n",
            resolve = symlink_resolve_py(&python_str(&path), &python_str(&remote_tmp)),
            tmp_lit = python_str(&remote_tmp),
        )),
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

    /// 归属诊断片段的形状：只丰富 EACCES、三分支齐全、失败免疫、
    /// 且是「能插进 except 块」的缩进形状。
    ///
    /// 缩进这条不是洁癖：片段首行顶格会直接 SyntaxError，而 SyntaxError
    /// 让整个脚本跑不起来——读失败的理由就从「Permission denied」变成
    /// 一句 traceback，比不诊断更糟。每行都必须有前导空格。
    #[test]
    fn read_fail_detail_py_shape_and_branches() {
        let f = read_fail_detail_py("'/a.txt'");
        // 只丰富 EACCES：ENOENT/EISDIR 一类不附属主信息（解不是放权）
        assert!(
            f.contains("getattr(e,'errno',None)==13"),
            "必须只丰富 EACCES：{f}"
        );
        // 路径是穿进来的（片段自包含，可独立执行）
        assert!(f.contains("os.stat('/a.txt')"), "路径必须穿进片段：{f}");
        // 三分支齐全
        assert!(f.contains("st.st_uid==me"), "缺「归你但无可读位」分支：{f}");
        assert!(f.contains("os.getgroups()"), "缺「不在属组」分支：{f}");
        assert!(
            f.contains("st.st_mode&0o040"),
            "缺「ACL mask 嫌疑」分支：{f}"
        );
        // 失败免疫：初值 + 兜底两处清空；且绝不改控制流
        assert!(
            f.matches("d=''").count() >= 2,
            "必须有初值和兜底两处清空：{f}"
        );
        assert!(!f.contains("sys.exit"), "诊断片段不许改控制流：{f}");
        assert!(!f.contains("raise"), "诊断片段不许抛异常：{f}");
        // 缩进形状：每一行都得有前导空格
        assert!(
            f.lines().all(|l| l.starts_with(' ')),
            "片段每行都必须缩进（首行顶格会 SyntaxError）：{f:?}"
        );
        // 接线：片段必须真接进读取脚本的 except 块。上面那些断言只覆盖
        // 「片段本身对」；接线被摘掉（detail 传空串）时纯片段测试全绿，
        // 必须有这条在全平台（含 Windows 门禁）把接线钉住。
        // 🔴 断言必须打在 `read_script_py`（未过 shell_quote 的 python 源）上：
        // `read_script` 的产物里单引号已被转义成 `'\''`，拿原文当 needle 永远
        // 匹配不上——这个坑第一次写时真踩了（全量测试报红才发现）。
        assert!(
            read_script_py(&python_str("/a.txt"), MAX_EDIT_BYTES)
                .contains("getattr(e,'errno',None)==13"),
            "诊断片段没接进读取脚本（detail 被传空了？）"
        );
    }

    /// 执行级（真跑 python3）：chmod 000 的文件必须既报错、又把归属信息
    /// 带出来；可读文件必须不受影响。
    ///
    /// 为什么必须真跑：子串断言全绿不代表脚本能跑——2026-11-24 finalize
    /// 的「data 解出来没写回 part」就是子串全绿、真跑才红的。
    #[cfg(unix)]
    #[test]
    fn read_script_reports_owner_and_mode_on_eacces() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        // 没有 python3 的环境跳过（生产本就要求远端有 python3，本地没有
        // 不代表脚本错）；root 读 000 文件不会被拒，同样跳过。
        let has_py = Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_py {
            return;
        }
        let is_root = Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false);
        if is_root {
            return;
        }

        let dir = std::env::temp_dir().join(format!("ccb-readerr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // ① 不可读：chmod 000，属主就是执行者自己 → 「归你但无可读位」分支
        let locked = dir.join("locked.txt");
        std::fs::write(&locked, b"secret").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let src = read_script_py(&python_str(locked.to_str().unwrap()), MAX_EDIT_BYTES);
        let out = Command::new("python3")
            .arg("-c")
            .arg(&src)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.starts_with("__CCB_F_ERR__"),
            "必须仍走错误哨兵：{stdout}"
        );
        assert!(
            stdout.contains("Permission denied"),
            "原始错误不许被诊断信息盖掉：{stdout}"
        );
        assert!(stdout.contains("0000"), "必须带出权限位 0000：{stdout}");
        assert!(
            stdout.contains("文件归你但无可读位"),
            "必须带出归属判断：{stdout}"
        );

        // ② 可读：正常走 META + base64，诊断片段不许破坏 happy path
        let ok = dir.join("ok.txt");
        std::fs::write(&ok, b"hello").unwrap();
        let src = read_script_py(&python_str(ok.to_str().unwrap()), MAX_EDIT_BYTES);
        let out = Command::new("python3")
            .arg("-c")
            .arg(&src)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("__CCB_F_META__"),
            "可读文件必须出 META：{stdout}"
        );
        assert!(
            !stdout.contains("__CCB_F_ERR__"),
            "可读文件不许报错：{stdout}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写侧诊断片段：形状 + 分支 + 接线。与读侧 `read_fail_detail_py` 同取向。
    #[test]
    fn write_fail_detail_py_shape_and_branches() {
        let f = write_fail_detail_py("t");
        // 只丰富 EACCES：ENOSPC/EXDEV 一类不附属主信息（解不是放权）
        assert!(
            f.contains("getattr(e,'errno',None)==13"),
            "必须只丰富 EACCES：{f}"
        );
        // 🔴 stat 的是**父目录**：rename 要的是目录 w+x，不是文件本身可写
        assert!(
            f.contains("os.path.dirname(t)"),
            "写路径必须诊断目标目录而不是文件：{f}"
        );
        // 三分支齐全（无写位 / 不在属组 / ACL mask 嫌疑）
        assert!(f.contains("st.st_uid==me"), "缺「归你但无可写位」分支：{f}");
        assert!(f.contains("os.getgroups()"), "缺「不在属组」分支：{f}");
        assert!(
            f.contains("st.st_mode&0o020"),
            "缺「ACL mask 嫌疑」分支：{f}"
        );
        // 失败免疫：初值 + 兜底两处清空；且绝不改控制流
        assert!(
            f.matches("d=''").count() >= 2,
            "必须有初值和兜底两处清空：{f}"
        );
        assert!(!f.contains("sys.exit"), "诊断片段不许改控制流：{f}");
        assert!(!f.contains("raise"), "诊断片段不许抛异常：{f}");
        // 缩进形状：每一行都得有前导空格（首行顶格会 SyntaxError）
        assert!(
            f.lines().all(|l| l.starts_with(' ')),
            "片段每行都必须缩进：{f:?}"
        );
        // 接线：断言打在 `finalize_script_py`（未过 shell_quote 的 python 源）上。
        // 打 `finalize_script` 的产物永远匹配不上——单引号已被转义成 `'\''`，
        // 这个坑在读侧踩过一次（全量门禁才发现）。
        let py = finalize_script_py(
            &python_str("/a.part"),
            &python_str("/a"),
            1,
            false,
            0,
            false,
        );
        assert!(
            py.contains("getattr(e,'errno',None)==13"),
            "诊断片段没接进写回脚本（detail 被传空了？）"
        );
        assert!(
            py.contains("str(e)+d"),
            "错误串必须拼上诊断（不然片段白算）：{py}"
        );
    }

    /// 执行级（真跑 python3 + 真只读目录）：保存撞 EACCES 时必须既报错、
    /// 又把「目标目录 + 权限 + 归属 + 出路」带出来。
    ///
    /// 为什么必须真跑：子串断言全绿不代表脚本能跑；`os.replace` 的 EACCES
    /// 只有在「目录不可写」时才出现，stub 不出来。
    #[cfg(unix)]
    #[test]
    fn finalize_script_reports_target_dir_on_eacces() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let has_py = Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_py {
            return;
        }
        // root 无视目录写位，撞不出 EACCES
        let is_root = Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false);
        if is_root {
            return;
        }

        let dir = std::env::temp_dir().join(format!("ccb-writeerr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("app.conf");
        let part = dir.join("app.conf.ccb-write-1.part");
        std::fs::write(&target, b"old\n").unwrap();
        std::fs::write(&part, b"hello").unwrap();
        // 目录只读 ⇒ rename 必然 EACCES（文件本身怎么 chmod 都不影响这件事）
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let src = finalize_script_py(
            &python_str(part.to_str().unwrap()),
            &python_str(target.to_str().unwrap()),
            5,
            false,
            0,
            false,
        );
        let out = Command::new("python3")
            .arg("-c")
            .arg(&src)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);

        // 先把目录权限还回去，后面的断言失败也不留一个删不掉的临时目录
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            stdout.starts_with("__CCB_W_ERR__"),
            "必须仍走写回错误哨兵：{stdout}"
        );
        assert!(
            stdout.contains("Permission denied"),
            "原始错误不许被诊断信息盖掉：{stdout}"
        );
        assert!(
            stdout.contains("目标目录"),
            "必须点明是目录不可写（否则用户去 chmod 文件白费一轮）：{stdout}"
        );
        assert!(stdout.contains("0555"), "必须带出目录权限位 0555：{stdout}");
        assert!(
            stdout.contains("目录归你但无可写位"),
            "必须带出归属判断：{stdout}"
        );
    }

    /// 执行级（全平台）：正常保存路径必须照样跑通。
    ///
    /// 🔴 这条不只是 happy path：Python 在**解析期**就会拒掉整个脚本里的语法错，
    /// 所以它同时钉住「插进去的诊断片段没有把脚本写坏」——片段只在 EACCES 时
    /// 执行，但语法错会让每一次保存都当场变成 SyntaxError（数据丢失级）。
    /// 可写目录下平台差异无关紧要（Windows 也有 os.replace/os.stat）。
    #[test]
    fn finalize_script_py_succeeds_on_writable_file() {
        use std::process::Command;

        let has_py = Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_py {
            return;
        }

        let dir = std::env::temp_dir().join(format!("ccb-writeok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("ok.conf");
        let part = dir.join("ok.conf.ccb-write-1.part");
        std::fs::write(&target, b"old\n").unwrap();
        std::fs::write(&part, b"hello").unwrap();

        let src = finalize_script_py(
            &python_str(part.to_str().unwrap()),
            &python_str(target.to_str().unwrap()),
            5,
            false,
            0,
            false,
        );
        let out = Command::new("python3")
            .arg("-c")
            .arg(&src)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let content = std::fs::read_to_string(&target).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            stdout.contains("__CCB_W_OK__"),
            "正常保存必须走成功哨兵：stdout={stdout} stderr={stderr}"
        );
        assert!(!stdout.contains("__CCB_W_ERR__"), "不许误报：{stdout}");
        assert_eq!(content, "hello", "内容必须真的落到目标文件");
        assert!(
            !stderr.contains("SyntaxError"),
            "诊断片段把脚本写坏了：{stderr}"
        );
    }

    #[test]
    fn parse_viewer_reads_three_lines() {
        let v = parse_viewer("1004\n1006\n1006 1002 1003\n").unwrap();
        assert_eq!(v.uid, 1004);
        assert_eq!(v.gid, 1006);
        assert_eq!(v.groups, vec![1006, 1002, 1003]);
    }

    /// helper 是长驻 PTY 会话，输出前面可能挂着上一条命令的残留或 motd：
    /// 必须从**末尾**倒取三行，而不是正取。
    #[test]
    fn parse_viewer_ignores_leading_noise_and_crlf() {
        let v = parse_viewer("Last login: Tue Nov 24\r\nmotd: hi\r\n1004\r\n1006\r\n1006 1002\r\n")
            .unwrap();
        assert_eq!(v.uid, 1004);
        assert_eq!(v.gid, 1006);
        assert_eq!(v.groups, vec![1006, 1002]);
    }

    #[test]
    fn parse_viewer_rejects_incomplete_or_garbage() {
        assert!(parse_viewer("1004\n1006\n").is_err(), "缺组列表必须报错");
        assert!(parse_viewer("").is_err(), "空输出必须报错");
        assert!(
            parse_viewer("abc\n1006\n1006 1002\n").is_err(),
            "uid 不是数字必须报错（宁可整条失败让前端不预标，也不猜）"
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
        assert_eq!(r.encoding, "utf-8");
    }

    /// GBK 载荷：回退读路径与 russh 主路径必须同一套语义——解出文本并带回
    /// `encoding: "gbk"`，写回时才不会把文件静默转码成 UTF-8。
    #[test]
    fn parse_read_output_decodes_gbk_with_label() {
        let gbk = encoding_rs::GBK.encode("公用\r\n方法").0.into_owned();
        let out = format!(
            "__CCB_F_META__{{\"size\":{},\"mtime\":7,\"truncated\":false}}\n{}\n",
            gbk.len(),
            B64.encode(&gbk)
        );
        let r = parse_read_output(&out).unwrap();
        assert_eq!(r.content, "公用\n方法");
        assert_eq!(r.line_ending, "crlf");
        assert_eq!(r.encoding, "gbk");
    }

    /// 🔴 >2MB 的合法 UTF-8 文件曾被误判二进制（体验退化级）：限量读按字节切，
    /// 切点落在一个多字节汉字中间时，严格 decode 会把整个文件判成「不是文本」。
    /// 现在尾部残缺只退一个字符（`decode_utf8_truncated`），真二进制仍然拒绝。
    #[test]
    fn parse_read_output_tolerates_char_boundary_cut_but_rejects_real_binary() {
        // "世界" = E4 B8 96 | E7 95 8C；切在第 5 字节（第二个汉字只剩 1 字节）
        let mut bytes = "世界".as_bytes().to_vec();
        bytes.truncate(5);
        let out = format!(
            "__CCB_F_META__{{\"size\":6,\"mtime\":1,\"truncated\":true}}\n{}\n",
            B64.encode(&bytes)
        );
        let r = parse_read_output(&out).unwrap();
        assert_eq!(r.content, "世", "切点前的完整字符必须保住");
        assert!(r.truncated);
        assert_eq!(r.encoding, "utf-8");
        // 真二进制（中部非法字节）仍然拒绝——不能为了宽容截断把二进制当文本
        let out2 = format!(
            "__CCB_F_META__{{\"size\":4,\"mtime\":1,\"truncated\":false}}\n{}\n",
            B64.encode(b"ab\xffcd")
        );
        let err = parse_read_output(&out2).unwrap_err();
        assert!(err.starts_with(ERR_FILE_BINARY), "真二进制必须拒绝：{err}");
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
    fn chunked_write_embeds_force_flag() {
        let s = write_script_chunked("/a.txt", "aGk=", 5, true).expect("应能生成");
        assert!(s.contains("not True"));
        let s2 = write_script_chunked("/a.txt", "aGk=", 5, false).expect("应能生成");
        assert!(s2.contains("not False"));
    }

    /// 🔴 PTY 单行上限回归（曾表现为「保存转圈约 26 秒后成功 / >24KB 直接失败」）：
    /// helper 用 `-tt` 拿 PTY，Linux canonical 模式单行上限 4095 字节、超出的部分
    /// 被内核丢弃。老写法把整个 base64 塞进一行，内容约 2.4KB 起就被切坏。
    /// 分块写必须保证**每一条物理行**都在上限内——首行挂的开始哨兵与末行挂的
    /// 结束哨兵（`wrap_command` 加上的）也要算进去，所以这里按 4095 硬卡。
    #[test]
    fn chunked_write_keeps_every_physical_line_under_pty_limit() {
        // ≈700KB 的 base64，远超单行上限；路径也刻意取得很深
        let b64: String = "ABCD".repeat(700 * 1024 / 4);
        let long_path = format!("/home/user/projects/{}", "nested-dir/".repeat(40));
        let script =
            write_script_chunked(&long_path, &b64, 123, false).expect("普通长度路径应能分块");
        let lines: Vec<&str> = script.split('\n').collect();
        // finalize 是多行脚本，所以用 take_while 只取前面的分块行
        let chunk_lines: Vec<&str> = lines
            .iter()
            .copied()
            .take_while(|l| l.starts_with("printf '%s' '"))
            .collect();
        assert!(
            chunk_lines.len() > 100,
            "真分了块才对（{} 行）",
            chunk_lines.len()
        );
        assert!(chunk_lines.len() < lines.len(), "finalize 必须排在分块之后");
        for (i, l) in lines.iter().enumerate() {
            assert!(
                l.len() <= 4095,
                "第 {i} 行超限（{} 字节），PTY 会把它切坏：{}…",
                l.len(),
                &l[..l.len().min(60)]
            );
        }
        // 分块内容拼回来必须与原 base64 逐字一致（不能丢块/多块/乱序）
        let mut payload = String::new();
        for l in &chunk_lines {
            let rest = l.strip_prefix("printf '%s' '").expect("分块行形状");
            // base64 字母表不含单引号，所以载荷后的第一个引号就是收尾引号
            let end = rest.find('\'').expect("载荷后必有收尾引号");
            payload.push_str(&rest[..end]);
        }
        assert_eq!(payload, b64);
    }

    /// 路径长到连最小载荷都塞不进一行时必须放弃 helper 路线（返回 None），
    /// 让调用方改走 scp——**绝不生成超长行**。
    #[test]
    fn chunked_write_gives_up_on_absurdly_long_path() {
        let b64 = "ABCD".repeat(1024);
        let absurd = format!("/{}", "d/".repeat(3000));
        assert!(write_script_chunked(&absurd, &b64, 0, false).is_none());
    }

    /// 空内容（用户清空文件再保存）也要建一个空 part，否则 finalize 找不到要
    /// 替换的文件；finalize 的长度校验也必须知道期望是 0 字节。
    #[test]
    fn chunked_write_empty_content_still_creates_part() {
        let s = write_script_chunked("/a.txt", "", 0, false).expect("应能生成");
        let first = s.lines().next().unwrap();
        assert!(
            first.contains("printf '%s' '' >"),
            "空内容也要建空 part：{first}"
        );
        assert!(s.contains("n=0"), "长度校验的期望值要是 0");
    }

    /// finalize 必须保留旧脚本的三个关键性质，且排在所有分块之后。
    #[test]
    fn finalize_script_has_lock_atomic_replace_and_cleanup() {
        let s = finalize_script("/a.txt.ccb-write-1.part", "/a.txt", 10, true, 99, false);
        assert!(s.contains("__CCB_W_CONFLICT__"), "乐观锁标记要在");
        assert!(s.contains("__CCB_W_OK__"));
        assert!(s.contains("if len(raw)!=n:"), "必须校验分块完整性");
        assert!(s.contains("validate=True"), "base64 要严格校验");
        // 🔴 base64 路线必须**解码后写回 part** 再 rename。曾丢失：part 里躺着
        // base64 原文时直接 rename，用户存什么进去、读出来就是 base64 串——
        // 子串断言全绿，是执行级语义测试（真跑脚本）逮出来的。
        let decode_at = s.find("base64.b64decode").unwrap();
        let write_at = s.find("f.write(data)").unwrap();
        let replace_at = s.find("os.replace(part,t)").unwrap();
        assert!(
            decode_at < write_at && write_at < replace_at,
            "必须先解码、再写回、最后才 rename：\
             decode@{decode_at} write@{write_at} replace@{replace_at}"
        );
        assert!(s.contains("if True:"), "helper 路线要开解码写回分支");
        // scp 路线：part 里是原始字节，分支整个关掉
        let raw_route = finalize_script("/p.part", "/p", 3, false, 0, false);
        assert!(
            raw_route.contains("if False:"),
            "scp 路线要关掉解码写回分支（part 里就是原始字节）"
        );
        assert!(s.contains("os.chmod(part,mode)"), "要保留原文件权限位");
        assert!(
            s.contains("os.replace(part,t)"),
            "必须原子替换，不能原地写原文件"
        );
        assert!(s.contains("not False"));
        assert!(finalize_script("/p", "/a", 0, false, 0, true).contains("not True"));

        // chmod 失败必须**非致命**：权限错了是小事，内容存不进去是数据丢失
        //（russh 路径 set_metadata 失败同样只打日志，三条路径同一取舍）。
        let chmod_at = s.find("os.chmod(part,mode)").unwrap();
        let window = &s[chmod_at..(chmod_at + 120).min(s.len())];
        assert!(
            window.contains("except Exception:") && window.contains("pass"),
            "chmod 必须包在自己的 try 里、失败只 pass：{window}"
        );
        // rename **成功之后**的 stat 失败必须降级成 mtime/size=0，不能谎报失败
        //（保存已成功却报错，用户可能再 force 存一遍）。
        assert!(
            s.contains("__CCB_W_OK__{\"mtime\":0,\"size\":0}"),
            "replace 后的 stat 失败要降级成 0：{s}"
        );

        // 分块行全部排在 finalize 之前，否则 part 还没写完就去替换原文件了
        let full = write_script_chunked("/a.txt", &"A".repeat(20000), 0, false).expect("应能生成");
        let finalize_at = full.find("command -v python3").expect("finalize 必须在");
        let last_append = full.rfind("' >> ").expect("应有追加行");
        assert!(finalize_at > last_append, "finalize 必须排在所有分块之后");
    }

    /// 🔴 回归（数据丢失级）：`os.replace` / `mv` / SFTP `rename` 都**不跟随目标
    /// symlink**。编辑软链文件时读到的是目标内容，直接替换链接路径会把**链接本身**
    /// 换成普通文件——目标没改、链接静默消失、保存却显示成功。
    /// finalize 必须先解析出真实落点 `t`，且解析失败（断裂/成环）时拒绝保存。
    ///
    /// ⚠ 只断言**不含单引号**的片段：`finalize_script` 返回的是过了 `shell_quote`
    /// 的整条命令，python 里的 `'` 都被转义成 `'\''`，带路径的精确断言会在
    /// `symlink_resolve_py_lstat_then_realpath_and_refuses_when_unsure` 里对
    /// 纯函数做（不过引号转义，断言才真的咬得住）。
    #[test]
    fn finalize_script_resolves_symlink_before_replace() {
        let s = finalize_script("/a.txt.ccb-write-1.part", "/a.txt", 10, true, 99, false);
        assert!(
            s.contains("os.path.islink("),
            "必须用 lstat 语义判软链：{s}"
        );
        assert!(s.contains("os.path.realpath("), "必须解析真实落点：{s}");
        assert!(
            s.contains("软链目标不存在或无法解析"),
            "解析失败要拒绝保存，不能回退到替换链接：{s}"
        );
        // 拒绝分支必须带走 part（此时 part 已写完并通过校验，留着就是垃圾），
        // 且走的是 __CCB_W_ERR__ + 立刻退出
        let refuse_at = s.find("if not os.path.exists(rp):").unwrap();
        let window = &s[refuse_at..(refuse_at + 300).min(s.len())];
        assert!(
            window.contains("os.remove(")
                && window.contains("__CCB_W_ERR__")
                && window.contains("sys.exit(0)"),
            "拒绝前要清场并报错：{window}"
        );
        // 落点是变量 t：replace 的第二个参数永远不是引号字面量
        //（`os.replace(part,'...')` 正是要修的 bug 形态）
        assert!(
            s.contains("os.replace(part,t)"),
            "必须替换到解析出的真实落点：{s}"
        );
        assert!(
            !s.contains("os.replace(part,'"),
            "绝不能直接替换字面路径（那正是要修的 bug）：{s}"
        );
        assert!(s.contains("os.stat(t)"), "取新 mtime/size 也要看真实落点");
    }

    /// 纯片段（不过 shell_quote）：带路径的精确断言 + 拒绝分支形状。
    #[test]
    fn symlink_resolve_py_lstat_then_realpath_and_refuses_when_unsure() {
        let f = symlink_resolve_py("'/a.txt'", "'/a.txt.ccb-write-1.part'");
        assert!(
            f.contains("os.path.islink('/a.txt')"),
            "lstat 语义判软链：{f}"
        );
        assert!(
            f.contains("os.path.realpath('/a.txt')"),
            "解析真实落点：{f}"
        );
        assert!(f.starts_with("t='/a.txt'"), "t 的初值是字面路径：{f}");
        assert!(
            f.contains("sys.exit(0)"),
            "拒绝保存要立刻退出，不能继续替换：{f}"
        );
        assert!(
            f.contains("__CCB_W_ERR__"),
            "拒绝要走错误哨兵，不能静默：{f}"
        );
        // 拒绝时自己删临时文件：此时 part 已写完并通过校验，留着就是垃圾
        assert!(
            f.contains("os.remove('/a.txt.ccb-write-1.part')"),
            "拒绝分支要带走临时文件：{f}"
        );
        // 片段本身不做任何替换（出口统一是变量 t）
        assert!(!f.contains("os.replace"), "片段只负责解析，不碰替换：{f}");
    }

    /// C 路线回传的 scp 兜底也走同一套解析（原来是 `mv -f`，同样不跟随软链）。
    #[test]
    fn upload_edited_fallback_resolves_symlink() {
        // 直接对片段断言：两处调用点（finalize_script / upload_edited）必须同源。
        let frag = symlink_resolve_py(
            &python_str("/data/conf.d/default"),
            &python_str("/data/conf.d/default.ccb-up-7.tmp"),
        );
        assert!(frag.contains("os.path.islink('/data/conf.d/default')"));
        assert!(frag.contains("os.path.realpath('/data/conf.d/default')"));
        // 片段的出口统一是变量 t
        assert!(frag.starts_with("t='/data/conf.d/default'"), "{frag}");
        // 拒绝时删的是 scp 落地的那个临时文件，不是别的
        assert!(
            frag.contains("os.remove('/data/conf.d/default.ccb-up-7.tmp')"),
            "{frag}"
        );
    }
}
