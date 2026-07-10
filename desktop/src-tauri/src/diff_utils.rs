use similar::TextDiff;

/// 生成 unified diff（供 edit_files/write_files 改文件后随结果回传增删摘要）。
///
/// old_content 为空且 new_content 非空时，生成的 diff 会把整个新内容都标为新增行（对应新建文件）。
/// 两者完全相同时返回空字符串，调用方据此判断是否要在返回结果里附带 diff 字段。
///
/// 注意：这个 diff 主要供远程 Claude Code 自己（作为读取工具结果的 LLM）核对改动是否符合
/// 预期，不保证客户端会像原生 Edit 工具那样把它渲染成彩色高亮（MCP 工具结果的渲染方式由
/// 客户端决定，非本服务能控制）。
pub fn unified_diff(path_label: &str, old_content: &str, new_content: &str) -> String {
    if old_content == new_content {
        return String::new();
    }
    TextDiff::from_lines(old_content, new_content)
        .unified_diff()
        .header(&format!("a/{path_label}"), &format!("b/{path_label}"))
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_content_returns_empty() {
        // 旧版编辑前/后字节一致 = 没改、调用方据此可省去 diff 字段。
        let d = unified_diff("foo.txt", "same\n", "same\n");
        assert!(d.is_empty(), "相同内容应返回空（实际: {d:?})");
    }

    #[test]
    fn new_file_marks_all_lines_added() {
        // 旧内容为空、新内容非空 = 新建文件，全部行标记为 +（除文件头--- /+++外）。
        let d = unified_diff("new.md", "", "alpha\nbeta\n");
        assert!(d.contains("--- a/new.md"));
        assert!(d.contains("+++ b/new.md"));
        assert!(d.contains("+alpha"));
        assert!(d.contains("+beta"));
        // 不应有以 "-" 开头的实际删除行。--- a/new.md 这里的 "-" 不算，是文件头标记，
        // 这里因为其前面是 "/--- a/new.md" 头行 + 空格/换行，断言"行首为 -"需要按行查。
        let has_deletion_line = d
            .lines()
            .any(|l| l.starts_with('-') && !l.starts_with("---"));
        assert!(!has_deletion_line, "不应有实际删除行：{d}");
    }

    #[test]
    fn modified_file_includes_hunk_header() {
        // 中间一行变更 = 出现 @@ hunk 头 + -/+/上下文。
        let d = unified_diff(
            "Cargo.toml",
            "a\nb\nc\n",
            "a\nB\nc\n", // b → B
        );
        assert!(d.contains("@@"), "应包含 @@ hunk 头：{d}");
        assert!(d.contains("-b"));
        assert!(d.contains("+B"));
    }

    #[test]
    fn path_label_is_in_headers() {
        // 调用方传 relative label 时 a/b 头必须反映——这关系到 Claude Code 能否正确识别
        // 这是哪个文件的 diff。
        let d = unified_diff("src/lib.rs", "x", "y");
        assert!(d.contains("--- a/src/lib.rs"));
        assert!(d.contains("+++ b/src/lib.rs"));
    }
}
