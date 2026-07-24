//! 命令执行安全策略（④P0-1）。
//!
//! 把 run_command 的危险命令拦截从「`to_lowercase().contains` 子串黑名单」升级为
//! 「语法感知的 token 分析」，解决旧实现两类硬伤：
//! - **误拦**：`echo "rm -rf /"`（只是打印字符串）被旧黑名单命中。
//! - **漏拦**：`rm -rf /home`、`del /f /s /q C:\`（不在精确串里）被放行。
//!
//! 分两层（对齐 §④P0-1 方案）：
//! - **Layer 1（常开，零配置）**：破坏性操作检测。分词 → 按 `&& || ; | &` 换行切子命令 →
//!   每子命令取首 token(程序名) + flag/target 分析，仅命中**真正毁灭性**操作才拦
//!   （`rm -rf` 指向盘根/家目录/系统目录、`format`/`diskpart`/`mkfs`/`cipher /w`、
//!   `dd of=<设备>`、写裸设备 `\\.\PhysicalDrive`、fork bomb）。
//! - **Layer 2（opt-in）**：可执行白名单。开启后每个子命令的首 token 必须在白名单内。
//!
//! 声明：`shell_enabled` 开启 = 显式授予远程调用方任意代码执行权限（config 已自承）。
//! `python -c "..."`、`git config alias.x '!rm -rf'` 这类无法根治——本模块目标是
//! **抬高地板、消除最蠢的漏洞**，不是沙箱，不削弱任何既有安全围栏（规则7）。

use crate::mcp::tools::shell::ShellType;

/// 命令安全策略校验。`Ok(())` 放行；`Err(reason)` 拦截并把 reason 回传客户端。
///
/// - `command`：用户原始命令串。
/// - `shell`：cmd / bash，决定分词的引用/转义规则。
/// - `allowlist`：Layer 2 白名单。`None` = 不启用（仅 Layer 1）；`Some` 即使为空也生效——
///   空列表拒绝一切命令（fail-closed，与「安全」页空状态提示一致）。
pub fn validate_command_policy(
    command: &str,
    shell: ShellType,
    allowlist: Option<&[String]>,
) -> Result<(), String> {
    // fork bomb 是特殊语法构造（`:(){ :|:& };:`），分词器难以还原，先在原始串上归一化检测。
    if is_fork_bomb(command) {
        return Err(policy_error("检测到 fork bomb 模式（`:(){ :|:& };:`）"));
    }

    let subcommands = split_into_subcommands(command, shell);
    for seg in &subcommands {
        let tokens = tokenize(seg, shell);
        // 跳过 sudo/doas/env 等包装前缀，定位真正的程序名与其参数。
        let (prog, args) = match program_and_args(&tokens) {
            Some(pa) => pa,
            None => continue, // 空子命令（如结尾多余分隔符）跳过。
        };

        // Layer 1：破坏性操作检测（常开）。
        if let Some(reason) = destructive_reason(&prog, args) {
            return Err(policy_error(&reason));
        }

        // Layer 2：白名单（opt-in）。开启即生效——空列表拒绝全部命令（fail-closed，
        // 避免「已开启却允许全部」的虚假安全感）。prog 为空（空子命令）不拦。
        if let Some(list) = allowlist {
            if !prog.is_empty() && !allowlist_contains(list, &prog) {
                return Err(format!(
                    "命令被安全策略拦截：可执行「{prog}」不在白名单内。\
                     如确需使用，请在 cc-bridge 面板『安全』页把它加入命令白名单，或关闭白名单开关。"
                ));
            }
        }
    }
    Ok(())
}

/// 统一拦截错误文案，附带可操作建议。
fn policy_error(detail: &str) -> String {
    format!(
        "命令被安全策略拦截：{detail}。\
         如确有必要，请改用更精确、限定作用范围的写法后重试（避免指向盘根/家目录/系统目录或裸设备）。"
    )
}

/// 归一化后检测经典 fork bomb（`:(){ :|:& };:` 及其去空格变体）。
fn is_fork_bomb(command: &str) -> bool {
    let compact: String = command.chars().filter(|c| !c.is_whitespace()).collect();
    compact.contains(":(){:|:&};:") || compact.contains(":(){:|:&}:")
}

/// 白名单大小写不敏感包含（比较程序名 basename）。
fn allowlist_contains(list: &[String], prog: &str) -> bool {
    list.iter().any(|allowed| {
        let a = program_basename(allowed.trim());
        a.eq_ignore_ascii_case(prog)
    })
}

/// 按 shell 引用规则把命令切成子命令（不切引号内的分隔符，修复 `echo "a && b"` 误切）。
///
/// 识别的分隔符：`&&`、`||`、`|`、`|&`、`;`、`&`、换行/回车。只做「不在引号/转义内才切」，
/// 每段原样返回（trim），交由 [`tokenize`] 精细分词。
fn split_into_subcommands(command: &str, shell: ShellType) -> Vec<String> {
    let bash = matches!(shell, ShellType::Bash);
    let mut segments = Vec::new();
    let mut cur = String::new();
    let mut in_single = false; // 仅 bash：单引号内
    let mut in_double = false;
    let mut escaped = false;

    let bytes: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];

        if escaped {
            cur.push(c);
            escaped = false;
            i += 1;
            continue;
        }
        // 转义：bash 用 `\`，cmd 用 `^`（cmd 的 `\` 是路径分隔符，非转义）。
        if !in_single && !in_double && ((bash && c == '\\') || (!bash && c == '^')) {
            cur.push(c);
            escaped = true;
            i += 1;
            continue;
        }
        if bash && c == '\'' && !in_double {
            in_single = !in_single;
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '"' && !in_single {
            in_double = !in_double;
            cur.push(c);
            i += 1;
            continue;
        }

        if !in_single && !in_double {
            // 换行也是命令边界。
            if c == '\n' || c == '\r' {
                push_segment(&mut segments, &mut cur);
                i += 1;
                continue;
            }
            // 两字符操作符优先。
            let next = bytes.get(i + 1).copied();
            if (c == '&' && next == Some('&'))
                || (c == '|' && next == Some('|'))
                || (c == '|' && next == Some('&'))
            {
                push_segment(&mut segments, &mut cur);
                i += 2;
                continue;
            }
            // 单字符操作符。
            if c == '|' || c == ';' || c == '&' {
                push_segment(&mut segments, &mut cur);
                i += 1;
                continue;
            }
        }

        cur.push(c);
        i += 1;
    }
    push_segment(&mut segments, &mut cur);
    segments
}

fn push_segment(segments: &mut Vec<String>, cur: &mut String) {
    let seg = cur.trim();
    if !seg.is_empty() {
        segments.push(seg.to_string());
    }
    cur.clear();
}

/// 单个子命令分词。bash 用 shell-words（POSIX 精确处理引号/转义）；cmd 自研分词
/// （双引号 + `^` 转义 + 反斜杠作字面路径分隔符，避免 shell-words 把 `C:\Users` 破坏）。
/// 解析失败时回退朴素空白切分（best-effort，仍能取到程序名做分析，不因异常引用漏检）。
fn tokenize(segment: &str, shell: ShellType) -> Vec<String> {
    match shell {
        ShellType::Bash => shell_words::split(segment)
            .unwrap_or_else(|_| segment.split_whitespace().map(str::to_string).collect()),
        ShellType::Cmd => split_cmd_tokens(segment),
    }
}

/// cmd 风格分词：仅双引号成对包裹、`^` 转义下一字符、反斜杠字面、空白分隔。
fn split_cmd_tokens(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_double = false;
    let mut started = false;
    let mut escaped = false;

    for c in segment.chars() {
        if escaped {
            cur.push(c);
            started = true;
            escaped = false;
            continue;
        }
        if c == '^' && !in_double {
            escaped = true;
            started = true;
            continue;
        }
        if c == '"' {
            in_double = !in_double;
            started = true;
            continue;
        }
        if c.is_whitespace() && !in_double {
            if started {
                tokens.push(std::mem::take(&mut cur));
                started = false;
            }
            continue;
        }
        cur.push(c);
        started = true;
    }
    if started {
        tokens.push(cur);
    }
    tokens
}

/// 跳过包装前缀（sudo/doas），返回 (程序名 basename 小写, 参数切片)。
fn program_and_args(tokens: &[String]) -> Option<(String, &[String])> {
    let mut idx = 0;
    while idx < tokens.len() {
        let name = program_basename(&tokens[idx]);
        if name == "sudo" || name == "doas" {
            idx += 1;
            continue;
        }
        break;
    }
    let prog_tok = tokens.get(idx)?;
    let prog = program_basename(prog_tok);
    Some((prog, &tokens[idx + 1..]))
}

/// 取程序名 basename：去路径前缀（`/` 或 `\`）、去 Windows 可执行后缀、转小写。
fn program_basename(token: &str) -> String {
    let t = token.trim().trim_matches('"');
    let base = t.rsplit(['/', '\\']).next().unwrap_or(t);
    let base = base.to_ascii_lowercase();
    for ext in [".exe", ".com", ".bat", ".cmd"] {
        if let Some(stripped) = base.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    base
}

/// Layer 1 核心：给定程序名与参数，返回 Some(原因) 表示应拦截。
fn destructive_reason(prog: &str, args: &[String]) -> Option<String> {
    // 裸设备写入（任意位置的重定向目标 / dd of=）优先检测。
    for a in args {
        let val = a.trim_matches('"');
        let val = val
            .strip_prefix(">>")
            .or_else(|| val.strip_prefix('>'))
            .unwrap_or(val);
        if is_device_path(val) {
            return Some(format!("向裸设备写入（`{val}`）"));
        }
    }

    match prog {
        "format" => {
            if args.iter().any(|a| is_drive_like(a)) {
                return Some("格式化磁盘（format <盘符>）".into());
            }
        }
        "diskpart" => return Some("调用 diskpart 磁盘分区工具".into()),
        "mkfs" => return Some("创建文件系统（mkfs）".into()),
        p if p.starts_with("mkfs.") => return Some("创建文件系统（mkfs.*）".into()),
        "cipher" => {
            if args
                .iter()
                .any(|a| a.to_ascii_lowercase().starts_with("/w"))
            {
                return Some("cipher /w 擦除磁盘空闲空间".into());
            }
        }
        "dd" => {
            for a in args {
                let low = a.to_ascii_lowercase();
                if let Some(target) = low.strip_prefix("of=") {
                    if is_device_path(target) || is_catastrophic_target(target) {
                        return Some(format!("dd 写入危险目标（of={target}）"));
                    }
                }
            }
        }
        "rm" => {
            if has_recursive_short_or_long(args) && args.iter().any(|a| is_catastrophic_target(a)) {
                return Some("rm -r 递归删除盘根/家目录/系统目录".into());
            }
        }
        "del" | "erase" => {
            if has_slash_flag(args, 's') && args.iter().any(|a| is_catastrophic_target(a)) {
                return Some("del /s 递归删除盘根/系统目录".into());
            }
        }
        "rd" | "rmdir" => {
            let recursive = has_slash_flag(args, 's')
                || args
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case("-r") || a == "--recursive");
            if recursive && args.iter().any(|a| is_catastrophic_target(a)) {
                return Some("rd /s 递归删除盘根/系统目录".into());
            }
        }
        _ => {}
    }
    None
}

/// rm 的递归标志：短组合（`-rf`/`-fr`/`-r`/`-R`）或长（`--recursive`/`--no-preserve-root`）。
fn has_recursive_short_or_long(args: &[String]) -> bool {
    args.iter().any(|a| {
        if a == "--recursive" || a == "--no-preserve-root" {
            return true;
        }
        // 短标志簇：`-` 开头且非 `--`，任意字符含 r/R。
        if a.len() >= 2 && a.starts_with('-') && !a.starts_with("--") {
            return a[1..].chars().any(|c| c == 'r' || c == 'R');
        }
        false
    })
}

/// cmd 斜杠标志（大小写不敏感），如 `/s` `/S`。
fn has_slash_flag(args: &[String], flag: char) -> bool {
    let want = flag.to_ascii_lowercase();
    args.iter().any(|a| {
        let a = a.to_ascii_lowercase();
        a == format!("/{want}") || (a.starts_with('/') && a[1..].chars().any(|c| c == want))
    })
}

/// 盘符样式：`c:`、`c:\`。
fn is_drive_like(s: &str) -> bool {
    let s = s.trim_matches('"');
    let b = s.as_bytes();
    (b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        || (b.len() == 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/'))
}

/// 裸设备路径：`\\.\PhysicalDriveN`、`/dev/sd*` `/dev/disk*` `/dev/nvme*` `/dev/hd*` `/dev/mmcblk*`。
/// 兼容 bash 分词把 `\\.\` 反斜杠转义打散的情形——用 `physicaldrive` 子串兜底识别。
fn is_device_path(s: &str) -> bool {
    let s = s.trim().trim_matches('"');
    let low = s.to_ascii_lowercase();
    if low.starts_with("\\\\.\\") || low.starts_with("//./") || low.contains("physicaldrive") {
        return true;
    }
    for dev in [
        "/dev/sd",
        "/dev/disk",
        "/dev/nvme",
        "/dev/hd",
        "/dev/mmcblk",
    ] {
        if low.starts_with(dev) {
            return true;
        }
    }
    false
}

/// 毁灭性目标：文件系统根、家目录、常见系统目录。相对路径（`./build`、`dist`）与项目内
/// 绝对路径**不**视为毁灭性——cwd 已受 allowed_roots 约束，删项目自身可由用户 git 恢复。
fn is_catastrophic_target(s: &str) -> bool {
    let raw = s.trim().trim_matches('"');
    if raw.is_empty() {
        return false;
    }
    // 统一为小写 + 正斜杠比较；去掉结尾通配符 `*` 与结尾斜杠。
    let mut norm = raw.to_ascii_lowercase().replace('\\', "/");
    while norm.ends_with('*') || (norm.len() > 1 && norm.ends_with('/')) {
        norm.pop();
    }
    if norm.is_empty() {
        // 原始就是 `/` 或 `\` 或 `/*` → 根。
        return raw == "/" || raw == "\\" || raw.starts_with("/*") || raw.starts_with("\\*");
    }

    // 文件系统根 / 盘根。
    if norm == "/" {
        return true;
    }
    // 盘根：`c:` 或 `c:/`（归一后结尾斜杠已去）。
    let b = norm.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return true;
    }

    // 家目录与环境变量目标。
    const HOME_LIKE: &[&str] = &[
        "~",
        "$home",
        "${home}",
        "%userprofile%",
        "%homepath%",
        "%homedrive%",
        "%windir%",
        "%systemroot%",
        "%systemdrive%",
        "%programfiles%",
        "%programdata%",
        "%appdata%",
    ];
    if HOME_LIKE.contains(&norm.as_str()) {
        return true;
    }

    // Unix 系统目录——前缀匹配：目录本身及其任意子路径都危险（/usr/lib、/etc/x…）。
    const UNIX_SYS_PREFIX: &[&str] = &[
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/var",
        "/boot",
        "/dev",
        "/sys",
        "/proc",
        "/system",
        "/library",
        "/applications",
    ];
    if UNIX_SYS_PREFIX
        .iter()
        .any(|p| norm == *p || norm.starts_with(&format!("{p}/")))
    {
        return true;
    }
    // 家/挂载类目录——仅精确匹配目录本身危险；其下是用户项目（合法，不误拦）。
    const UNIX_HOME_EXACT: &[&str] = &["/root", "/home", "/opt", "/mnt", "/media", "/users"];
    if UNIX_HOME_EXACT.contains(&norm.as_str()) {
        return true;
    }

    // Windows 系统 / 用户根目录（前缀匹配，含盘符）。
    const WIN_SYS_PREFIX: &[&str] = &[
        "c:/windows",
        "c:/program files",
        "c:/programdata",
        "c:/users",
    ];
    if WIN_SYS_PREFIX
        .iter()
        .any(|p| norm == *p || norm.starts_with(&format!("{p}/")))
    {
        // 允许更深的具体子路径（如 c:/users/foo/proj）？users/windows 下再深仍属系统/他人目录，保守拦截根与一级。
        // 仅当正好是这些根或其直接下一级视为毁灭性，避免误拦深层项目路径。
        let depth = norm.matches('/').count();
        return depth <= 2; // c:/windows(1) / c:/users/foo(2) 视为危险；更深放行。
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd_block(c: &str) -> bool {
        validate_command_policy(c, ShellType::Cmd, None).is_err()
    }
    fn bash_block(c: &str) -> bool {
        validate_command_policy(c, ShellType::Bash, None).is_err()
    }

    // ── 误拦回归：引号内的危险串不应触发（修复旧黑名单硬伤）──
    #[test]
    fn quoted_dangerous_string_not_blocked() {
        assert!(!bash_block(r#"echo "rm -rf /""#));
        assert!(!bash_block("echo 'rm -rf /'"));
        assert!(!cmd_block(r#"echo "del /f /s /q C:\""#));
    }

    // ── 正常命令放行 ──
    #[test]
    fn benign_commands_allowed() {
        assert!(!bash_block("cargo build --release"));
        assert!(!bash_block("git status"));
        assert!(!bash_block("rm -rf ./build"));
        assert!(!bash_block("rm -rf dist"));
        assert!(!bash_block("npm run build && git add ."));
        assert!(!cmd_block("del /q build\\out.txt"));
        assert!(!cmd_block("rd /s /q node_modules"));
    }

    // ── 漏拦回归：旧黑名单放行的毁灭性命令现在应拦 ──
    #[test]
    fn catastrophic_now_blocked() {
        assert!(bash_block("rm -rf /"));
        assert!(bash_block("rm -rf /home"));
        assert!(bash_block("rm -rf /usr/lib"));
        assert!(bash_block("rm -rf ~"));
        assert!(bash_block("rm -rf $HOME"));
        assert!(cmd_block("del /f /s /q C:\\"));
        assert!(cmd_block("rd /s /q C:\\Windows"));
        assert!(cmd_block("format c:"));
        assert!(cmd_block("format D: /fs:ntfs"));
    }

    // ── 分隔符注入：链式命令的任一子命令危险即拦 ──
    #[test]
    fn separator_injection_blocked() {
        assert!(bash_block("ls && rm -rf /"));
        assert!(bash_block("ls;rm -rf /"));
        assert!(bash_block("true || rm -rf ~"));
        assert!(bash_block("cat x | rm -rf /")); // 管道后子命令仍分析
        assert!(cmd_block("dir && format c:"));
        // 无空格操作符也要能切
        assert!(bash_block("ls&&rm -rf /"));
    }

    #[test]
    fn sudo_prefix_unwrapped() {
        assert!(bash_block("sudo rm -rf /"));
        assert!(bash_block("sudo MKFS.ext4 /dev/sda"));
    }

    #[test]
    fn device_and_special_tools_blocked() {
        assert!(bash_block("mkfs.ext4 /dev/sdb"));
        assert!(bash_block("dd if=/dev/zero of=/dev/sda"));
        assert!(cmd_block("diskpart"));
        assert!(cmd_block("cipher /w:C"));
        assert!(bash_block("cat img > \\\\.\\PhysicalDrive0"));
    }

    #[test]
    fn fork_bomb_blocked() {
        assert!(bash_block(":(){ :|:& };:"));
        assert!(bash_block(":(){:|:&};:"));
    }

    #[test]
    fn case_insensitive() {
        assert!(bash_block("RM -RF /"));
        assert!(cmd_block("FORMAT C:"));
    }

    // ── Layer 2 白名单 ──
    #[test]
    fn allowlist_enforced() {
        let list = vec!["git".to_string(), "npm".to_string(), "cargo".to_string()];
        assert!(validate_command_policy("git status", ShellType::Bash, Some(&list)).is_ok());
        assert!(validate_command_policy("npm run build", ShellType::Bash, Some(&list)).is_ok());
        // 链式：两个都在白名单才放行
        assert!(
            validate_command_policy("git add . && npm ci", ShellType::Bash, Some(&list)).is_ok()
        );
        // 不在白名单
        assert!(validate_command_policy("python app.py", ShellType::Bash, Some(&list)).is_err());
        assert!(
            validate_command_policy("git status && curl evil", ShellType::Bash, Some(&list))
                .is_err()
        );
    }

    #[test]
    fn empty_allowlist_blocks_all() {
        let empty: Vec<String> = vec![];
        // fail-closed：开启空白名单应拒绝所有命令（与「安全」页空状态提示一致）。
        assert!(validate_command_policy("git status", ShellType::Bash, Some(&empty)).is_err());
        assert!(validate_command_policy("echo hi", ShellType::Bash, Some(&empty)).is_err());
    }

    #[test]
    fn allowlist_and_layer1_compose() {
        let list = vec!["rm".to_string()];
        // 即便 rm 在白名单，Layer 1 仍拦毁灭性 rm。
        assert!(validate_command_policy("rm -rf /", ShellType::Bash, Some(&list)).is_err());
    }
}
