use std::path::{Path, PathBuf};

/// 剥掉 Windows canonicalize 产生的 `\\?\` 扩展长度前缀，仅用于展示/存储。
/// 安全比对时两侧仍各自 canonicalize，前缀一致，语义不变。
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// 把一组 root 字符串 canonicalize 为 PathBuf 集合（缓存构建与原始函数共用，逻辑唯一来源）。
/// 对每个 root：能解析就用 canonicalize 后的真实路径，失败（根不存在等）则 fallback 原路径，
/// 与原 `resolve_safe_path` 内联逻辑完全一致。
pub(crate) fn canonicalize_roots(roots: &[String]) -> Vec<PathBuf> {
    roots
        .iter()
        .map(|r| std::fs::canonicalize(r).unwrap_or_else(|_| PathBuf::from(r)))
        .collect()
}

pub fn resolve_safe_path(
    requested: &str,
    allowed_roots: &[String],
    exclude_patterns: &[String],
    enforce_whitelist: bool,
) -> Result<PathBuf, String> {
    // 原始入口保持 `&[String]` 签名（测试与个别 override 调用点不动），
    // 内部先 canonicalize 再走缓存版逻辑——canonicalize 逻辑唯一来源在 canonicalize_roots。
    resolve_safe_path_cached(
        requested,
        &canonicalize_roots(allowed_roots),
        exclude_patterns,
        enforce_whitelist,
    )
}

/// 缓存版：allowed_roots 已是预 canonicalize 的集合（来自 AppState 缓存），
/// 避免每个工具调用都对所有 root 各做一次 stat 级 canonicalize。
/// 语义与 `resolve_safe_path` 完全一致（roots 的 canonicalize/fallback 在缓存构建时已应用）。
///
/// `exclude_patterns`：白名单排除规则（.mcpignore 式）。**只在白名单校验开启时生效**
/// （排除是白名单的子特性：相对命中的根做匹配，关闭白名单后无根可相对，语义失效）。
/// 命中 = 拒绝，只收紧、不放宽；根外路径维持白名单拒绝不变。
pub fn resolve_safe_path_cached(
    requested: &str,
    allowed_roots: &[PathBuf],
    exclude_patterns: &[String],
    enforce_whitelist: bool,
) -> Result<PathBuf, String> {
    let requested_path = PathBuf::from(requested);

    // For existing paths, use canonicalize to resolve symlinks
    let resolved = if requested_path.exists() {
        std::fs::canonicalize(&requested_path)
            .map_err(|e| format!("Failed to resolve path: {e}"))?
    } else {
        // For new paths (write operations), walk up to find existing ancestor
        let mut ancestor = requested_path.clone();
        loop {
            if let Some(parent) = ancestor.parent() {
                if parent.exists() {
                    let real_parent = std::fs::canonicalize(parent)
                        .map_err(|e| format!("Failed to resolve parent: {e}"))?;
                    let remainder = requested_path
                        .strip_prefix(parent)
                        .map_err(|e| format!("Path prefix error: {e}"))?;
                    // 修复：这个 remainder 是未经 canonicalize 的原始尾部，若含 `..`/`.` 组件，理论上可以穿越到
                    // real_parent 之外、绕过后面 is_within 的前缀匹配。当前仅靠 Windows canonicalize 返回的 `\\?\`
                    // verbatim 前缀让文件系统不解释 `..`“侥幸”挡住，一旦换成去前缀的 canonicalize（如 dunce）即可被利用。
                    // 现显式拒绝，不依赖实现细节副作用。
                    if contains_dotdot(remainder) {
                        return Err(format!(
                            "Path contains disallowed '..' or '.' component: {}",
                            requested_path.display()
                        ));
                    }
                    break real_parent.join(remainder);
                }
                ancestor = parent.to_path_buf();
            } else {
                return Err("Cannot resolve path: no existing ancestor".into());
            }
        }
    };

    // 白名单校验可被用户在设置页显式关闭（默认开启）。关闭时仍走上面的
    // canonicalize（解析符号链接/.. 穿越），只跳过"是否落在白名单根内"这一步，
    // 鉴权与限流由 HTTP 层独立把关，不受影响。
    if !enforce_whitelist {
        return Ok(resolved);
    }

    // Check if the resolved path is within any allowed root（roots 已预 canonicalize）
    let is_allowed = allowed_roots.iter().any(|root| is_within(&resolved, root));

    if !is_allowed {
        // 报错时附上白名单，远程 Claude Code 一次撞墙即可得知可访问范围，无需盲猜。
        let roots_hint = if allowed_roots.is_empty() {
            "(whitelist is empty — no directories are accessible; add roots in the cc-bridge panel)"
                .to_string()
        } else {
            allowed_roots
                .iter()
                .map(|p| display_path(p))
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(format!(
            "Access denied: {} is not within any allowed root. Allowed roots: {}",
            display_path(&resolved),
            roots_hint
        ));
    }

    // 排除检查（在「根目录允许」判定通过之后追加）：相对命中的根取相对路径，
    // 任一模式命中即拒绝。空模式零开销直通——绝大多数用户不配置排除。
    if !exclude_patterns.is_empty() {
        if let Some(root) = allowed_roots.iter().find(|root| is_within(&resolved, root)) {
            if let Ok(rel) = resolved.strip_prefix(root) {
                if is_excluded(&rel.to_string_lossy(), exclude_patterns) {
                    return Err(format!(
                        "Access denied: {} matches an exclude pattern ({}). Remove the pattern in the cc-bridge panel to allow access.",
                        display_path(&resolved),
                        exclude_patterns.join(", ")
                    ));
                }
            }
        }
    }

    Ok(resolved)
}

fn is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// 排除判定：任一模式命中相对路径即排除。模式语义见 `glob_match`。
fn is_excluded(rel_path: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| glob_match(p, rel_path))
}

/// fnmatch 式 glob 匹配（手写 ≈70 行，不引入 glob crate——依赖纪律 + 语义可控）。
///
/// 语法：`**` 跨层（零或多层目录段）、`*` 单段内任意字符、`?` 单段内单字符。
/// 语义（对齐 .gitignore 直觉）：
/// - 模式**含 `/`**：对相对路径整体匹配（`src/**/x.ts`、`build/**`）；
/// - 模式**不含 `/`**：对相对路径的**任意一段**匹配——`*.key` 拦任意深度的
///   .key 文件，`node_modules` 把该目录连同内容一起拦。
///
/// Windows 文件系统不区分大小写，两侧统一小写比较（`cfg!` 编译期常量，Unix 保持敏感）；
/// 反斜杠统一视作路径分隔符（canonicalize 后的 Windows 路径是 `\`）。
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = normalize_for_match(pattern);
    let path = normalize_for_match(path);
    if pattern.contains('/') {
        let pat: Vec<&str> = pattern.split('/').collect();
        let pth: Vec<&str> = path.split('/').collect();
        glob_segments(&pat, &pth)
    } else {
        path.split('/')
            .any(|seg| glob_segments(&[pattern.as_str()], &[seg]))
    }
}

fn normalize_for_match(s: &str) -> String {
    let s = s.replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// 段级递归匹配：`**` 段吞零或多段；其余段逐段 fnmatch。
fn glob_segments(pat: &[&str], pth: &[&str]) -> bool {
    match pat.first() {
        None => pth.is_empty(),
        Some(&"**") => (0..=pth.len()).any(|n| glob_segments(&pat[1..], &pth[n..])),
        Some(p) => match pth.first() {
            Some(seg) => fnmatch_segment(p, seg) && glob_segments(&pat[1..], &pth[1..]),
            None => false,
        },
    }
}

/// 单段内 fnmatch：`*` 任意串、`?` 单字符、字面量相等。段很短，递归回溯足够。
fn fnmatch_segment(pattern: &str, text: &str) -> bool {
    let (pc, prest) = match pattern.chars().next() {
        Some(c) => (c, &pattern[c.len_utf8()..]),
        None => return text.is_empty(),
    };
    match pc {
        '*' => (0..=text.chars().count()).any(|n| {
            let skip = text
                .char_indices()
                .nth(n)
                .map(|(i, _)| i)
                .unwrap_or(text.len());
            fnmatch_segment(prest, &text[skip..])
        }),
        '?' => match text.chars().next() {
            Some(t) => fnmatch_segment(prest, &text[t.len_utf8()..]),
            None => false,
        },
        c => match text.chars().next() {
            Some(t) if t == c => fnmatch_segment(prest, &text[t.len_utf8()..]),
            _ => false,
        },
    }
}

/// F1 修复：检测路径分量中是否含 `..`(ParentDir)/`.`(CurDir) 组件。用于拒绝新建路径分支里未规范化的
/// 尾部 remainder，避免其中的 `..` 在后续真实文件 I/O 时被重新解释为目录跳转、绕过 is_within 的前缀匹配。
fn contains_dotdot(p: &Path) -> bool {
    p.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_path_traversal_blocked() {
        let temp = std::env::temp_dir().join("cc-bridge-test-path");
        let _ = fs::create_dir_all(&temp);
        let root = temp.to_string_lossy().to_string();

        let result = resolve_safe_path("C:\\Windows\\System32\\cmd.exe", &[root], &[], true);
        assert!(result.is_err());
    }

    #[test]
    fn test_contains_dotdot_detects_traversal_components() {
        // F1 回归：直接验证新增的 remainder 拒绝逻辑本身（纯组件判断，不碰文件系统，确定性强）：
        // 真实走到这个分支需要“多级不存在的中间目录 + 末尾 ..”才能让 remainder 保留 `..`（Windows 对
        // .exists() 本身就会先词法折叠掉紧跟在末尾的 ..），不好造确定性 fixture，故直接单测判断函数。
        assert!(contains_dotdot(Path::new("sub/../secret.txt")));
        assert!(contains_dotdot(Path::new("./secret.txt")));
        assert!(contains_dotdot(Path::new("a/b/../../c")));
        assert!(!contains_dotdot(Path::new("sub/secret.txt")));
        assert!(!contains_dotdot(Path::new("secret.txt")));
    }

    /// 回归：junction（目录联接）不能把路径解析骗到白名单根之外。
    ///
    /// 三条断言都来自实测，不是推断：
    /// - **目标存在**的 junction：`parent.exists()` 为真 ⇒ 走 canonicalize 分支 ⇒
    ///   链接被解掉、真实路径落在根外 ⇒ 拒绝；
    /// - **悬空** junction（链接指向的目录还不存在）：`parent.exists()` 为假 ⇒ 祖先退回
    ///   上一级，链接作为未规范化的 remainder 被原样拼进来 ⇒ 解析这一层会**放行**。
    ///   但此时 `create_dir_all` 在链接目标处失败，字节根本落不下去；而攻击方一旦把
    ///   目标建出来，链接就变成「目标存在」，解析立刻转为拒绝。两侧都堵住。
    ///
    /// 所以此处断言的是**最终效果**（解析拒绝，或解析放行但写不下去），而不是
    /// 「解析一定拒绝」——后者在悬空期间本就不成立，硬断言会让测试变成假的。
    #[cfg(windows)]
    #[test]
    fn junction_cannot_escape_allowed_root() {
        let base = std::env::temp_dir().join(format!("cc-bridge-junc-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let root_s = root.to_string_lossy().to_string();

        let mk = |link: &Path, target: &Path| {
            let out = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "mklink 失败：{}",
                String::from_utf8_lossy(&out.stdout)
            );
        };

        // ① 目标存在：必须直接拒绝
        let live = root.join("live");
        mk(&live, &outside);
        let live_file = live.join("a.txt");
        assert!(
            resolve_safe_path(
                &live_file.to_string_lossy(),
                std::slice::from_ref(&root_s),
                &[],
                true
            )
            .is_err(),
            "指向根外的 junction 必须被拒"
        );

        // ② 悬空：允许解析放行，但绝不能让字节落到根外
        let ghost_target = base.join("ghost-target");
        let ghost = root.join("ghost");
        mk(&ghost, &ghost_target);
        let ghost_file = ghost.join("nested").join("escaped.txt");
        if let Ok(p) = resolve_safe_path(
            &ghost_file.to_string_lossy(),
            std::slice::from_ref(&root_s),
            &[],
            true,
        ) {
            // 解析放行了 → 后续那一步必须失败，且根外不能长出任何东西
            let _ = fs::create_dir_all(p.parent().unwrap());
            let _ = fs::write(&p, b"escaped");
            assert!(
                !ghost_target.join("nested").join("escaped.txt").exists(),
                "悬空 junction 不得让写入落到根外：{}",
                p.display()
            );
        }

        // ③ 目标一旦被建出来，解析必须转为拒绝
        fs::create_dir_all(&ghost_target).unwrap();
        assert!(
            resolve_safe_path(
                &ghost_file.to_string_lossy(),
                std::slice::from_ref(&root_s),
                &[],
                true
            )
            .is_err(),
            "链接目标存在后必须拒绝"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_whitelist_disabled_allows_outside() {
        // 关闭白名单后，允许解析白名单之外的已存在路径（鉴权由 HTTP 层负责）。
        let temp = std::env::temp_dir();
        let root = temp
            .join("cc-bridge-test-unused")
            .to_string_lossy()
            .to_string();
        let result = resolve_safe_path(&temp.to_string_lossy(), &[root], &[], false);
        assert!(result.is_ok());
    }

    // ── 排除规则（.mcpignore 式）单测 ──

    #[test]
    fn glob_double_star_crosses_layers() {
        // ** 跨层：零层也命中（src/**/x 同时覆盖 src/x 与 src/a/b/x）。
        assert!(glob_match("src/**/x.ts", "src/x.ts"));
        assert!(glob_match("src/**/x.ts", "src/a/b/x.ts"));
        // ** 结尾：目录连同任意深度内容。
        assert!(glob_match("build/**", "build"));
        assert!(glob_match("build/**", "build/a/b/c.obj"));
        assert!(!glob_match("build/**", "builder/a"));
    }

    #[test]
    fn glob_single_star_stays_in_segment() {
        // * 不跨层：模式含 / 时只在单段内生效。
        assert!(glob_match("logs/*.log", "logs/app.log"));
        assert!(!glob_match("logs/*.log", "logs/sub/app.log"));
        assert!(!glob_match("logs/*.log", "logs/app.log.bak"));
        // ? 单字符。
        assert!(glob_match("file?.txt", "file1.txt"));
        assert!(!glob_match("file?.txt", "file10.txt"));
    }

    #[test]
    fn glob_bare_pattern_hits_any_segment() {
        // 不含 / 的模式对任意一层的段名生效：.gitignore 直觉。
        assert!(glob_match("*.key", "api.key"));
        assert!(glob_match("*.key", "secrets/api.key"));
        assert!(!glob_match("*.key", "secrets/api.key.bak"));
        assert!(glob_match("node_modules", "node_modules"));
        assert!(glob_match("node_modules", "a/node_modules/b.js"));
        assert!(glob_match(".env*", ".env.local"));
        assert!(glob_match(".env*", "config/.env.production"));
    }

    #[test]
    fn glob_separators_and_case() {
        // Windows 路径分隔符 \ 与模式里的 / 等价。
        assert!(glob_match("src/**/x.ts", r"src\a\x.ts"));
        assert!(glob_match(r"build\**", "build/a"));
    }

    #[cfg(windows)]
    #[test]
    fn glob_case_insensitive_on_windows() {
        assert!(glob_match("*.KEY", "secrets.Api.key"));
        assert!(glob_match("Build/**", "BUILD/a/b"));
        assert!(glob_match("Node_Modules", "node_modules"));
    }

    #[test]
    fn exclude_blocks_matching_path_inside_root() {
        let temp = std::env::temp_dir().join("cc-bridge-test-exclude");
        let _ = fs::create_dir_all(temp.join("secrets"));
        let root = temp.to_string_lossy().to_string();

        // 根内命中排除模式 → 拒绝，报错说明命中了模式。
        let secret = temp.join("secrets").join("key.txt");
        let r = resolve_safe_path(
            &secret.to_string_lossy(),
            std::slice::from_ref(&root),
            &["secrets/**".into()],
            true,
        );
        let err = r.unwrap_err().to_string();
        assert!(err.contains("exclude pattern"), "unexpected error: {err}");

        // 未命中 → 放行。
        let plain = temp.join("src").join("main.rs");
        let r = resolve_safe_path(
            &plain.to_string_lossy(),
            std::slice::from_ref(&root),
            &["secrets/**".into()],
            true,
        );
        assert!(r.is_ok());

        // 空模式 = 无排除，行为与旧版一致。
        let r = resolve_safe_path(
            &secret.to_string_lossy(),
            std::slice::from_ref(&root),
            &[],
            true,
        );
        assert!(r.is_ok());
    }

    #[test]
    fn exclude_never_widens_outside_root() {
        // 根外路径维持白名单拒绝，排除规则既不救它也不改报错语义。
        let temp = std::env::temp_dir().join("cc-bridge-test-exclude-out");
        let _ = fs::create_dir_all(&temp);
        let unrelated = std::env::temp_dir().join("cc-bridge-test-exclude-unrel");
        let _ = fs::create_dir_all(unrelated.join("secrets"));
        let r = resolve_safe_path(
            &unrelated.join("secrets").join("k.txt").to_string_lossy(),
            &[temp.to_string_lossy().to_string()],
            &["secrets/**".into()],
            true,
        );
        let err = r.unwrap_err().to_string();
        assert!(
            err.contains("not within any allowed root"),
            "unexpected: {err}"
        );
    }
}
