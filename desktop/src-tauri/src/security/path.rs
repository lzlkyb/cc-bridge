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
    enforce_whitelist: bool,
) -> Result<PathBuf, String> {
    // 原始入口保持 `&[String]` 签名（测试与个别 override 调用点不动），
    // 内部先 canonicalize 再走缓存版逻辑——canonicalize 逻辑唯一来源在 canonicalize_roots。
    resolve_safe_path_cached(
        requested,
        &canonicalize_roots(allowed_roots),
        enforce_whitelist,
    )
}

/// 缓存版：allowed_roots 已是预 canonicalize 的集合（来自 AppState 缓存），
/// 避免每个工具调用都对所有 root 各做一次 stat 级 canonicalize。
/// 语义与 `resolve_safe_path` 完全一致（roots 的 canonicalize/fallback 在缓存构建时已应用）。
pub fn resolve_safe_path_cached(
    requested: &str,
    allowed_roots: &[PathBuf],
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

    Ok(resolved)
}

fn is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
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

        let result = resolve_safe_path("C:\\Windows\\System32\\cmd.exe", &[root], true);
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

    #[test]
    fn test_whitelist_disabled_allows_outside() {
        // 关闭白名单后，允许解析白名单之外的已存在路径（鉴权由 HTTP 层负责）。
        let temp = std::env::temp_dir();
        let root = temp
            .join("cc-bridge-test-unused")
            .to_string_lossy()
            .to_string();
        let result = resolve_safe_path(&temp.to_string_lossy(), &[root], false);
        assert!(result.is_ok());
    }
}
