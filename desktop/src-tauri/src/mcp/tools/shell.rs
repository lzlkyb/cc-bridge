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
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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

/// 子进程无控制台窗口标志（Windows）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Git Bash 可执行文件的常见安装位置（按优先级）。
/// 仅 Windows：非 Windows 上 bash 是系统自带的，路径完全不同（见下方 unix 版探测）。
/// 必须加 cfg，否则 mac 上此常量无人使用 → dead_code 警告 → `clippy -D warnings` 直接报错。
#[cfg(windows)]
const BASH_CANDIDATES: &[&str] = &[
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Git\\bin\\bash.exe",
    "C:\\Git\\usr\\bin\\bash.exe",
];

/// 探测 Git Bash 的 `bash.exe`（缓存结果，避免每条命令都 spawn `where`）。
/// 找不到返回 None（调用方据此报错，由上层决定是否回退 cmd）。
#[cfg(windows)]
fn detect_bash_exe_inner() -> Option<PathBuf> {
    for c in BASH_CANDIDATES {
        if Path::new(c).is_file() {
            return Some(PathBuf::from(c));
        }
    }
    // Scoop 安装路径（%USERPROFILE%\scoop\apps\git\...）
    if let Ok(home) = std::env::var("USERPROFILE") {
        let scoop_bash = Path::new(&home).join("scoop/apps/git/current/usr/bin/bash.exe");
        if scoop_bash.is_file() {
            return Some(scoop_bash);
        }
    }
    // 兜底1：在 PATH 里用 `where bash` 找（最可靠，覆盖非标准安装路径如 D:\software\Git\）
    if let Ok(out) = std::process::Command::new("where")
        .arg("bash")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
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
    // 兜底2：通过 where git 找到 git.exe，倒推 bash.exe。
    // Git for Windows 安装时必定把 cmd\ 加入 PATH，where git 几乎总能命中。
    // 覆盖 bash 不在 PATH 但 git 在 PATH 的场景（标准安装仅 cmd\ 在 PATH）。
    if let Ok(out) = std::process::Command::new("where")
        .arg("git")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                let git_exe = line.trim();
                if git_exe.is_empty() {
                    continue;
                }
                let git_path = std::path::Path::new(git_exe);
                // git.exe → cmd\ → <GitRoot>，然后尝试标准与 PortableGit 布局
                if let Some(git_root) = git_path.parent().and_then(|p| p.parent()) {
                    for sub in &["bin/bash.exe", "usr/bin/bash.exe"] {
                        let candidate = git_root.join(sub);
                        if candidate.is_file() {
                            return Some(candidate);
                        }
                    }
                }
                // 部分安装 git.exe 直接在 <GitRoot>\bin\git.exe → bash 在同级
                if let Some(parent) = git_path.parent() {
                    let candidate = parent.join("bash.exe");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}
/// 非 Windows（macOS / Linux）的 bash 探测。
///
/// 与 Windows 版完全不同：这里不能用 `where` 命令，也不能用
/// `.creation_flags(CREATE_NO_WINDOW)`——那两个 API 在非 Windows 上根本不存在
/// （CI 的 macOS job 就是在那两行报 E0425）。
///
/// 顺序：先查常见绝对路径，再用 `command -v bash` 兜底——后者能覆盖 Homebrew
/// （Apple Silicon 上是 `/opt/homebrew/bin/bash`）与用户自定义安装位置。
/// 用 `command -v` 而不是 `which`：前者是 POSIX 内建，精简环境里也一定有。
#[cfg(not(windows))]
fn detect_bash_exe_inner() -> Option<PathBuf> {
    for c in [
        "/bin/bash",
        "/usr/bin/bash",
        "/usr/local/bin/bash",
        "/opt/homebrew/bin/bash",
    ] {
        if Path::new(c).is_file() {
            return Some(PathBuf::from(c));
        }
    }
    if let Ok(out) = std::process::Command::new("sh")
        .args(["-c", "command -v bash"])
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let p = s.trim();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
    }
    None
}


/// 缓存探测结果。启动时首次 `get_status` 触发初始化，之后只读不扫磁盘。
/// 用户安装 Git for Windows 后，通过设置页「刷新检测」按钮调用 `refresh_bash_detection()` 更新。
static BASH_EXE: Mutex<Option<PathBuf>> = Mutex::new(None);
/// 是否已完成首次探测（避免 5s 轮询里 None 未命中而反复初始化）。
static BASH_INIT: Mutex<bool> = Mutex::new(false);

/// 返回探测到的 bash.exe 路径（纯缓存读取，不触发磁盘扫描）。
/// 首次调用时执行一次扫描写入缓存，之后仅读缓存。
pub fn detect_bash_exe() -> Option<PathBuf> {
    let mut inited = BASH_INIT.lock().unwrap();
    if !*inited {
        *inited = true;
        drop(inited);
        let found = detect_bash_exe_inner();
        *BASH_EXE.lock().unwrap() = found;
    }
    BASH_EXE.lock().unwrap().clone()
}

/// 强制重新探测 bash.exe（供设置页「刷新检测」按钮调用）。
/// 覆盖缓存并返回新的探测结果。
pub fn refresh_bash_detection() -> Option<PathBuf> {
    let found = detect_bash_exe_inner();
    *BASH_EXE.lock().unwrap() = found.clone();
    found
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
    //
    // ⚠ **必须限定 Windows**：这条启发式在 Unix 上会误伤真实路径——mac/Linux 的
    // `pwd` 输出如 `/a/b` 这种**首段只有一个字符**的路径会恰好命中（第 3 个字节是 `/`），
    // 被当成盘符转成 `a:\b`。常见的 `/Users` `/tmp` `/opt` 恰好不命中，
    // 所以这个 bug 很难被发现。Unix 上 `pwd` 本就输出可直用的原生路径，无需任何转换。
    #[cfg(windows)]
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
/// - `shell`：cmd（Windows）/ sh（Unix）或 bash。
/// - `command`：用户原始命令。
/// - `native_cwd`：已白名单校验的**原生** cwd。由调用方传给进程 `current_dir`，
///   不直接进入命令字符串。
/// - `track_cwd`：是否捕获命令结束后的有效 cwd（= `effective_session_id.is_some()`，仅会话内）。
///   仅前台命令会回写 session cwd（后台不更新，对齐 Claude Code）。
///
/// 返回 None 仅当 bash 模式且未探测到 bash（调用方应 Err）。
///
/// **平台分派**：两边的壳层形态差异太大（`cmd /C` vs `sh -c`、MSYS 的 `pwd -W` 与
/// 路径转换 vs 原生 POSIX），混在一个 match 里会很难读，故拆成两个平台专属实现。
/// 对外签名不变，调用方（run_command.rs）无需感知。
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

    #[cfg(windows)]
    let inv = build_invocation_windows(shell, command, cwd_file);
    #[cfg(not(windows))]
    let inv = build_invocation_unix(shell, command, cwd_file);
    inv
}

#[cfg(windows)]
fn build_invocation_windows(
    shell: ShellType,
    command: &str,
    cwd_file: Option<PathBuf>,
) -> Option<Invocation> {
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

/// Unix（macOS / Linux）壳层构造。与 Windows 版的每一处差异都是必须的：
///
/// - **`ShellType::Cmd` 映射为 `/bin/sh`**。Unix 上没有 `cmd.exe`；`/bin/sh` 是 POSIX
///   默认壳层、任何 Unix 都有。配置值仍写 `"cmd"`（不动用户既有配置），语义变为
///   「平台默认壳层」——UI 与工具描述需按平台显示名称（见清单 N3 / N6）。
/// - **cwd 捕获用 `pwd`，绝不能用 Windows 版的 `pwd -W`**：`-W` 是 MSYS bash 的专属
///   扩展（输出 Windows 风格路径），Unix bash 上它是非法选项、会直接报错。
/// - **重定向目标不做 `windows_to_posix` 转换**：路径本来就是 POSIX。仍用 `sh_quote`
///   包裹，因为 temp 目录可能含空格。
/// - **不注入 `MSYS_NO_PATHCONV`**：那是 MSYS 的 argv 路径自动转换开关，Unix 无此机制。
/// - **保留 `shopt -u extglob` 与 `eval` 引号包裹**：安全围栏与 Windows 侧完全一致
///   （防白名单校验通过后，恶意文件名在 shell 展开期被扩展）。
/// - `>` 而非 Windows 版的 `>|`：`>|` 是 bash 对 noclobber 的强制覆盖语法，`sh`
///   不保证支持；默认 noclobber 是关的，`>` 足够。
#[cfg(not(windows))]
fn build_invocation_unix(
    shell: ShellType,
    command: &str,
    cwd_file: Option<PathBuf>,
) -> Option<Invocation> {
    // 把 cwd 捕获文件路径安全地嵌进 shell 脚本（temp 目录可能含空格）。
    let redirect = |f: &Path| format!(" && pwd > {}", sh_quote(&f.to_string_lossy()));

    match shell {
        // sh 不保证有 shopt/extglob（dash 等就没有），所以这里只做最朴素的 -c，
        // 与 Windows 侧 cmd 分支的处理级别相对应。
        ShellType::Cmd => {
            let script = match &cwd_file {
                None => command.to_string(),
                Some(f) => format!("{}{}", command, redirect(f)),
            };
            Some(Invocation {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), script],
                env_extra: vec![],
                cwd_capture_file: cwd_file,
            })
        }
        ShellType::Bash => {
            let bash_exe = detect_bash_exe()?;
            let quoted = sh_quote(command);
            let prefix = "{ shopt -u extglob 2>/dev/null || true; }";
            let body = format!("{prefix} && eval {quoted}");
            let script = match &cwd_file {
                None => body,
                Some(f) => format!("{}{}", body, redirect(f)),
            };
            Some(Invocation {
                program: bash_exe.to_string_lossy().into_owned(),
                args: vec!["-c".into(), script],
                env_extra: vec![],
                cwd_capture_file: cwd_file,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shell_type_bash() {
        assert_eq!(parse_shell_type("bash"), ShellType::Bash);
    }

    #[test]
    fn parse_shell_type_cmd_and_unknown() {
        assert_eq!(parse_shell_type("cmd"), ShellType::Cmd);
        assert_eq!(parse_shell_type("powershell"), ShellType::Cmd);
        assert_eq!(parse_shell_type(""), ShellType::Cmd);
    }

    #[test]
    fn windows_to_posix_drive_letter() {
        assert_eq!(
            windows_to_posix(Path::new("C:\\Users\\foo")),
            "/c/Users/foo"
        );
    }

    #[test]
    fn windows_to_posix_verbatim_prefix() {
        assert_eq!(
            windows_to_posix(Path::new("\\\\?\\C:\\foo\\bar")),
            "/c/foo/bar"
        );
    }

    #[test]
    fn sh_quote_plain() {
        assert_eq!(sh_quote("echo hello"), "'echo hello'");
    }

    #[test]
    fn sh_quote_with_single_quote() {
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    /// MSYS 盘符转换仅 Windows 生效（见 normalize_cwd_from_shell 里的 cfg 与原因）。
    #[test]
    #[cfg(windows)]
    fn normalize_cwd_msys_posix() {
        assert_eq!(
            normalize_cwd_from_shell("/c/Users/foo"),
            PathBuf::from("C:\\Users\\foo")
        );
    }

    /// Unix 上绝不能做盘符转换：`/a/b` 这种首段单字符的真实路径恰好会命中
    /// 那条 MSYS 启发式（第 3 个字节是 `/`），若不限定平台会被错误转成 `a:\b`。
    /// 这条测试就是锁住那个回归。
    #[test]
    #[cfg(not(windows))]
    fn normalize_cwd_unix_no_drive_rewrite() {
        assert_eq!(normalize_cwd_from_shell("/a/b"), PathBuf::from("/a/b"));
        assert_eq!(
            normalize_cwd_from_shell("/Users/foo"),
            PathBuf::from("/Users/foo")
        );
        assert_eq!(normalize_cwd_from_shell("  /tmp/x  "), PathBuf::from("/tmp/x"));
    }

    #[test]
    #[cfg(windows)]
    fn normalize_cwd_native_unchanged() {
        assert_eq!(
            normalize_cwd_from_shell("C:\\foo\\bar"),
            PathBuf::from("C:\\foo\\bar")
        );
    }

    /// Unix 壳层构造：Cmd 映射到 /bin/sh，且不注入 MSYS 专属环境变量。
    #[test]
    #[cfg(not(windows))]
    fn unix_cmd_maps_to_sh() {
        let inv = build_invocation(ShellType::Cmd, "echo hi", Path::new("/tmp"), false).unwrap();
        assert_eq!(inv.program, "/bin/sh");
        assert_eq!(inv.args, vec!["-c".to_string(), "echo hi".to_string()]);
        assert!(
            inv.env_extra.is_empty(),
            "Unix 不应注入 MSYS_NO_PATHCONV，得到：{:?}",
            inv.env_extra
        );
    }

    /// cwd 捕获在 Unix 上必须用 `pwd`，**不能**带 `-W`（那是 MSYS 专属扩展，
    /// Unix bash 上是非法选项、会直接报错）。
    #[test]
    #[cfg(not(windows))]
    fn unix_cwd_capture_uses_plain_pwd() {
        let inv = build_invocation(ShellType::Cmd, "cd /tmp", Path::new("/tmp"), true).unwrap();
        let script = &inv.args[1];
        assert!(script.contains(" && pwd "), "实际脚本：{script}");
        assert!(
            !script.contains("pwd -W"),
            "不得使用 MSYS 专属的 pwd -W：{script}"
        );
        assert!(inv.cwd_capture_file.is_some());
    }
}
