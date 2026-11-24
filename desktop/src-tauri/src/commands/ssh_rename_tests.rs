use super::*;

// ── validate_new_name ────────────────────────────────────────

#[test]
fn validate_new_name_accepts_normal_names() {
    for ok in [
        "config.yml",
        "a b.txt",
        ".hidden",
        "...",
        "配置.yml",
        // 反斜杠在 Linux 文件名里合法：别过度限制，把合法操作拒了。
        "win\\path",
        "UPPER.TXT",
    ] {
        assert!(validate_new_name(ok).is_ok(), "正常名称不应被拒：{ok:?}");
    }
}

#[test]
fn validate_new_name_rejects_bad_names() {
    assert!(validate_new_name("").is_err(), "空名称");
    assert!(validate_new_name("\0").is_err(), "NUL");
    assert!(validate_new_name("a\0b").is_err(), "中间嵌 NUL");
    assert!(validate_new_name("a/b").is_err(), "带 / = 想换目录");
    assert!(validate_new_name("/").is_err(), "纯斜杠");
    assert!(validate_new_name(".").is_err(), "点");
    assert!(validate_new_name("..").is_err(), "点点");
}

// ── validate_dir_path ────────────────────────────────────────

#[test]
fn validate_dir_path_accepts_normal_dirs() {
    for ok in ["/home/deploy", "/", "/a b/c", "relative/dir"] {
        assert!(validate_dir_path(ok).is_ok(), "正常目录不应被拒：{ok:?}");
    }
}

#[test]
fn validate_dir_path_rejects_empty_and_nul() {
    assert!(validate_dir_path("").is_err());
    assert!(validate_dir_path("/a\0b").is_err());
}

// ── rename_target_path ───────────────────────────────────────

#[test]
fn rename_target_path_same_directory() {
    assert_eq!(
        rename_target_path("/home/deploy/config.yml", "app.yml").unwrap(),
        "/home/deploy/app.yml"
    );
    // 中文名：路径拼接不碰字节假设。
    assert_eq!(
        rename_target_path("/home/deploy/config.yml", "配置.yml").unwrap(),
        "/home/deploy/配置.yml"
    );
}

#[test]
fn rename_target_path_at_root() {
    // 父目录是根：不能拼出 "//name"。
    assert_eq!(
        rename_target_path("/config.yml", "hosts").unwrap(),
        "/hosts"
    );
}

#[test]
fn rename_target_path_rejects_unchanged_and_bad_path() {
    assert!(rename_target_path("/home/deploy/config.yml", "config.yml").is_err());
    // 没有 '/'：不是面板会发的形态，但要明确失败而不是拼出怪路径。
    assert!(rename_target_path("config.yml", "x.yml").is_err());
    // 名称校验先行：带 / 的 new_name 先被 validate 拦下。
    assert!(rename_target_path("/a/b", "c/d").is_err());
}

// ── move_target_path ─────────────────────────────────────────

#[test]
fn move_target_path_keeps_basename() {
    assert_eq!(
        move_target_path("/home/deploy/config.yml", "/etc").unwrap(),
        "/etc/config.yml"
    );
    // 目标目录带尾斜杠：不能拼出 "//"。
    assert_eq!(
        move_target_path("/home/deploy/config.yml", "/etc/").unwrap(),
        "/etc/config.yml"
    );
    assert_eq!(
        move_target_path("/home/deploy/config.yml", "/etc///").unwrap(),
        "/etc/config.yml"
    );
    // 目标是根目录。
    assert_eq!(
        move_target_path("/home/deploy/config.yml", "/").unwrap(),
        "/config.yml"
    );
    // 深层目录条目。
    assert_eq!(
        move_target_path("/a/b/c/node_modules", "/x").unwrap(),
        "/x/node_modules"
    );
}

#[test]
fn move_target_path_rejects_same_place_and_bad_from() {
    assert!(move_target_path("/etc/config.yml", "/etc").is_err());
    assert!(move_target_path("/etc/config.yml", "/etc/").is_err());
    // from 不是文件形态（尾斜杠 = 目录路径字面量）：取不到文件名。
    assert!(move_target_path("/etc/dir/", "/x").is_err());
    assert!(move_target_path("no-slash", "/x").is_err());
}

// ── rename_remote_cmd：结构 ──────────────────────────────────

#[test]
fn remote_cmd_no_overwrite_prechecks_and_uses_plain_mv() {
    let cmd = rename_remote_cmd("/home/deploy/config.yml", "/home/deploy/app.yml", false);
    // 预检：-e 跟随软链 + -L 补断链，两个都得在。
    assert!(
        cmd.contains("[ -e '/home/deploy/app.yml' ]"),
        "缺 -e 预检：{cmd}"
    );
    assert!(
        cmd.contains("[ -L '/home/deploy/app.yml' ]"),
        "缺 -L 预检：{cmd}"
    );
    assert!(cmd.contains("||"), "两个预检是或关系：{cmd}");
    assert!(cmd.contains("echo TARGET_EXISTS"), "命中要输出标记：{cmd}");
    assert!(cmd.contains("false"), "命中要以非零码收尾：{cmd}");
    // 目标不存在才 mv：此时没有可覆盖对象，不带 -f 也不会挂起等 y/n。
    assert!(cmd.contains("mv -- '/home/deploy/config.yml' '/home/deploy/app.yml'"));
    assert!(!cmd.contains("mv -f"), "false 分支不该带 -f：{cmd}");
    // 🔴 helper 是常驻 shell：exit 会杀掉会话本身。
    assert!(!cmd.contains("exit"), "命令里不得出现 exit：{cmd}");
}

#[test]
fn remote_cmd_overwrite_uses_force_mv_and_refuses_dir_target() {
    let cmd = rename_remote_cmd("/home/deploy/config.yml", "/home/deploy/nginx.conf", true);
    // -f：PTY 交互下不带 -f 的 mv 遇已存在目标会挂起等 y/n 直到超时。
    assert!(cmd.contains("mv -f -- "), "覆盖分支必须带 -f：{cmd}");
    // 目标是真目录时拒绝：mv 默认会把源挪进目录（静默错位），SFTP 报 EISDIR。
    assert!(
        cmd.contains("[ -d '/home/deploy/nginx.conf' ]"),
        "缺目录判：{cmd}"
    );
    assert!(
        cmd.contains("[ ! -L '/home/deploy/nginx.conf' ]"),
        "目录判要排除软链：{cmd}"
    );
    assert!(cmd.contains("TARGET_IS_DIR"), "目录目标要给明确错误：{cmd}");
    assert!(cmd.contains("false"), "拒绝也要非零码：{cmd}");
    assert!(
        !cmd.contains("echo TARGET_EXISTS"),
        "覆盖分支不跑预检：{cmd}"
    );
    assert!(!cmd.contains("exit"), "命令里不得出现 exit：{cmd}");
}

#[test]
fn remote_cmd_quotes_injection_payloads() {
    // 单引号注入：shell_quote 必须转义，命令结构不被逃逸。
    let cmd = rename_remote_cmd("/home/a'b.yml", "/home/c'; rm -rf / #.yml", false);
    assert!(
        cmd.contains("'/home/a'\\''b.yml'"),
        "from 的单引号必须转义：{cmd}"
    );
    assert!(
        cmd.contains("'/home/c'\\''; rm -rf / #.yml'"),
        "to 的注入载荷必须整体被单引号包住：{cmd}"
    );
    // 转义后命令整体仍是单条 if/else：注入载荷不得在引号外多加命令分隔符。
    // 扫描器必须认 shell_quote 的 `'\''` escape 习语（按 `'` 裸翻转状态每遇必错）；
    // 期望值取同结构无害路径的基线计数，不写死结构分号数。
    fn semis_outside_quotes(cmd: &str) -> usize {
        let mut n = 0;
        let mut in_q = false;
        let mut escaped = false;
        for c in cmd.chars() {
            if escaped {
                escaped = false;
            } else if c == '\\' && !in_q {
                escaped = true;
            } else if c == '\'' {
                in_q = !in_q;
            } else if c == ';' && !in_q {
                n += 1;
            }
        }
        n
    }
    let baseline = rename_remote_cmd("/home/a.yml", "/home/c.yml", false);
    assert!(
        semis_outside_quotes(&baseline) > 0,
        "扫描器必须能数出结构分号，否则断言是死的：{baseline}"
    );
    assert_eq!(
        semis_outside_quotes(&cmd),
        semis_outside_quotes(&baseline),
        "注入载荷在引号外多加了分号：{cmd}"
    );
}

// ── 源级断言：接线形状 ───────────────────────────────────────

/// 两个命令都注册进 invoke_handler——漏注册的编译期症状是前端 invoke
/// 直接报「command not found」，而 Rust 侧单测完全绿着。
#[test]
fn rename_commands_are_registered_in_main() {
    let src = include_str!("../main.rs");
    for name in ["ssh_sftp_rename", "ssh_sftp_move"] {
        let needle = format!("commands::{name}");
        assert!(
            src.contains(&needle),
            "main.rs 未注册 {needle}：前端会 invoke 失败"
        );
    }
}

/// `rename_via_fallback` 必须是完整的三级回退，且 russh 失败后**继续往下走**
/// （与 mkdir / remove 同构：`is_ok()` 早退，而不是 `?` 上传）。
#[test]
fn rename_fallback_has_all_three_tiers() {
    let src = include_str!("ssh_cmds.rs");
    let start = src
        .find("async fn rename_via_fallback")
        .expect("rename_via_fallback 应存在");
    let body = &src[start..];
    let end = body
        .find("\n#[tauri::command]")
        .unwrap_or_else(|| body.find("\npub async fn").unwrap_or(body.len()));
    let body = &body[..end];
    for tier in [
        "russh_rename",
        "run_via_helper",
        "spawn_capture_off_runtime",
    ] {
        assert!(
            body.contains(tier),
            "rename_via_fallback 缺一级回退：{tier}"
        );
    }
    // russh 调用必须是 `is_ok()` 形状：失败不 return Err，落到下一级。
    assert!(
        body.contains(".is_ok()"),
        "russh 失败必须继续回退而不是 ? 上传"
    );
    // 三级跑的是同一条命令（由调用方传进来的 remote_cmd）。
    assert!(
        body.contains("remote_cmd.clone()"),
        "helper 与一次性 ssh 必须跑同一条 remote_cmd"
    );
}

/// russh 侧 rename 的形状：lstat 预检（断链不漏）+ 真 rename 调用 +
/// 标记常量与命令层 echo 的是同一个串。
#[test]
fn russh_rename_shape_and_marker_consistency() {
    let src = include_str!("ssh_russh_file.rs");
    let start = src
        .find("pub(super) async fn russh_rename")
        .expect("russh_rename 应存在");
    let end = src[start..]
        .find("\n/// 取远端 mtime")
        .map(|i| start + i)
        .unwrap_or(src.len());
    let body = &src[start..end];
    assert!(body.contains("sftp.rename(from, to)"), "必须真的调 rename");
    // 预检用 lstat（symlink_metadata）而非 try_exists（stat 跟随软链，
    // 断链目标会被误判成不存在 → 静默替换掉链接）。
    assert!(
        body.contains("symlink_metadata(to)"),
        "预检必须用 lstat 语义：{body}"
    );
    assert!(!body.contains("try_exists(to)"), "预检不得用 stat 语义");

    // needle 运行时拼接：不让本文件出现完整字面量，防源级扫描自匹配。
    let marker = format!("{}{}", "TARGET_", "EXISTS");
    let const_line = format!("RENAME_TARGET_EXISTS: &str = \"{marker}\"");
    assert!(
        src.contains(&const_line),
        "标记常量缺失或与前端约定不一致：{const_line}"
    );
    // 命令层 helper 命令 echo 的必须是同一个串。
    let cmds = include_str!("ssh_cmds.rs");
    let echo_line = format!("echo {marker}");
    assert!(
        cmds.contains(&echo_line),
        "helper 命令 echo 的标记与常量不一致：{echo_line}"
    );
}
