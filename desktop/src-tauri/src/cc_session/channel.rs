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
    let program = spawn::resolve_program("ssh")
        .or_else(|_| spawn::resolve_program("ssh.exe"))
        .map_err(|e| format!("未检测到系统 OpenSSH 客户端：{e}"))?;

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
}
