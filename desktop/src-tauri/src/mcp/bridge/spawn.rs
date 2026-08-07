//! 外挂 MCP server 的子进程启动：跨平台命令解析 + 进程树包装。
//!
//! 本模块只管“把进程拉起来并拿到三个管道”，不懂 MCP 协议（那是 `client.rs`）。
//!
//! 为何不直接用 `Command::new(&spec.command)`：实测（2026-08-07）`Command::new("codegraph")`
//! 在 Windows 上报 `program not found`。Rust 的 `Command` **不查 PATHEXT**，而 npm / pip 装出来的
//! 入口普遍是 `xxx.cmd` / `xxx.exe` 垫片。本机已有的三个 MCP server 就跨了三种形态：
//!
//! ```text
//! filesystem        cmd         /c npx -y @modelcontextprotocol/server-filesystem D:
//! codegraph         codegraph   serve --mcp            ← 裸名字，靠 PATHEXT 才找得到
//! paper_search_mcp  python.exe  -m paper_search_mcp.server
//! ```
//!
//! 🔴 **不重写用户的配置**。上面第一条的 `command` 就是 `cmd`——那是用户自己的选择，
//! 原样执行，不要“智能地”把它拆成 `npx …`。拆就是写适配层（违反通用桥的前提），
//! 而且一旦拆错行为就变了。“这条经过 cmd 解析器”只在导入预览时提醒用户。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[cfg(unix)]
use process_wrap::std::ProcessGroup;
#[cfg(windows)]
use process_wrap::std::{CreationFlags, JobObject};
use process_wrap::std::{StdChildWrapper, StdCommandWrap};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_CREATION_FLAGS,
};

/// Windows 下找不到 PATHEXT 时的兜底值（与系统默认一致，只保留跟“可执行”相关的那几个）。
#[cfg(windows)]
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// 把配置里的 `command` 解析成一个真实存在的可执行文件路径。
///
/// 规则：
/// - 含路径分隔符（或 Windows 下的盘符）→ 当成路径直接校，**不搜 PATH**；
///   Windows 下若没写扩展名，仍会逐个试 PATHEXT。
/// - 否则逐个 PATH 条目搜；Windows 先试原名再试拼扩展名，Unix 需带可执行位。
pub fn resolve_program(command: &str) -> Result<PathBuf, String> {
    resolve_in(
        command,
        std::env::var_os("PATH").as_deref(),
        &pathext(),
        cfg!(windows),
    )
}

/// 当前平台的 PATHEXT 列表。**不含空串**——“要不要试原名”由 `bare_is_allowed` 判，
/// 不能简单地把空串塞在最前面（原因见该函数）。Unix 上为空。
fn pathext() -> Vec<String> {
    #[cfg(windows)]
    {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| DEFAULT_PATHEXT.to_string())
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// `resolve_program` 的可注入版本——PATH 与扩展名列表都从参数进，单测才能拿临时目录造场景。
fn resolve_in(
    command: &str,
    path_var: Option<&OsStr>,
    exts: &[String],
    win: bool,
) -> Result<PathBuf, String> {
    if command.trim().is_empty() {
        return Err("command 为空".to_string());
    }

    // 带路径的：不搜 PATH（用户已经指定到哪了）。
    if looks_like_path(command) {
        let base = PathBuf::from(command);
        if let Some(hit) = try_with_exts(&base, exts, win) {
            return Ok(hit);
        }
        return Err(format!(
            "找不到可执行文件：{command}（按路径查找，未搜 PATH）"
        ));
    }

    let Some(path_var) = path_var else {
        return Err(format!("找不到命令 {command}：环境变量 PATH 为空"));
    };

    for dir in std::env::split_paths(path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if let Some(hit) = try_with_exts(&dir.join(command), exts, win) {
            return Ok(hit);
        }
    }

    Err(format!(
        "找不到命令 {command}。它不在 PATH 里，或者未安装。\
         若它是 npm / pip 装的工具，请确认对应的 bin 目录已加进 PATH。"
    ))
}

/// 按平台语义逐个候选试，命中则返回。
fn try_with_exts(base: &Path, exts: &[String], win: bool) -> Option<PathBuf> {
    // ① 原名直接试——仅当它在本平台算“可执行名字”时。
    if bare_is_allowed(base, exts, win) && is_executable_file(base) {
        return Some(real_path(base));
    }
    // ② 逐个**追加**扩展名。
    for ext in exts {
        // 不能用 set_extension：它会把 `python.exe` 改成 `python.cmd`，
        // 而我们要的是在原名后面追加（`foo` → `foo.cmd`）。
        let mut s = base.as_os_str().to_os_string();
        s.push(ext);
        let cand = PathBuf::from(s);
        if is_executable_file(&cand) {
            return Some(real_path(&cand));
        }
    }
    None
}

/// “原名不拼扩展名”这个候选能不能试。
///
/// 🔴 **这是真机测试抓出来的坑**（2026-08-07）。最初的写法把空扩展名排在最前面
/// “先试原名”，结果在本机解出来的是：
///
/// ```text
/// codegraph -> C:\Users\...\AppData\Roaming\npm\codegraph      ← 无扩展名的 sh 脚本
/// npx       -> D:\AItool\nodejs\npx                            ← 同上
/// ```
///
/// npm 会在同一目录里同时放 `codegraph`（给 MSYS/Cygwin 用的 bash 脚本）与 `codegraph.cmd`。
/// 前者在 Windows 上**根本启动不了**（没有 PE 头，`CreateProcess` 会报“不是有效的 Win32
/// 应用程序”）。之前的探针没暴露这个问题，是因为它走的 `cmd /C`——cmd.exe 自己会跳过它。
///
/// 所以这里按 **cmd.exe 的真实语义**来：
/// - Windows：只有当名字本身带了一个**在 PATHEXT 里的**扩展名（如 `python.exe`）才试原名；
///   裸名字（`codegraph`）一律只试拼扩展名。
/// - Unix：原名就是唯一候选（可执行位在 `is_executable_file` 里卡）。
///
/// `win` 从参数进而不是 `cfg!`：否则 Windows 那支逻辑在 mac/Linux 上永远测不到
/// （CLAUDE.md §8.1 第 6 条：平台分支不能靠“看着对”）。
fn bare_is_allowed(base: &Path, exts: &[String], win: bool) -> bool {
    if !win {
        return true;
    }
    let Some(e) = base.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    exts.iter()
        .any(|x| x.trim_start_matches('.').eq_ignore_ascii_case(e))
}

/// 把命中的路径换成**磁盘上的真实路径**（解符号链接、修正大小写）。
///
/// 🔴 为何需要：Windows 的 PATHEXT 里写的是 `.CMD`（大写），而磁盘上的文件叫 `codegraph.cmd`。
/// 拼出来的 `codegraph.CMD` 在大小写不敏感的 NTFS 上**能正常执行**，所以不会报错——
/// 但它会悄悄流进两个地方：
///
/// 1. **manifest 指纹**（方案 §10）——不同机器的 PATHEXT 大小写写法不一，指纹就不稳定，
///    表现为“什么都没改却总说 manifest 过期”。
/// 2. **给用户看的路径**——展示 `codegraph.CMD` 会让人以为自己装错了东西。
///
/// 失败则原样返回：能跑比好看重要。
fn real_path(p: &Path) -> PathBuf {
    match p.canonicalize() {
        Ok(c) => strip_verbatim(c),
        Err(_) => p.to_path_buf(),
    }
}

/// 去掉 Windows `canonicalize` 带回来的 `\\?\` 前缀。
///
/// 带着它也能 `CreateProcess`，但它会出现在错误提示与设置页里，很吓人。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(s) = p.to_str() {
            if let Some(rest) = s.strip_prefix(r"\\?\") {
                // UNC 形式（`\\?\UNC\server\share`）不能简单剥，剥了就不是合法路径了。
                if !rest.starts_with("UNC\\") {
                    return PathBuf::from(rest);
                }
            }
        }
    }
    p
}

fn looks_like_path(command: &str) -> bool {
    if command.contains('/') {
        return true;
    }
    #[cfg(windows)]
    {
        // 反斜杠，或 `C:` 这种盘符开头。
        if command.contains('\\') {
            return true;
        }
        let b = command.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            return true;
        }
    }
    false
}

/// 是不是一个“能拿来执行的文件”。
///
/// Unix 上必须查可执行位：否则 PATH 里一个同名的**普通文件**会把真正的可执行文件遮住，
/// 报错变成 “Permission denied” 而不是 “找不到”，很难查。
fn is_executable_file(p: &Path) -> bool {
    let Ok(md) = std::fs::metadata(p) else {
        return false;
    };
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 这个已解析路径是不是 cc-bridge 自己。
///
/// 用于 S8（自我排除）：用户的 `~/.claude.json` 里很可能就配着 cc-bridge，
/// 把它当外挂 server 导入就是自己桥自己（无限套娃，且毫无意义——远程本就直连着它）。
///
/// 🔴 **不靠名字判断**：名字是用户随便取的，既会误判（叫 cc-bridge 但指向别的程序）
/// 也会漏判（叫 foo 但指向自身）。两边都 canonicalize 后比真实路径。
///
/// canonicalize 失败（文件被删 / 权限不够）时返回 `false`：宁可放过也不误拦，
/// 因为真正的防线是“导入时 + 保存时各校一次”，而不是这一个函数。
pub fn is_self_executable(program: &Path) -> bool {
    let Ok(me) = std::env::current_exe() else {
        return false;
    };
    match (program.canonicalize(), me.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 启动一个 stdio MCP server，返回已包装好的子进程句柄（stdin/stdout/stderr 均为管道）。
///
/// 与 `run_command` 的 spawn 共用同一套进程树治理（process-wrap），但有一处关键不同：
/// **stdin 是 `piped()` 而不是 `null()`**——我们要往里面写 JSON-RPC。
/// `run_command` 那边用 null 是为了避免子进程拿到无效句柄后自己去申请控制台（会闪黑窗）；
/// 这里给的是**有效的管道句柄**，不会触发那个行为。
pub fn spawn_stdio_server(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    cwd: Option<&Path>,
) -> Result<Box<dyn StdChildWrapper>, String> {
    let mut cmd = StdCommandWrap::with_new(program.as_os_str(), |c| {
        c.args(args);
        c.stdin(Stdio::piped());
        c.stdout(Stdio::piped());
        c.stderr(Stdio::piped());
        if let Some(dir) = cwd {
            c.current_dir(dir);
        }
        for (k, v) in env {
            c.env(k, v);
        }
    });

    // 顺序敏感，与 `run_command::spawn_shell` 同一个坑：
    // JobObject 的 pre_spawn 会重设 creation_flags（且不合并），所以必须
    // **先 wrap(JobObject) 再 wrap(CreationFlags)**，让 CreationFlags 最后写入；
    // 反了的话 CREATE_NO_WINDOW 被冲掉 → 弹黑窗口。
    // 另：CreationFlags 里【不要】带 CREATE_SUSPENDED，否则 JobObject 会跳过 resume，
    // 子进程永久挂起、一个字节也不会吐。
    #[cfg(windows)]
    {
        cmd.wrap(JobObject);
        cmd.wrap(CreationFlags(PROCESS_CREATION_FLAGS(
            CREATE_NO_WINDOW.0 | CREATE_NEW_PROCESS_GROUP.0,
        )));
    }
    // Unix 对应物：子进程作为进程组组长，`start_kill()` 向整组发信号。
    #[cfg(unix)]
    cmd.wrap(ProcessGroup::leader());

    cmd.spawn()
        .map_err(|e| format!("启动 MCP server 失败（{}）：{e}", program.display()))
}

/// 把 `env` 里的键名拼成一串，**只给键名、不给值**。
///
/// S7：`env` 里真的有 API key（本机 `paper_search_mcp` 就带 `SEMANTIC_SCHOLAR_API_KEY`）。
/// 日志 / 审计 / 指纹计算全走这个函数，从源头守住“值不得泄漏”。
pub fn env_key_summary(env: &[(String, String)]) -> String {
    let mut keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    keys.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 每个用例一个独立临时目录（避免并发跑串）。
    fn temp_dir(label: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "cc-bridge-spawn-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("create temp dir");
        d
    }

    /// 造一个可执行文件（Unix 上置可执行位，Windows 上普通文件即可）。
    fn make_exe(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"x").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        p
    }

    fn path_of(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs.iter().map(|d| d.to_path_buf())).expect("join_paths")
    }

    /// B1 主体：裸名字 + PATHEXT。这就是 `codegraph` 在本机的形态——
    /// npm 装出来的入口是 `codegraph.cmd`，而配置里写的是 `codegraph`。
    #[test]
    fn bare_name_resolves_through_ext_list() {
        let dir = temp_dir("ext");
        make_exe(&dir, "codegraph.cmd");
        let path = path_of(&[&dir]);

        // 扩展名大小写与磁盘保持一致：mac / Linux 的文件系统区分大小写，
        // 写成 `.CMD` 会让这条用例在 CI 的 macOS job 上假失败。
        let exts = vec![".exe".to_string(), ".cmd".to_string()];
        let got = resolve_in("codegraph", Some(path.as_os_str()), &exts, true)
            .expect("应该能通过 PATHEXT 找到 codegraph.cmd");
        assert_eq!(got.file_name().unwrap(), "codegraph.cmd");
    }

    /// 🔴 真机回归：裸名字**不得**命中 npm 那个无扩展名的 sh 垫片。
    ///
    /// npm 会在同一目录里同时放 `codegraph`（bash 脚本）与 `codegraph.cmd`，
    /// 前者在 Windows 上启动不了。最初的实现“先试原名”，在本机就是选中了前者。
    ///
    /// 两个平台语义在**同一个用例**里一起断，所以在 Windows / mac / Linux 上都能跑。
    #[test]
    fn windows_bare_name_skips_extensionless_shim() {
        let dir = temp_dir("npm-shim");
        make_exe(&dir, "codegraph"); // MSYS 用的 bash 脚本
        make_exe(&dir, "codegraph.cmd"); // Windows 真正的入口
        let path = path_of(&[&dir]);
        let exts = vec![".cmd".to_string()];

        let win = resolve_in("codegraph", Some(path.as_os_str()), &exts, true).expect("应找到");
        assert_eq!(
            win.file_name().unwrap(),
            "codegraph.cmd",
            "Windows 语义下裸名字只能命中拼了扩展名的那个，实际：{}",
            win.display()
        );

        // Unix 语义相反：无扩展名的那个才是可执行文件。
        let nix = resolve_in("codegraph", Some(path.as_os_str()), &exts, false).expect("应找到");
        assert_eq!(nix.file_name().unwrap(), "codegraph");
    }

    /// Windows 专属：PATHEXT 里是大写 `.CMD`，拼出来的 `codegraph.CMD` 在 NTFS 上照跑不误，
    /// 所以不会报错——这条守的是 `real_path()` 有没有把大小写校回磁盘的真实写法，
    /// 否则 manifest 指纹会因机器而异、表现为“什么都没改却总说过期”。
    #[cfg(windows)]
    #[test]
    fn windows_pathext_case_is_corrected_to_disk() {
        let dir = temp_dir("case");
        make_exe(&dir, "codegraph.cmd");
        let path = path_of(&[&dir]);
        let exts = vec![".CMD".to_string()];

        let got = resolve_in("codegraph", Some(path.as_os_str()), &exts, true).expect("应找到");
        assert_eq!(got.file_name().unwrap(), "codegraph.cmd");
    }

    /// 扩展名是**追加**不是**替换**。
    /// 用 `set_extension` 会把 `python.exe` 改成 `python.cmd`，那就找错了东西。
    /// （`python.exe` 正是本机 `paper_search_mcp` 配置里的写法。）
    #[test]
    fn extension_is_appended_not_replaced() {
        let dir = temp_dir("append");
        make_exe(&dir, "python.exe");
        make_exe(&dir, "python.cmd");
        let path = path_of(&[&dir]);

        // 原名已带 `.exe`（且 `.exe` 在 PATHEXT 里）→ 直接命中，不该跑到 .cmd 去。
        // 这正是本机 `paper_search_mcp` 配置里 `python.exe` 的写法。
        let exts = vec![".exe".to_string(), ".cmd".to_string()];
        let got = resolve_in("python.exe", Some(path.as_os_str()), &exts, true).expect("应找到");
        assert_eq!(got.file_name().unwrap(), "python.exe");
    }

    /// PATH 按顺序搜，先命中的赢。
    #[test]
    fn path_entries_are_searched_in_order() {
        let first = temp_dir("order-a");
        let second = temp_dir("order-b");
        make_exe(&first, "dup.bin");
        make_exe(&second, "dup.bin");
        let path = path_of(&[&first, &second]);

        let got = resolve_in("dup.bin", Some(path.as_os_str()), &[], false).expect("应找到");
        // 跟 real_path() 后的目录比：返回值已经 canonicalize 过，直接跟原始临时目录比会因
        // 大小写 / 短路径差异而假失败。
        assert!(
            got.starts_with(real_path(&first)),
            "应命中 PATH 里靠前的那个，实际：{}",
            got.display()
        );
    }

    /// 带路径的 command 不搜 PATH——否则用户写了绝对路径却启动了别处的同名程序，
    /// 那是安全问题而不只是行为奇怪。
    #[test]
    fn path_like_command_does_not_fall_back_to_path_search() {
        let real = temp_dir("pathlike-real");
        let decoy = temp_dir("pathlike-decoy");
        make_exe(&decoy, "tool.bin");
        let path = path_of(&[&decoy]);

        // real 目录下根本没有 tool.bin，就算 PATH 里有也不能命中。
        let missing = real.join("tool.bin");
        let err = resolve_in(
            missing.to_str().unwrap(),
            Some(path.as_os_str()),
            &[],
            false,
        )
        .expect_err("带路径且不存在，应该直接失败");
        assert!(
            err.contains("未搜 PATH"),
            "错误该说清楚没搜 PATH，实际：{err}"
        );
    }

    /// 找不到时要给可操作的错误，而不是一句 program not found。
    #[test]
    fn missing_command_reports_actionable_error() {
        let dir = temp_dir("missing");
        let path = path_of(&[&dir]);
        let err = resolve_in("definitely-not-here", Some(path.as_os_str()), &[], false)
            .expect_err("应失败");
        assert!(
            err.contains("definitely-not-here"),
            "错误里要带上命令名：{err}"
        );
        assert!(err.contains("PATH"), "错误里要提示 PATH：{err}");
    }

    #[test]
    fn empty_command_is_rejected() {
        assert!(resolve_in("   ", None, &[], false).is_err());
    }

    /// PATH 未设时不能 panic。
    #[test]
    fn missing_path_var_is_an_error_not_a_panic() {
        let err = resolve_in("whatever", None, &[], false).expect_err("应失败");
        assert!(err.contains("PATH"));
    }

    /// Unix：同名的**不可执行**普通文件不能遮住后面真正的可执行文件。
    /// 这是平台分支的单测（CLAUDE.md §8.1 第 6 条：不能靠“看着对”）。
    #[cfg(unix)]
    #[test]
    fn unix_skips_non_executable_shadow() {
        use std::os::unix::fs::PermissionsExt;
        let shadow = temp_dir("shadow");
        let real = temp_dir("real");
        let p = shadow.join("tool");
        std::fs::write(&p, b"x").expect("write");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        make_exe(&real, "tool");
        let path = path_of(&[&shadow, &real]);

        let got = resolve_in("tool", Some(path.as_os_str()), &[], false).expect("应找到");
        assert!(
            got.starts_with(real_path(&real)),
            "不可执行的同名文件不该被选中，实际：{}",
            got.display()
        );
    }

    /// 目录不能被当成可执行文件。
    #[test]
    fn directory_is_not_executable() {
        let dir = temp_dir("isdir");
        std::fs::create_dir_all(dir.join("sub")).expect("mkdir");
        let path = path_of(&[&dir]);
        assert!(resolve_in("sub", Some(path.as_os_str()), &[], false).is_err());
    }

    /// S8：自我识别靠路径，不靠名字。
    #[test]
    fn self_detection_is_by_path_not_name() {
        let me = std::env::current_exe().expect("current_exe");
        assert!(is_self_executable(&me), "自身路径必须被认出来");

        // 名字叫 cc-bridge、但是别的文件 → 不得误判。
        let dir = temp_dir("selfname");
        let decoy = make_exe(&dir, "cc-bridge-desktop.exe");
        assert!(
            !is_self_executable(&decoy),
            "同名但不同路径的文件不应被当成自身"
        );

        // 不存在的路径 → false（canonicalize 失败时宁可放过）。
        assert!(!is_self_executable(Path::new("/definitely/not/here")));
    }

    /// 真机校验：拿本机**实际存在的**命令跑一遍真的 `resolve_program`。
    ///
    /// 标 `#[ignore]` 是因为它依赖开发机装了什么（CI 上没有 codegraph），
    /// 不该让 CI 因环境差异而红。手动跑：
    /// `cargo test --no-default-features resolves_real_commands -- --ignored --nocapture`
    ///
    /// 它要回答的是阶段一唯一真正关心的问题：同一套解析能不能同时吃下
    /// 裸名字（codegraph）、带扩展名（python.exe）、系统自带（cmd）三种形态。
    #[test]
    #[ignore]
    fn resolves_real_commands_on_this_machine() {
        for name in ["cmd", "codegraph", "python.exe", "npx", "uvx"] {
            match resolve_program(name) {
                Ok(p) => println!("  {name:<12} -> {}", p.display()),
                Err(e) => println!("  {name:<12} -> （未装或未命中）{e}"),
            }
        }
    }

    /// S7：env 摘要只能出现键名。
    #[test]
    fn env_summary_never_leaks_values() {
        let env = vec![
            (
                "SEMANTIC_SCHOLAR_API_KEY".to_string(),
                "sk-secret-123".to_string(),
            ),
            ("OTHER".to_string(), "v".to_string()),
        ];
        let s = env_key_summary(&env);
        assert!(s.contains("SEMANTIC_SCHOLAR_API_KEY"));
        assert!(!s.contains("sk-secret-123"), "密钥值泄漏了：{s}");
        // 排序后拼，保证同一组 env 算出的指纹稳定。
        assert_eq!(s, "OTHER,SEMANTIC_SCHOLAR_API_KEY");
    }
}
