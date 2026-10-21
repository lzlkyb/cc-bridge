use std::path::Path;

/// 扩展名校验的**唯一入口**：`allowed` 是用户在「安全 → 文件管控」维护的白名单。
///
/// `allowed` 为空 = 不限制（沿用既有语义，见 `test_empty_whitelist_allows_all`）。
pub fn assert_extension_allowed(file_path: &Path, allowed: &[String]) -> Result<(), String> {
    assert_extension_allowed_with_builtin(file_path, allowed, &[])
}

/// 带「内置兜底」的版本：`builtin` 里的扩展名**永远允许**，与用户白名单求并集。
///
/// WHY：某些工具只有唯一目标格式（`notebook_edit` → `.ipynb`）。该格式若不在用户的
/// 配置白名单里，工具就等于默认不可用——而 `db.rs::ensure_defaults` 用 `INSERT OR IGNORE`
/// 写默认值，**存量用户的配置永远不会被新的默认值更新**，改 `BridgeConfig::default()`
/// 只救新装用户。所以还需要这层运行时兜底。
///
/// 安全面：`builtin` 只由常量提供，不接受用户输入；路径仍受 `allowed_roots` /
/// `exclude_patterns` / 只读模式 / 备份 / 审计全部约束。`mcp/tools/view_image.rs` 的
/// `IMAGE_EXTENSIONS` 是同一套取舍的先例。
///
/// 传 `&[]` 等价于 `assert_extension_allowed`。
pub fn assert_extension_allowed_with_builtin(
    file_path: &Path,
    allowed: &[String],
    builtin: &[&str],
) -> Result<(), String> {
    if allowed.is_empty() {
        return Ok(());
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()));

    match ext {
        Some(ext) if is_builtin(&ext, builtin) || matches_any(&ext, allowed) => Ok(()),
        // 🔴 文案必须**可操作**。原来只回一句 "Extension '.pptx' is not in the allowed list"，
        // AI 端看到这句只会原地重试、或改用 base64 绕路，绝不会想到「让用户去改设置」。
        // 这句话覆盖 read/write/edit/copy/delete/analyze/notebook/prepare_* 全部工具。
        Some(ext) => Err(format!(
            "扩展名 '{ext}' 不在允许列表内。如需放行，请在 CC Bridge 桌面端「安全 → 文件管控 → 扩展名」中添加 '{ext}' 后重试。"
        )),
        None => Err(
            "文件没有扩展名，无法通过扩展名白名单校验。请给它补上扩展名；或确认传入的是文件路径而非目录。"
                .into(),
        ),
    }
}

/// `builtin` 与 `allowed` 都接受「带点 / 不带点」两种写法，比较一律忽略大小写。
fn is_builtin(ext_with_dot: &str, builtin: &[&str]) -> bool {
    let bare = ext_with_dot.trim_start_matches('.');
    builtin
        .iter()
        .any(|b| b.trim_start_matches('.').eq_ignore_ascii_case(bare))
}

fn matches_any(ext_with_dot: &str, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|a| a.trim().eq_ignore_ascii_case(ext_with_dot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_allowed_extension() {
        let allowed = vec![".js".into(), ".ts".into()];
        assert!(assert_extension_allowed(&PathBuf::from("test.js"), &allowed).is_ok());
        assert!(assert_extension_allowed(&PathBuf::from("test.exe"), &allowed).is_err());
    }

    #[test]
    fn test_empty_whitelist_allows_all() {
        assert!(assert_extension_allowed(&PathBuf::from("test.exe"), &[]).is_ok());
    }

    /// 内置清单与用户白名单求并集：即使配置里没有 `.ipynb`，也允许。
    #[test]
    fn builtin_extension_is_allowed_even_if_absent_from_config() {
        let allowed = vec![".js".into()];
        assert!(assert_extension_allowed_with_builtin(
            &PathBuf::from("n.ipynb"),
            &allowed,
            &["ipynb"]
        )
        .is_ok());
        // 内置清单之外仍然要拦。
        assert!(assert_extension_allowed_with_builtin(
            &PathBuf::from("x.exe"),
            &allowed,
            &["ipynb"]
        )
        .is_err());
    }

    /// 空白名单 = 不限制，内置清单在其中不起副作用。
    #[test]
    fn builtin_does_not_change_empty_whitelist_semantics() {
        assert!(
            assert_extension_allowed_with_builtin(&PathBuf::from("a.exe"), &[], &["ipynb"]).is_ok()
        );
    }

    /// 拒绝文案必须点名「去哪儿改」，否则 AI 端无从下手。
    #[test]
    fn rejection_message_tells_where_to_fix_it() {
        let allowed = vec![".js".into()];
        let err = assert_extension_allowed(&PathBuf::from("deck.pptx"), &allowed).unwrap_err();
        assert!(err.contains(".pptx"), "{err}");
        assert!(err.contains("文件管控"), "必须给出可操作指引：{err}");
        assert!(err.contains("安全"), "必须点明页面位置：{err}");
    }

    /// 大小写不敏感（`.PNG` / `.Png` 都应命中 `.png`）。
    #[test]
    fn extension_match_is_case_insensitive() {
        let allowed = vec![".png".into()];
        assert!(assert_extension_allowed(&PathBuf::from("a.PNG"), &allowed).is_ok());
        // 白名单里存大写也要能命中（用户手输过 ".PNG"）。
        let upper = vec![".PNG".into()];
        assert!(assert_extension_allowed(&PathBuf::from("a.png"), &upper).is_ok());
    }
}
