//! 命令输出的服务端过滤：`include` / `exclude` / `tailLines`。
//!
//! WHY: 真实编译输出里 90% 是无用告警（NC 的 ecj 会刷几十行 `invalid Class-Path header`），
//! 模型只能再跑一次 `grep -v` 过滤——一次往返白白多花一轮。过滤放在服务端做，
//! 被剔除的行只报**数量**，不进上下文。
//!
//! 三条设计约束：
//! 1. **无参数时零改动**：`is_active()` 为 false 时原样返回同一个字符串，
//!    响应与改造前逐字节一致（不会因为「多了个字段」而影响既有调用方）。
//! 2. **按行过滤**：`include`/`exclude` 都是「整行是否保留」的判定，不是子串替换。
//!    匹配对象是**不含行尾**的行内容，所以 `^ERR` 这类锚点才符合直觉。
//! 3. **换行原样保留**：用 `split_inclusive('\n')` 拼接，不会把 CRLF 或末尾空行改掉。

use regex::Regex;
use serde_json::{json, Value};

/// 一行输出是否保留的判定规则 + 尾部截断行数。
#[derive(Debug, Clone, Default)]
pub(crate) struct OutputFilter {
    include: Option<Regex>,
    exclude: Option<Regex>,
    tail_lines: Option<usize>,
}

/// 过滤结果：文本 + 两个计数。
pub(crate) struct Filtered {
    pub text: String,
    /// 被 `include` / `exclude` 剔除的行数。
    pub dropped: usize,
    /// 因 `tailLines` 被省略的前置行数。
    pub omitted: usize,
}

impl OutputFilter {
    /// 编译规则。正则写错时**整次调用报错**（不静默当成「不匹配」——
    /// 那会让调用方以为过滤生效了，实际拿到未过滤的全量输出）。
    pub(crate) fn new(
        include: Option<&str>,
        exclude: Option<&str>,
        tail_lines: Option<usize>,
    ) -> Result<Self, String> {
        Ok(Self {
            include: compile(include, "include")?,
            exclude: compile(exclude, "exclude")?,
            tail_lines,
        })
    }

    /// 是否真的会改动输出。false 时 `apply` 原样返回，响应形状不变。
    pub(crate) fn is_active(&self) -> bool {
        self.include.is_some() || self.exclude.is_some() || self.tail_lines.is_some()
    }

    /// 按行过滤 + 截尾。
    pub(crate) fn apply(&self, text: &str) -> Filtered {
        if !self.is_active() {
            return Filtered {
                text: text.to_string(),
                dropped: 0,
                omitted: 0,
            };
        }

        let mut kept: Vec<&str> = Vec::new();
        let mut dropped = 0usize;
        for chunk in text.split_inclusive('\n') {
            // 判定用「去掉行尾」的内容：`^ERR` 才能匹配到以 ERR 开头的那一行。
            let line = chunk.trim_end_matches('\n').trim_end_matches('\r');
            let keep = self.include.as_ref().is_none_or(|re| re.is_match(line))
                && self.exclude.as_ref().is_none_or(|re| !re.is_match(line));
            if keep {
                kept.push(chunk);
            } else {
                dropped += 1;
            }
        }

        let mut omitted = 0usize;
        if let Some(n) = self.tail_lines {
            if kept.len() > n {
                omitted = kept.len() - n;
                kept.drain(..omitted);
            }
        }

        Filtered {
            text: kept.concat(),
            dropped,
            omitted,
        }
    }

    /// 过滤统计字段（`{prefix}DroppedLines` / `{prefix}OmittedLines`）。
    ///
    /// 只在 `is_active()` 为真时调用——零参数时响应里不该凭空多出两个 0。
    pub(crate) fn stats_fields(&self, prefix: &str, f: &Filtered) -> Vec<(String, Value)> {
        vec![
            (format!("{prefix}DroppedLines"), json!(f.dropped)),
            (format!("{prefix}OmittedLines"), json!(f.omitted)),
        ]
    }
}

fn compile(pattern: Option<&str>, label: &str) -> Result<Option<Regex>, String> {
    match pattern.map(str::trim).filter(|p| !p.is_empty()) {
        // 空串按「未提供」处理：客户端常把可选参数发成 ""。
        Some(p) => Regex::new(p)
            .map(Some)
            .map_err(|e| format!("{label} 正则无效（{p}）：{e}")),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "ok 1\ninvalid Class-Path header\nok 2\ninvalid Class-Path header\nok 3\n";

    /// 零参数：原样返回，且计数为 0（响应形状不因这个模块而改变）。
    #[test]
    fn inactive_filter_is_byte_identical() {
        let f = OutputFilter::new(None, None, None).expect("build");
        assert!(!f.is_active());
        let out = f.apply(SAMPLE);
        assert_eq!(out.text, SAMPLE);
        assert_eq!((out.dropped, out.omitted), (0, 0));
    }

    /// 空串参数等同未提供（客户端常把可选字段发成 ""）。
    #[test]
    fn empty_patterns_are_treated_as_absent() {
        let f = OutputFilter::new(Some(""), Some("   "), None).expect("build");
        assert!(!f.is_active());
    }

    #[test]
    fn exclude_drops_matching_lines_and_counts_them() {
        let f = OutputFilter::new(None, Some("^invalid Class-Path"), None).expect("build");
        let out = f.apply(SAMPLE);
        assert_eq!(out.text, "ok 1\nok 2\nok 3\n");
        assert_eq!(out.dropped, 2, "被剔除的行数必须报出来");
        assert_eq!(out.omitted, 0);
    }

    #[test]
    fn include_keeps_only_matching_lines() {
        let f = OutputFilter::new(Some("^ok 2$"), None, None).expect("build");
        let out = f.apply(SAMPLE);
        assert_eq!(out.text, "ok 2\n");
        assert_eq!(out.dropped, 4);
    }

    /// include 与 exclude 同时给：先取 include 命中的，再剔除 exclude 命中的。
    #[test]
    fn include_and_exclude_compose() {
        let f = OutputFilter::new(Some("^ok"), Some("3$"), None).expect("build");
        let out = f.apply(SAMPLE);
        assert_eq!(out.text, "ok 1\nok 2\n");
        assert_eq!(out.dropped, 3);
    }

    #[test]
    fn tail_lines_keeps_last_n() {
        let f = OutputFilter::new(None, None, Some(2)).expect("build");
        let out = f.apply("a\nb\nc\nd\n");
        assert_eq!(out.text, "c\nd\n");
        assert_eq!(out.omitted, 2);
        assert_eq!(out.dropped, 0);
    }

    /// tailLines 与过滤同时用：先过滤，再截尾（否则「最后 N 行」会被过滤得七零八落）。
    #[test]
    fn tail_applies_after_filtering() {
        let f = OutputFilter::new(None, Some("^noise"), Some(2)).expect("build");
        let out = f.apply("a\nnoise1\nb\nnoise2\nc\n");
        assert_eq!(out.text, "b\nc\n");
        assert_eq!(out.omitted, 1);
        assert_eq!(out.dropped, 2);
    }

    /// CRLF 输入不被破坏：剔除后剩下的行仍是 CRLF。
    #[test]
    fn crlf_is_preserved() {
        let f = OutputFilter::new(None, Some("^noise"), None).expect("build");
        let out = f.apply("a\r\nnoise\r\nb\r\n");
        assert_eq!(out.text, "a\r\nb\r\n");
    }

    /// 正则写错必须报错，不能静默当成「全不匹配」。
    #[test]
    fn invalid_regex_is_rejected() {
        let err = OutputFilter::new(Some("(["), None, None).expect_err("非法正则必须报错");
        assert!(err.contains("include"), "错误要指出是哪个参数：{err}");
    }

    /// 匹配对象不含行尾：`ERR$` 能命中 `...ERR\r\n`（否则 Windows 输出永远匹配不上）。
    #[test]
    fn anchors_match_without_line_endings() {
        let f = OutputFilter::new(Some("ERR$"), None, None).expect("build");
        let out = f.apply("warning: ERR\r\nother\r\n");
        assert_eq!(out.text, "warning: ERR\r\n");
    }
}
