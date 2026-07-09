use std::path::{Path, PathBuf};

/// 剥掉 Windows canonicalize 产生的 `\\?\` 扩展长度前缀，仅用于展示/存储。
/// 安全比对时两侧仍各自 canonicalize，前缀一致，语义不变。
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

pub fn resolve_safe_path(
    requested: &str,
    allowed_roots: &[String],
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

    // Check if the resolved path is within any allowed root
    let is_allowed = allowed_roots.iter().any(|root| {
        let root_path = match std::fs::canonicalize(root) {
            Ok(p) => p,
            Err(_) => PathBuf::from(root),
        };
        is_within(&resolved, &root_path)
    });

    if !is_allowed {
        // 报错时附上白名单，远程 Claude Code 一次撞墙即可得知可访问范围，无需盲猜。
        let roots_hint = if allowed_roots.is_empty() {
            "(whitelist is empty — no directories are accessible; add roots in the cc-bridge panel)"
                .to_string()
        } else {
            allowed_roots.join(", ")
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
