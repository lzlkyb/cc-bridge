//! 命令执行壳层抽象（借鉴 Claude Code `ShellProvider`）。
//!
//! cc-bridge 的 run_command 原本硬编码 `cmd /C`。本模块把「被 spawn 的可执行文件 + 参数形态」
//! 抽成 `ShellType` + `build_invocation`，支持：
//! - `cmd`（默认，零外部依赖）；
//! - `bash`（Git Bash，需安装 Git for Windows）——命令用 bash 语法、路径用 POSIX `/c/...`，
//!   与远端 Claude Code 的命令词汇对齐，引号/管道/`jq`/`find` 不易写错。
//!
//! 安全要点（与 Claude Code 一致）：
//! - bash 模式注入 `MSYS_NO_PATHCONV=1`，关掉 MSYS 诡异的 argv 路径自动转换，行为可预测；
//! - bash 模式包裹 `shopt -u extglob`，防白名单校验通过后恶意文件名在 shell 展开期被扩展；
//! - cwd 持久化靠「命令结束写 pwd 到临时文件、Rust 侧读回」的 pwd 文件法（见 run_command.rs），
//!   每条命令仍独立 spawn、逐条重校验白名单，**不削弱**任何安全围栏。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 命令执行使用的 shell 类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellType {
    /// Windows `cmd.exe`，零外部依赖（默认）。
    Cmd,
    /// Git Bash（`bash.exe`），需安装 Git for Windows。
    Bash,
}

impl ShellType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ShellType::Cmd => "cmd",
            ShellType::Bash => "bash",
        }
    }
}

/// 把配置字符串解析为 ShellType；仅 `"bash"` 识别为 Bash，其它一律 Cmd（安全回退）。
pub fn parse_shell_type(s: &str) -> ShellType {
    if s == "bash" {
        ShellType::Bash
    } else {
        ShellType::Cmd
    }
}

/// Git Bash 可执行文件的常见安装位置（按优先级）。
const BASH_CANDIDATES: &[&str] = &[
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Git\\bin\\bash.exe",
    "C:\\Git\\usr\\bin\\bash.exe",
];

/// 探测 Git Bash 的 `bash.exe`（缓存结果，避免每条命令都 spawn `where`）。
/// 找不到返回 None（调用方据此报错，由上层决定是否回退 cmd）。
fn detect_bash_exe_inner() -> Option<PathBuf> {
    for c in BASH_CANDIDATES {
        if Path::new(c).is_file() {
            return Some(PathBuf::from(c));
        }
    }
    // 兜底：在 PATH 里用 `where bash` 找（Git 安装时通常把 bin 加入 PATH）。
    if let Ok(out) = std::process::Command::new("where").arg("bash").output() {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = stdout.lines().next() {
                let p = first.trim();
                if !p.is_empty() {
                    return Some(PathBuf::from(p));
                }
            }
        }
    }
    None
}

/// 缓存探测结果：启动时首次调用扫描磁盘，之后永不重探。
/// 若安装 Git for Windows 后需要 bash，重启 cc-bridge 即可识别。
static BASH_EXE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 返回探测到的 bash.exe 路径。
/// 仅在首次调用时扫描文件系统（`OnceLock`），之后走内存缓存，
/// 不会在 5s 轮询 `get_status` 时反复触发 Windows 文件系统钩子。
pub fn detect_bash_exe() -> Option<PathBuf> {
    BASH_EXE.get_or_init(detect_bash_exe_inner).clone()
}

/// Windows 原生路径 → MSYS/Git Bash 的 POSIX 路径。
/// 例：`C:\Users\foo` → `/c/Users/foo`；`\\?\C:\Users\foo`（verbatim）先去前缀。
/// 无法识别盘符时返回原样 `/`-化路径（best-effort）。
pub fn windows_to_posix(path: &Path) -> String {
    let s = path.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let s = s.replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = s[..1].to_ascii_lowercase();
        format!("/{drive}{}", &s[2..])
    } else {
        s
    }
}

/// 单引号转义，用于把用户命令包进 `eval '...'`。
/// 规则：把 `'` 替换为 `'\''`，整体再用单引号包裹（对齐 Claude Code 的 shellQuoting）。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 把 shell 写回 cwd 文件的路径规整为 Rust/Windows 可用的 PathBuf。
/// - bash 经 `pwd -P` 写的是 POSIX（`/c/Users/foo`）→ 转回 `C:\Users\foo`；
/// - cmd 经 `cd` 写的是原生（`C:\foo`）→ 原样；
/// - 其它形式 best-effort 原样。
pub fn normalize_cwd_from_shell(s: &str) -> PathBuf {
    let s = s.trim();
    // 形如 /c/Users/foo 的 MSYS POSIX 绝对路径（盘符 + 斜杠）。
    if s.len() >= 3 && s.starts_with('/') && s.as_bytes()[2] == b'/' {
        let drive = &s[1..2];
        let rest = &s[3..];
        return PathBuf::from(format!("{drive}:\\{}", rest.replace('/', "\\")));
    }
    PathBuf::from(s)
}

/// 一次命令调用的壳层构造结果。
pub struct Invocation {
    /// 被 spawn 的可执行文件（"cmd" 或 bash.exe 路径）。
    pub program: String,
    /// 传给可执行文件的参数（cmd 的 `["/C", cmd]` 或 bash 的 `["-c", script]`）。
    pub args: Vec<String>,
    /// 额外注入的环境变量（bash 模式注入 `MSYS_NO_PATHCONV=1`）。
    pub env_extra: Vec<(String, String)>,
    /// cwd 捕获文件（**原生**路径，仅 track_cwd 时 Some）。bash 内部用其 POSIX 形式写 pwd；
    /// Rust 侧用原生路径读回。文件在命令结束前不存在，读回时若不存在说明命令提前失败。
    pub cwd_capture_file: Option<PathBuf>,
}

/// 构造一次命令调用的壳层细节。
///
/// - `shell`：cmd 或 bash。
/// - `command`：用户原始命令。
/// - `native_cwd`：已白名单校验的**原生** cwd（如 `C:\foo`）。由调用方传给进程 `current_dir`
///   （Windows API 级，Git Bash 启动即落在 `/c/foo`），不直接进入命令字符串。
/// - `track_cwd`：是否捕获命令结束后的有效 cwd（= `effective_session_id.is_some()`，仅会话内）。
///   仅前台命令会回写 session cwd（后台不更新，对齐 Claude Code）。
///
/// 返回 None 仅当 bash 模式且未探测到 bash.exe（调用方应 Err）。
pub fn build_invocation(
    shell: ShellType,
    command: &str,
    _native_cwd: &Path,
    track_cwd: bool,
) -> Option<Invocation> {
    let cwd_file: Option<PathBuf> = if track_cwd {
        Some(std::env::temp_dir().join(format!("cc-bridge-cwd-{:016x}", rand::random::<u64>())))
    } else {
        None
    };

    match shell {
        ShellType::Cmd => match &cwd_file {
            None => Some(Invocation {
                program: "cmd".into(),
                args: vec!["/C".into(), command.to_string()],
                env_extra: vec![],
                cwd_capture_file: None,
            }),
            // 会话内：命令成功（`&&`）才写 cwd 到文件（best-effort，cmd 无 pwd -P，用 `cd` 打印）。
            Some(f) => Some(Invocation {
                program: "cmd".into(),
                args: vec![
                    "/C".into(),
                    format!("{} && cd > \"{}\"", command, f.display()),
                ],
                env_extra: vec![],
                cwd_capture_file: Some(f.clone()),
            }),
        },
        ShellType::Bash => {
            let bash_exe = detect_bash_exe()?;
            let quoted = sh_quote(command);
            // 安全：关扩展通配，防白名单校验通过后恶意文件名在 shell 展开期被扩展
            // （对齐 Claude Code 的 `shopt -u extglob`）。用 `&&` 串 eval，命令成功才继续。
            let prefix = "{ shopt -u extglob 2>/dev/null || true; }";
            let body = format!("{prefix} && eval {quoted}");
            let (script, file) = match &cwd_file {
                None => (body, None),
                // 会话内：再加 `pwd -W >| <posix_file>` 写 cwd。`-W` 让 MSYS bash 直接输出
                // Windows 风格路径（如 `C:/Users/...`），避开 `pwd -P` 把 Windows TEMP 重写为
                // `/tmp/...` 的坑（那样 normalize_cwd_from_shell 无法还原）。重定向目标仍用 POSIX 路径。
                Some(f) => {
                    let posix = windows_to_posix(f);
                    (format!("{body} && pwd -W >| {posix}"), Some(f.clone()))
                }
            };
            Some(Invocation {
                program: bash_exe.to_string_lossy().into_owned(),
                args: vec!["-c".into(), script],
                env_extra: vec![("MSYS_NO_PATHCONV".into(), "1".into())],
                cwd_capture_file: file,
            })
        }
    }
}
