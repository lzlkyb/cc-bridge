use similar::{ChangeTag, TextDiff};

/// `hunks` 档位的回显上限（字节）。超过就截断并注明——一个 20MB 文件的整份替换
/// 展开成 `-`/`+` 两遍，比 base64 还贵，回显失去意义。
const HUNKS_MAX_BYTES: usize = 4096;
/// `hunks` 档位的上下文行数。比 unified diff 默认的 3 行再省一行。
const HUNKS_CONTEXT_RADIUS: usize = 2;

/// 写/改文件后回显多少改动内容（`diff` 参数的取值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffMode {
    /// 不回显：结果里不带 `diff` 字段。
    None,
    /// 只给 `+N/-M 行` 与新旧字节数。
    Stat,
    /// 只给改动 hunk（上下文 2 行），超 [`HUNKS_MAX_BYTES`] 截断并注明。
    Hunks,
    /// 完整 unified diff —— 改造前的行为，留作精确核对时显式索取。
    Full,
    /// 未指定时：新建文件 → [`Self::Stat`]，覆盖/编辑已有文件 → [`Self::Hunks`]。
    ///
    /// 取舍依据：新建文件的全文 diff 里没有一个字节是模型不知道的（内容就是它刚写的），
    /// 唯一效果是把同一份内容第二次塞进上下文；而覆盖已有文件时 hunk 对核对有真实价值，
    /// 所以只压长度、不取消。
    Auto,
}

impl DiffMode {
    /// 解析 `diff` 参数。大小写与首尾空白都容忍。
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "stat" => Ok(Self::Stat),
            "hunks" => Ok(Self::Hunks),
            "full" => Ok(Self::Full),
            "auto" => Ok(Self::Auto),
            other => Err(format!(
                "Unknown diff mode {other:?}; use one of: none, stat, hunks, full, auto"
            )),
        }
    }

    /// 把 [`Self::Auto`] 按「目标文件此前是否存在」落成具体档位。
    pub fn resolve(self, existed: bool) -> Self {
        match self {
            Self::Auto if existed => Self::Hunks,
            Self::Auto => Self::Stat,
            m => m,
        }
    }
}

/// 行级增删统计。
pub struct LineStat {
    pub added: usize,
    pub removed: usize,
}

/// 数一遍增删行数。按行比较，与 [`unified_diff`] 同一套切分（`TextDiff::from_lines`），
/// 所以 `stat` 里的数字与 `full` 里能数出来的 `+`/`-` 行严格一致。
pub fn line_stat(old: &str, new: &str) -> LineStat {
    let mut added = 0;
    let mut removed = 0;
    for change in TextDiff::from_lines(old, new).iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    LineStat { added, removed }
}

/// 按档位渲染一次写入/编辑的 `diff` 字段。返回 `None` 表示结果里**不带**该字段。
///
/// `existed` 只影响 [`DiffMode::Auto`] 的解释；`old_bytes`/`new_bytes` 用真实落盘字节数
/// （编码、换行展开后的），不是 `str::len()` —— GBK 下两者差一倍。
pub fn render(
    mode: DiffMode,
    existed: bool,
    path_label: &str,
    old: &str,
    new: &str,
    old_bytes: usize,
    new_bytes: usize,
) -> Option<String> {
    match mode.resolve(existed) {
        DiffMode::Stat => {
            let s = line_stat(old, new);
            Some(format!(
                "+{}/-{} 行，{} → {} 字节",
                s.added, s.removed, old_bytes, new_bytes
            ))
        }
        DiffMode::Full => Some(unified_diff(path_label, old, new)),
        DiffMode::Hunks => Some(unified_diff_hunks(path_label, old, new)),
        // `resolve` 不会返回 Auto；None 就是不回显。
        DiffMode::None | DiffMode::Auto => None,
    }
}

/// 带上下文半径与长度上限的 unified diff。无改动时返回空串（与 [`unified_diff`] 一致）。
pub fn unified_diff_hunks(path_label: &str, old: &str, new: &str) -> String {
    if old == new {
        return String::new();
    }
    let full = TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(HUNKS_CONTEXT_RADIUS)
        .header(&format!("a/{path_label}"), &format!("b/{path_label}"))
        .to_string();
    truncate_with_note(&full, HUNKS_MAX_BYTES)
}

/// 超过 `max_bytes` 就按**字符边界**截断并附一句可执行的说明。
///
/// 按字符边界切的必要性：diff 里几乎必然有中文，直接切字节会切在多字节序列中间，
/// `String` 切片本身就会 panic。
fn truncate_with_note(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n…（diff 已截断：仅显示前 {cut} 字节，实际共 {} 字节。需要完整改动请传 diff:\"full\"，\
         只要增删行数请传 diff:\"stat\"）",
        &text[..cut],
        text.len()
    )
}

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

    #[test]
    fn diff_mode_parse_accepts_known_and_rejects_other() {
        for (raw, want) in [
            ("none", DiffMode::None),
            ("STAT", DiffMode::Stat),
            (" hunks ", DiffMode::Hunks),
            ("Full", DiffMode::Full),
            ("auto", DiffMode::Auto),
        ] {
            assert_eq!(DiffMode::parse(raw).ok(), Some(want), "解析 {raw:?} 失败");
        }
        let err = DiffMode::parse("diff").expect_err("未知档位必须报错");
        // 错误文案要能让模型自纠：列出全部合法值。
        for needle in ["none", "stat", "hunks", "full", "auto"] {
            assert!(err.contains(needle), "错误文案缺合法值 {needle}: {err}");
        }
    }

    #[test]
    fn auto_resolves_by_whether_target_existed() {
        assert_eq!(DiffMode::Auto.resolve(false), DiffMode::Stat);
        assert_eq!(DiffMode::Auto.resolve(true), DiffMode::Hunks);
        // 显式档位不受 existed 影响。
        assert_eq!(DiffMode::Full.resolve(false), DiffMode::Full);
        assert_eq!(DiffMode::None.resolve(true), DiffMode::None);
    }

    #[test]
    fn line_stat_counts_added_and_removed() {
        let s = line_stat("a\nb\nc\n", "a\nB\nc\nd\n");
        assert_eq!((s.added, s.removed), (2, 1), "b→B 记一增一删，d 记一增");
    }

    #[test]
    fn stat_render_is_one_line_without_content() {
        let out = render(
            DiffMode::Stat,
            false,
            "x.md",
            "",
            &"长内容长内容\n".repeat(50),
            0,
            999,
        )
        .expect("stat 必须有值");
        assert!(out.starts_with("+50/-0 行"), "stat 文案不对: {out}");
        assert!(out.contains("0 → 999 字节"), "stat 应带真实字节数: {out}");
        assert!(!out.contains("长内容"), "stat 档位绝不能回显内容: {out}");
    }

    #[test]
    fn hunks_truncates_at_char_boundary_and_says_so() {
        // 中文内容：直接按字节切会在多字节序列中间 panic，这条测试盯的就是那个 panic。
        let old = "";
        let new = "第一行内容\n".repeat(2000);
        let out = render(DiffMode::Hunks, false, "x.md", old, &new, 0, new.len()).expect("hunks");
        assert!(out.contains("diff 已截断"), "超 4KB 必须注明截断: {out}");
        assert!(
            out.contains("diff:\"full\""),
            "截断提示要给出可执行下一步: {out}"
        );
        assert!(out.len() < 5000, "截断后不应继续膨胀: {}", out.len());
    }

    #[test]
    fn hunks_keeps_short_diff_intact() {
        let out = render(
            DiffMode::Hunks,
            true,
            "a.rs",
            "a\nb\nc\n",
            "a\nB\nc\n",
            6,
            6,
        )
        .expect("hunks");
        assert!(out.contains("@@"), "短 diff 应完整保留: {out}");
        assert!(!out.contains("diff 已截断"), "不该误报截断: {out}");
    }

    #[test]
    fn full_render_matches_legacy_unified_diff() {
        // 回归钉子：diff:"full" 必须与改造前的输出**逐字节相同**，
        // 否则模型对已有文件的核对习惯会被悄悄改掉。
        let old = "one\ntwo\nthree\n";
        let new = "one\nTWO\nthree\n";
        let legacy = unified_diff("a.txt", old, new);
        let out = render(DiffMode::Full, true, "a.txt", old, new, 14, 14).expect("full");
        assert_eq!(out, legacy);
    }

    #[test]
    fn none_render_returns_no_field() {
        assert!(render(DiffMode::None, true, "a.txt", "a", "b", 1, 1).is_none());
    }
}
