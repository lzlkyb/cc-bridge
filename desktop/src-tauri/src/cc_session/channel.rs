//! 命令行构造：把「在哪跑、跑什么」翻成一条可执行命令。
//!
//! ## 一条铁律：stdin 与 stdout 是协议通道
//!
//! claude 在 `--input-format stream-json` 下从 **stdin** 读用户消息、往 **stdout**
//! 写 NDJSON。所以任何包装都不能吃掉这两根管道：
//!
//! - 远端**不能**用「stdin 写脚本」的三步法（`ssh host "tee /tmp/x.sh"` + 再跑一次），
//!   那会把 stdin 占掉，user 消息就没地方写了。
//! - 改用 **base64 单参传递**：`ssh host "echo <b64> | base64 -d | bash"`。
//!   base64 只有 `A-Za-z0-9+/=`，不进任何 shell 元字符，彻底绕开引号地狱；
//!   脚本内 `exec` 让远端 bash 被 claude 替换，stdin/stdout 原样直通，
//!   进程组 kill → ssh 断 → 远端 SIGHUP 直达 claude，中断语义与本地一致。
//!
//! ## 为什么必须 `bash -lc` 探测、却用绝对路径执行
//!
//! `claude` 常装在 `~/.local/bin`，**非登录 shell 的 PATH 探不到**（源码分析 §四.1）。
//! 所以探测走 `bash -lc "command -v claude"`，但执行时用探测到的**绝对路径** ——
//! 因为真正跑起来的那个 bash 是非登录的（`base64 -d | bash`），它没有那份 PATH。

use std::path::PathBuf;

use base64::Engine;

use crate::mcp::bridge::spawn;

/// 这几个参数不能由调用方改：改一个协议就断。
///
/// - `--print` + `--input-format stream-json`：无头流式模式的前提。
/// - `--verbose`：`--output-format stream-json` 的硬性要求。
/// - `--include-partial-messages`：打字机效果的来源；不发就整块蹦出来。
/// - `--permission-prompt-tool stdio`：让「要批准」走控制协议而不是终端提示。
///   它同时负责挂载 `AskUserQuestion` —— 不传这个旗标，CLI 会把所有 ask 当终端交互，
///   `AskUserQuestion` 根本不会出现（源码分析 §三.5）。
const PROTOCOL_ARGS: &[&str] = &[
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

/// 权限模式白名单。与 CLI 的 `--permission-mode` 取值同名。
///
/// 🔴 走白名单而不是直接拼字符串：这个值来自前端，拼错了轻则 CLI 启动失败，
/// 重则落到一个没预料到的模式上。
pub const PERMISSION_MODES: &[&str] = &["plan", "default", "acceptEdits", "bypassPermissions"];

/// 一轮对话的启动参数。
#[derive(Debug, Clone, Default)]
pub struct LaunchSpec {
    /// 远端工作目录（本地模式走 `current_dir`，不进命令行）。
    pub cwd: Option<String>,
    pub model: Option<String>,
    /// 空 = 用 CLI 默认（`default`）。
    pub permission_mode: Option<String>,
    /// 上一轮的 `session_id`。跨进程续接的唯一手段。
    pub resume: Option<String>,
}

impl LaunchSpec {
    /// 拼出 claude 自己的参数表（不含可执行文件与传输层）。
    pub fn claude_args(&self) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = PROTOCOL_ARGS.iter().map(|s| (*s).to_string()).collect();
        if let Some(mode) = self.permission_mode.as_deref() {
            let mode = mode.trim();
            if !mode.is_empty() {
                if !PERMISSION_MODES.contains(&mode) {
                    return Err(format!("未知的权限模式：{mode}"));
                }
                args.push("--permission-mode".into());
                args.push(mode.to_string());
            }
        }
        if let Some(model) = self
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            args.push("--model".into());
            args.push(model.to_string());
        }
        if let Some(resume) = self
            .resume
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
        {
            // 🔴 `--resume` 只认 session id，不认路径。传路径会被 CLI 当 id 去查，
            // 查不到就报错退出 —— 一条极难从界面看出来的失败。
            args.push("--resume".into());
            args.push(resume.to_string());
        }
        Ok(args)
    }
}

/// 本机跑：`<claude 绝对路径> <args…>`。
pub fn local_command(
    claude_path: &str,
    spec: &LaunchSpec,
) -> Result<(PathBuf, Vec<String>), String> {
    let program = spawn::resolve_program(claude_path).map_err(|e| format!("找不到 claude：{e}"))?;
    Ok((program, spec.claude_args()?))
}

/// SSH 远端跑：`ssh <opts> -- user@host "echo <b64> | base64 -d | bash"`。
///
/// `ssh_args` 由调用方给（含 `ProxyCommand` 等连接选项），本函数只管
/// 「怎么把 claude 命令安全地送过去」。
pub fn remote_command(
    ssh_args: &[String],
    destination: &str,
    claude_path: &str,
    spec: &LaunchSpec,
) -> Result<(PathBuf, Vec<String>), String> {
    let mut script = String::new();
    if let Some(cwd) = spec.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        script.push_str(&format!("cd {} || exit 97\n", shell_quote(cwd)));
    }
    // `exec` 是关键：它让远端 bash 被 claude 替换掉，于是 stdin/stdout 不再经过
    // 任何中间层，Ctrl+C / 进程组 kill 的语义与本地完全一致。
    script.push_str("exec ");
    script.push_str(&shell_quote(claude_path));
    for arg in spec.claude_args()? {
        script.push(' ');
        script.push_str(&shell_quote(&arg));
    }

    ssh_bash_script(ssh_args, destination, &script)
}

/// 把一段 bash 正文送成一条 ssh 命令：`echo <b64> | base64 -d | (bash || sh)`。
///
/// 抽出来给托管那几条命令共用。base64 里只有 `A-Za-z0-9+/=`，不进任何 shell 元字符，
/// 所以正文里可以有引号、换行、heredoc，都不需要二次转义。
fn ssh_bash_script(
    ssh_args: &[String],
    destination: &str,
    script: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let program = spawn::resolve_program("ssh")
        .or_else(|_| spawn::resolve_program("ssh.exe"))
        .map_err(|e| format!("未检测到系统 OpenSSH 客户端：{e}"))?;

    let payload = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    let mut args: Vec<String> = ssh_args.to_vec();
    // `--` 终结 getopt：destination 永远不会被当成选项。
    args.push("--".into());
    args.push(destination.to_string());
    // `base64 -d` 在 busybox / GNU 上都一样；`bash` 不存在时退 `sh`（两者语法在此无差）。
    args.push(format!("echo {payload} | base64 -d | (bash || sh)"));
    Ok((program, args))
}

/// 探测远端 claude 的脚本：**登录 shell** 才有 `~/.local/bin`。
pub fn probe_script() -> &'static str {
    r#"p=$(bash -lc 'command -v claude' 2>/dev/null); if [ -z "$p" ]; then p=$(command -v claude 2>/dev/null); fi; if [ -z "$p" ]; then echo "__CC_MISSING__"; else printf '__CC_PATH__%s\n' "$p"; fi"#
}

/// 润色（prompt-polish）用的 claude 参数：一次性 `-p --bare`。
///
/// - `-p`：无头打印模式，stdout 即结果。
/// - `--bare` = "Minimal mode: skip hooks"（2026-10-24 探针确认）—— 省掉
///   SessionStart 钩子那 12~19s 冷启动。润色是按钮点击的一次性动作，等不起。
///
/// 🔴 提示词走 **stdin**，不进 argv：Windows `CreateProcess` 的 32767 字符上限下，
/// 两万字的草稿（中文按 UTF-16 还要翻倍）会把命令直接撑爆。
pub const POLISH_ARGS: &[&str] = &["-p", "--bare"];

/// 本机润色：`<claude 绝对路径> -p --bare`，提示词经 stdin。
pub fn polish_local(claude_path: &str) -> Result<(PathBuf, Vec<String>), String> {
    let program = spawn::resolve_program(claude_path).map_err(|e| format!("找不到 claude：{e}"))?;
    Ok((program, POLISH_ARGS.iter().map(|s| s.to_string()).collect()))
}

/// 远端润色：`ssh <opts> -- user@host "exec '<claude>' -p --bare"`。
///
/// 提示词经 **ssh 的 stdin** 直达远端 claude 的 stdin —— ssh 本来就把本地
/// stdin 转发给远程命令，不需要任何中间层。
///
/// 🔴 这里**不走 base64 引导**（`echo <b64> | base64 -d | bash`）：那个形状会把
/// stdin 占给脚本本身，claude 一个字都读不到。命令串里没有任何用户数据
/// （只有探测得来的绝对路径），单引号转义足够。
pub fn polish_remote(
    ssh_args: &[String],
    destination: &str,
    claude_path: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let program = spawn::resolve_program("ssh")
        .or_else(|_| spawn::resolve_program("ssh.exe"))
        .map_err(|e| format!("未检测到系统 OpenSSH 客户端：{e}"))?;
    let mut script = String::from("exec ");
    script.push_str(&shell_quote(claude_path));
    for arg in POLISH_ARGS {
        script.push(' ');
        script.push_str(&shell_quote(arg));
    }
    let mut args: Vec<String> = ssh_args.to_vec();
    args.push("--".into());
    args.push(destination.to_string());
    args.push(script);
    Ok((program, args))
}

/// POSIX 单引号转义。`'` → `'\''` 是唯一可靠且不依赖 locale 的写法。
fn shell_quote(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('\'');
    for ch in raw.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

// ===================== 批 3-2：托管会话（tmux + FIFO + 日志） =====================
//
// 结构与理由见 `docs/批3-2结构方案-2026-10-25.md`。这里只有**纯字符串构造**，
// 一行都不碰运行时 —— 目的是「先把脚本钉死在单测里」，再接线。
//
// 远端文件布局（全部相对 `$HOME`，**不在本地展开**，因为 `$HOME` 是远端的）：
//
// ```text
// ~/.cc-bridge/hosted/<key>.in      FIFO，我们往里写 NDJSON
// ~/.cc-bridge/hosted/<key>.out     日志，我们 tail 它拿 NDJSON
// ~/.cc-bridge/hosted/<key>.sh      worker 脚本（自己从 $0 推路径，免掉传参引号）
// ```

/// 会话名：`cc-<内部 id>-<启动毫秒>`。
///
/// 带时间戳是必须的：同一条内部 id 可能先后托管多次（上一次被 kill 了）。
/// 名字不带时间戳就会撞上一个**已经死掉的名字**，`has-session` 判出「活着」而其实是别人。
pub fn hosted_key(internal_id: u64, started_at_ms: u64) -> String {
    format!("cc-{internal_id}-{started_at_ms}")
}

/// 会话名只允许这些字符。它会进 tmux 的 `-t` 参数与远端路径，不能有空格/引号/斜杠。
fn assert_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法的托管会话名：{key:?}"))
    }
}

/// 远端目录（`$HOME` 故意不展开：它在远端才有值）。
fn hosted_dir() -> &'static str {
    "$HOME/.cc-bridge/hosted"
}

/// 起托管会话：建目录 / FIFO / worker，然后在 tmux 里把 worker 拉起来。
///
/// 返回的脚本 stdout 上有一行 `__LOG__<路径>`，调用方据此记下日志位置（拿不到就是没起来）。
///
/// ## worker 里那两个 `exec` 是整个方案的支点
///
/// ```text
/// exec 9<>"$B.in"   # 读写双开：同一个 open file description 既是读端又是写端
/// exec <&9          # claude 的 stdin 接到它
/// exec claude ...   # 替换掉 shell（fd 9 仍然被 claude 继承）
/// ```
///
/// 本地写端关闭时，**读端拿不到 EOF**（我们自己还持有一个写著）—— 进程不会自杀。
/// 写成 `exec 9<"$B.in"` 时断线即退出，而现象与成功一模一样（日志还在、看起来在跑），
/// 隔一会儿回来才发现它已经死了。探针 [4] 专门验这一条。
pub fn hosted_bootstrap_script(
    claude_path: &str,
    spec: &LaunchSpec,
    key: &str,
) -> Result<String, String> {
    assert_key(key)?;
    let key_q = shell_quote(key);

    // claude 的完整命令行（cwd 在 worker 里单独 cd，因为要在 exec 之前）。
    let mut cmd = shell_quote(claude_path);
    for arg in spec.claude_args()? {
        cmd.push(' ');
        cmd.push_str(&shell_quote(&arg));
    }
    let cd_line = match spec.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(cwd) => format!("cd {} || exit 97\n", shell_quote(cwd)),
        None => String::new(),
    };

    // worker 正文用**带引号的 heredoc**（`<<'SH'`）：里面一个字都不展开，
    // 所以上面已经 quote 好的内容原样落地，不需要二次转义。
    Ok(format!(
        r#"set -e
D="{dir}"
mkdir -p "$D"
K={key_q}
FIFO="$D/$K.in"; LOG="$D/$K.out"; W="$D/$K.sh"
# 同名会话可能还活着（上一次没杀掉）：先杀，避免 tmux 拒绝再建同名会话。
tmux kill-session -t "$K" 2>/dev/null || true
rm -f "$FIFO" "$LOG"
mkfifo -m 600 "$FIFO"
: > "$LOG"
cat > "$W" <<'SH'
#!/bin/bash
B="${{0%.sh}}"
exec 9<>"$B.in"
exec <&9
{cd_line}exec {cmd} >>"$B.out" 2>&1
SH
chmod +x "$W"
tmux new-session -d -s "$K" "bash '$W'"
printf '__LOG__%s\n' "$LOG"
"#,
        dir = hosted_dir(),
    ))
}

/// 起托管会话的那条 ssh（短命：跑完就退，不占 stdin/stdout）。
pub fn hosted_bootstrap(
    ssh_args: &[String],
    destination: &str,
    script: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    ssh_bash_script(ssh_args, destination, script)
}

/// 读通道：`exec tail -n +<N> -F <log>`。
///
/// `N` 从 1 起（`tail -n +1` = 从头）。用**行**不用字节：协议单位是行，
/// 按字节切可能落在一个 UTF-8 字符或一行 JSON 的正中间。
///
/// `exec` 让远端 bash 被 tail 替换：本地这条 ssh 一断，tail 立刻跟着死，
/// 不留孤儿进程（claude 不受影响 —— 它挂在 tmux 里，不挂在这条 ssh 上）。
pub fn hosted_attach(
    ssh_args: &[String],
    destination: &str,
    key: &str,
    from_line: u64,
) -> Result<(PathBuf, Vec<String>), String> {
    assert_key(key)?;
    let n = from_line.max(1);
    let script = format!("exec tail -n +{} -F \"{}/{}.out\"", n, hosted_dir(), key);
    ssh_bash_script(ssh_args, destination, &script)
}

/// 写通道：`exec cat > <fifo>`。
///
/// 本地这条 ssh 的 **stdin 就是 claude 的 stdin**（中间只隔一层 cat + FIFO），
/// 所以 `user_message_line` / `control_response_line` 原样写进来即可。
///
/// 🔴 这条 ssh 会一直挂着（我们持续往里写）。它可能被 NAT / 超时静默掐掉 ——
/// 写入报错时先重建它再重试一次，**不许**因为写失败就判进程已死
/// （结构方案 §八.1）。
pub fn hosted_write(
    ssh_args: &[String],
    destination: &str,
    key: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    assert_key(key)?;
    let script = format!("exec cat > \"{}/{}.in\"", hosted_dir(), key);
    ssh_bash_script(ssh_args, destination, &script)
}

/// 结束托管会话：杀 tmux 会话并清掉三个文件。
///
/// 🔴 托管会话**没有别的结束方式**。直连时「关 stdin = 送 EOF 让它收尾退出」，
/// 而托管的写端关闭按设计**不会**让 claude 收到 EOF（那正是它能活下来的原因）。
pub fn hosted_kill(
    ssh_args: &[String],
    destination: &str,
    key: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    assert_key(key)?;
    let script = format!(
        "D=\"{dir}\"; K={key_q}\n\
         tmux kill-session -t \"$K\" 2>/dev/null || true\n\
         rm -f \"$D/$K.in\" \"$D/$K.out\" \"$D/$K.sh\"\n",
        dir = hosted_dir(),
        key_q = shell_quote(key),
    );
    ssh_bash_script(ssh_args, destination, &script)
}

/// 存活判据：`tmux has-session`（退出码 0 = 活）。
///
/// 🔴 这是托管会话**唯一**可信的存活判据。`Exit` 事件每轮都会来（CLI 收到 `result`
/// 后不退出），读通道的 ssh 也会随断网单独死掉 —— 拿这两个判「进程死没死」，
/// 结果是**再起一个 claude 带 `--resume`，两个进程同时写同一条会话的转录**。
pub fn hosted_alive(
    ssh_args: &[String],
    destination: &str,
    key: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    assert_key(key)?;
    let script = format!("exec tmux has-session -t {}", shell_quote(key));
    ssh_bash_script(ssh_args, destination, &script)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> LaunchSpec {
        LaunchSpec {
            cwd: Some("/home/u/proj".into()),
            model: Some("claude-sonnet-4-5".into()),
            permission_mode: Some("default".into()),
            resume: Some("s-1".into()),
        }
    }

    #[test]
    fn protocol_args_are_always_present() {
        let args = LaunchSpec::default().claude_args().expect("拼参数");
        for required in [
            "--print",
            "--input-format",
            "--output-format",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
        ] {
            assert!(
                args.iter().any(|a| a == required),
                "缺 {required}：{args:?}"
            );
        }
        assert!(
            args.iter().any(|a| a == "stdio"),
            "permission-prompt-tool 必须是 stdio"
        );
    }

    #[test]
    fn unknown_permission_mode_is_rejected() {
        let bad = LaunchSpec {
            permission_mode: Some("yolo".into()),
            ..LaunchSpec::default()
        };
        let err = bad.claude_args().expect_err("必须拒绝");
        assert!(err.contains("yolo"), "{err}");
    }

    /// 🔴 `--resume` 只认 session id；空串不能变成「多传一个 --resume」。
    #[test]
    fn empty_resume_is_not_emitted() {
        for resume in [None, Some(String::new()), Some("   ".into())] {
            let spec = LaunchSpec {
                resume,
                ..LaunchSpec::default()
            };
            let args = spec.claude_args().expect("拼参数");
            assert!(!args.iter().any(|a| a == "--resume"), "{args:?}");
        }
    }

    /// 远端脚本必须 `exec`，否则 claude 的 stdin/stdout 会被中间 bash 吃掉。
    #[test]
    fn remote_payload_starts_with_cd_and_uses_exec() {
        let (_, args) = remote_command(&[], "u@h", "/usr/bin/claude", &spec()).expect("构造");
        let bootstrap = args.last().expect("末位是引导串");
        assert!(bootstrap.starts_with("echo "), "{bootstrap}");
        assert!(bootstrap.contains("base64 -d"), "{bootstrap}");
        // 解出脚本本体核对内容。
        let b64 = bootstrap
            .trim_start_matches("echo ")
            .split_whitespace()
            .next()
            .expect("payload");
        let script = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .expect("解 base64"),
        )
        .expect("UTF-8");
        assert!(
            script.starts_with("cd '/home/u/proj' || exit 97"),
            "{script}"
        );
        assert!(script.contains("\nexec '/usr/bin/claude'"), "{script}");
        // 参数逐个被单引号包住。
        assert!(script.contains("'--input-format'"), "{script}");
        assert!(script.contains("'stream-json'"), "{script}");
    }

    /// base64 里不能出现任何 shell 元字符 —— 这是整条方案成立的前提。
    #[test]
    fn payload_has_no_shell_metacharacters() {
        let nasty = LaunchSpec {
            cwd: Some("/tmp/a b'c$(rm -rf /);`x`".into()),
            ..spec()
        };
        let (_, args) = remote_command(&[], "u@h", "/usr/bin/claude", &nasty).expect("构造");
        let bootstrap = args.last().expect("末位");
        let payload = bootstrap
            .trim_start_matches("echo ")
            .split_whitespace()
            .next()
            .expect("payload");
        for ch in payload.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='),
                "payload 里出现非 base64 字符 {ch:?}"
            );
        }
        // 而解出来的脚本里，危险字符已被单引号关住。
        let script = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .expect("解 base64"),
        )
        .expect("UTF-8");
        assert!(script.contains(r"/tmp/a b'\''c$(rm -rf /);`x`"), "{script}");
    }

    #[test]
    fn ssh_args_are_prefixed_before_destination() {
        let ssh_args = vec!["-p".to_string(), "2222".to_string()];
        let (_, args) = remote_command(&ssh_args, "u@h", "/usr/bin/claude", &spec()).expect("构造");
        assert_eq!(&args[..3], &["-p", "2222", "--"]);
        assert_eq!(args[3], "u@h");
    }

    // ---- 润色（prompt-polish）命令构造 ----

    #[test]
    fn polish_local_passes_bare_flag_and_no_prompt_in_argv() {
        let (_, args) = polish_local("claude").expect("构造");
        assert_eq!(args, vec!["-p".to_string(), "--bare".to_string()]);
    }

    /// 远端润色的命令串里**不能有用户数据**：提示词走 ssh stdin，
    /// 命令里只有探测来的绝对路径。这也是它不走 base64 引导的原因。
    #[test]
    fn polish_remote_keeps_prompt_out_of_command_line() {
        let (_, args) = polish_remote(&[], "u@h", "/home/u/.local/bin/claude").expect("构造");
        let script = args.last().expect("末位是远端命令");
        assert!(script.starts_with("exec '"), "{script}");
        assert!(script.contains("'-p'"), "{script}");
        assert!(script.contains("'--bare'"), "{script}");
        assert!(script.contains("'/home/u/.local/bin/claude'"), "{script}");
        // 没有 base64 / 管道中间层：stdin 必须直通 claude。
        assert!(!script.contains("base64"), "{script}");
        assert!(!script.contains('|'), "{script}");
    }

    /// 路径里的单引号必须被关住，不能把远端命令劈开。
    #[test]
    fn polish_remote_quotes_nasty_paths() {
        let (_, args) = polish_remote(&[], "u@h", "/tmp/it's/claude").expect("构造");
        let script = args.last().expect("末位");
        assert!(script.contains(r"'\''"), "{script}");
    }

    // ---- 批 3-2：托管会话的命令构造 ----

    /// 把 `ssh_bash_script` 产出的那条命令解回脚本正文。
    fn decode_script(args: &[String]) -> String {
        let bootstrap = args.last().expect("末位是引导串");
        assert!(bootstrap.starts_with("echo "), "{bootstrap}");
        assert!(bootstrap.contains("base64 -d"), "{bootstrap}");
        let b64 = bootstrap
            .trim_start_matches("echo ")
            .split_whitespace()
            .next()
            .expect("payload");
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .expect("解 base64"),
        )
        .expect("UTF-8")
    }

    #[test]
    fn hosted_key_carries_start_time_so_dead_sessions_cannot_be_confused() {
        assert_eq!(hosted_key(7, 1_700_000_000_000), "cc-7-1700000000000");
        // 同一条内部 id 两次托管必须不同名，否则 `has-session` 会认到上一次的尸体。
        assert_ne!(hosted_key(7, 1), hosted_key(7, 2));
    }

    /// 会话名会进 `tmux -t` 与远端路径，必须拒绝任何会在 shell 里跑偏的字符。
    #[test]
    fn hosted_rejects_dangerous_keys() {
        for bad in [
            "",
            "cc 1",
            "cc;rm -rf /",
            "cc/1",
            "cc$(id)",
            "cc'1",
            "cc\n1",
        ] {
            let e = hosted_alive(&[], "u@h", bad).expect_err("必须拒绝");
            assert!(e.contains("非法"), "{bad:?} → {e}");
        }
        // 正常形态要过。
        assert!(hosted_alive(&[], "u@h", "cc-12-1700000000000").is_ok());
    }

    /// 🔴 支点：worker 必须 `exec 9<>`（读写双开），不能是 `<`。
    /// 写成 `<` 时断线即退出，而现象和成功一模一样 —— 这条断言就是防这个。
    #[test]
    fn bootstrap_worker_opens_fifo_read_write_so_eof_cannot_kill_it() {
        let script = hosted_bootstrap_script("/usr/bin/claude", &spec(), "cc-1-2").expect("构造");
        assert!(
            script.contains(r#"exec 9<>"$B.in""#),
            "必须是读写双开（<>），否则断线时读端拿到 EOF 直接退出：{script}"
        );
        assert!(
            !script.contains(r#"exec 9<"$B.in""#),
            "出现了只读打开：{script}"
        );
        // claude 的 stdin 接到那一份 fd 上。
        assert!(script.contains("exec <&9"), "{script}");
        // 日志与 FIFO 由 `$0` 推出来，不从命令行传 —— 少一层引号风险。
        assert!(script.contains(r#"B="${0%.sh}""#), "{script}");
    }

    #[test]
    fn bootstrap_creates_fifo_and_starts_detached_tmux_session() {
        let script = hosted_bootstrap_script("/usr/bin/claude", &spec(), "cc-1-2").expect("构造");
        assert!(script.contains("mkfifo -m 600"), "{script}");
        assert!(
            script.contains(r#"tmux new-session -d -s "$K""#),
            "{script}"
        );
        // 同名残留要先杀，否则 tmux 拒绝建同名会话，而我们以为起来了。
        assert!(
            script.contains(r#"tmux kill-session -t "$K" 2>/dev/null || true"#),
            "{script}"
        );
        // 路径在远端展开（$HOME 只有远端知道），所以本地不能把它 quote 死。
        assert!(
            script.contains(r#"D="$HOME/.cc-bridge/hosted""#),
            "{script}"
        );
        // 把日志位置回给调用方，拿不到就是没起来。
        assert!(script.contains("__LOG__"), "{script}");
    }

    /// cwd 与 claude 参数都要原样进 worker，且危险字符被单引号关住。
    #[test]
    fn bootstrap_embeds_cwd_and_args_with_quoting() {
        let nasty = LaunchSpec {
            cwd: Some("/tmp/a b'c$(rm -rf /)".into()),
            resume: Some("s'1".into()),
            ..spec()
        };
        let script = hosted_bootstrap_script("/usr/bin/claude", &nasty, "cc-1-2").expect("构造");
        assert!(
            script.contains(r#"cd '/tmp/a b'\''c$(rm -rf /)' || exit 97"#),
            "{script}"
        );
        assert!(script.contains(r#"'/usr/bin/claude'"#), "{script}");
        assert!(script.contains("--resume' 's'\\''1"), "{script}");
    }

    /// 没有 cwd 时不能留下一条空的 `cd` 行（`cd` 空参会跑到家目录）。
    #[test]
    fn bootstrap_without_cwd_emits_no_cd_line() {
        let no_cwd = LaunchSpec {
            cwd: None,
            ..spec()
        };
        let script = hosted_bootstrap_script("/usr/bin/claude", &no_cwd, "cc-1-2").expect("构造");
        assert!(!script.contains(" cd "), "{script}");
        assert!(!script.contains("cd '"), "{script}");
        // 正文里直接就是 exec claude。
        assert!(script.contains(r#"exec '/usr/bin/claude'"#), "{script}");
    }

    #[test]
    fn attach_tails_the_log_from_the_requested_line() {
        let (_, args) = hosted_attach(&[], "u@h", "cc-1-2", 42).expect("构造");
        let script = decode_script(&args);
        assert!(
            script.contains(r#"exec tail -n +42 -F "$HOME/.cc-bridge/hosted/cc-1-2.out""#),
            "{script}"
        );
        // `exec`：本地 ssh 一断，tail 立刻跟着死，不留孤儿（claude 不挂在这条 ssh 上）。
        assert!(script.starts_with("exec "), "{script}");
    }

    /// 游标 0 要变成 `+1`（`tail -n +0` 是未定义写法）。
    #[test]
    fn attach_clamps_zero_cursor_to_first_line() {
        let (_, args) = hosted_attach(&[], "u@h", "cc-1", 0).expect("构造");
        let script = decode_script(&args);
        assert!(script.contains("tail -n +1 "), "{script}");
        assert!(!script.contains("tail -n +0"), "{script}");
    }

    /// 写通道的 stdin 必须直通 FIFO：中间只许有一层 cat，不许再有别的管道。
    #[test]
    fn write_channel_is_a_plain_cat_into_the_fifo() {
        let (_, args) = hosted_write(&[], "u@h", "cc-1-2").expect("构造");
        let script = decode_script(&args);
        assert_eq!(script, r#"exec cat > "$HOME/.cc-bridge/hosted/cc-1-2.in""#);
    }

    #[test]
    fn kill_removes_session_and_files() {
        let (_, args) = hosted_kill(&[], "u@h", "cc-1-2").expect("构造");
        let script = decode_script(&args);
        assert!(script.contains(r#"tmux kill-session -t "$K""#), "{script}");
        // 三个文件在同一条 `rm -f` 里，所以只能按文件名断言（`rm -f ` 只出现在第一个前面）。
        for name in ["in", "out", "sh"] {
            let needle = format!("\"$D/$K.{name}\"");
            assert!(script.contains(&needle), "缺 {needle}：{script}");
        }
        assert!(script.contains("rm -f "), "{script}");
        // 找不到会话也要算成功（幂等：重复关闭不该报错）。
        assert!(script.contains("|| true"), "{script}");
    }

    /// 存活判据只能靠 `tmux has-session`，不能靠读通道/`Exit` 事件。
    #[test]
    fn alive_is_decided_by_tmux_has_session() {
        let (_, args) = hosted_alive(&[], "u@h", "cc-1-2").expect("构造");
        let script = decode_script(&args);
        assert_eq!(script, r#"exec tmux has-session -t 'cc-1-2'"#);
    }
}
