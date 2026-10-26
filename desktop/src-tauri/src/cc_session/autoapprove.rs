//! 审批自动放行：命中规则的 `can_use_tool` **代替用户**回 `allow`。
//!
//! ## 规则形状（与 Claude Code settings 的 permissions 同构，但不通用配）
//!
//! ```text
//! 工具名(参数glob)     ← 工具名与主参数都匹配才放行
//! 工具名               ← 只匹配工具名（该工具的任何入参都放行）
//! ```
//!
//! 「主参数」按工具定：Bash→`command`、Read/Write/Edit/NotebookEdit→`file_path`、
//! Glob/Grep→`pattern`，其余工具→整入参的紧凑 JSON。 glob 用 globset 默认语义：
//! `*` **跨 `/`**，要区分目录用 `**`。
//!
//! ## 三条必须守住的性质
//!
//! 1. **fail-closed**：规则解析不出来 = 永不匹配；主参数取不到 = 带参数模式的规则
//!    不匹配（看不见要批什么就不能批）。空规则表 = 全部人工。
//! 2. **提问永不自动放行**：`AskUserQuestion` 的答案只能用户给，规则写得再宽也不问
//!    （这条在调用方 `manager.rs` 强制，这里只处理 `PermissionAsk`）。
//! 3. **可审计**：命中后必须记 `PermissionResolved{auto:true}`，界面与落盘都能
//!    区分「用户点的」和「规则放的」。

use serde_json::Value;

use globset::{Glob, GlobMatcher};

/// 一条编译后的规则。
#[derive(Debug)]
pub struct CompiledRule {
    /// 工具名 glob。
    tool: GlobMatcher,
    /// 参数 glob。`None` = 只匹配工具名。
    arg: Option<GlobMatcher>,
    /// 规则原文。命中时进日志，用户得知道是哪一条放的行。
    raw: String,
}

/// 一组编译后的规则。**空表 = 一条都不放行。**
#[derive(Debug, Default)]
pub struct RuleSet {
    rules: Vec<CompiledRule>,
}

impl RuleSet {
    /// 编译规则表。**解析不了的规则静默跳过**（fail-closed：它永远不匹配）。
    ///
    /// 不在这一步报错是因为调用方在事件线程上，每次 ask 都会编译一遍 ——
    /// 为一条坏规则刷日志只会把真正的问题淹掉。坏规则的反馈在设置页的说明文案里。
    pub fn compile(raw: &[String]) -> Self {
        let mut rules = Vec::new();
        for r in raw {
            if let Some(rule) = compile_one(r) {
                rules.push(rule);
            }
        }
        Self { rules }
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// 命中返回规则原文；不命中返回 `None`。
    pub fn match_rule(&self, tool: &str, input: &Value) -> Option<&str> {
        for rule in &self.rules {
            if !rule.tool.is_match(tool) {
                continue;
            }
            match &rule.arg {
                // 只匹配工具名的规则：用户明确要「这个工具全放行」。
                None => return Some(&rule.raw),
                Some(arg_glob) => {
                    let primary = primary_arg(tool, input);
                    // 取不到主参数 ⇒ 不匹配。看不见要批什么就不能批。
                    if !primary.is_empty() && arg_glob.is_match(&primary) {
                        return Some(&rule.raw);
                    }
                }
            }
        }
        None
    }
}

/// 解析一条规则。坏形状返回 `None`。
fn compile_one(raw: &str) -> Option<CompiledRule> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (tool_pat, arg_pat) = match raw.strip_suffix(')') {
        Some(inner) => {
            let (tool, arg) = inner.split_once('(')?;
            (tool.trim(), Some(arg.trim()))
        }
        // 不带括号 = 只匹配工具名。空工具名（如 `(**)`）不是规则。
        None => (raw, None),
    };
    if tool_pat.is_empty() {
        return None;
    }
    let tool = Glob::new(tool_pat).ok()?.compile_matcher();
    let arg = match arg_pat {
        // `Bash()` 空参数模式等同只匹配工具名？不 —— 那是坏规则，跳过。
        Some("") => return None,
        Some(p) => Some(Glob::new(p).ok()?.compile_matcher()),
        None => None,
    };
    Some(CompiledRule {
        tool,
        arg,
        raw: raw.to_string(),
    })
}

/// 取工具的「主参数」——规则 glob 匹配的对象。
///
/// 字段名照 Claude Code 的工具入参（`file_path` 是新版名字，`path` 是老名字，
/// 两个都试）。认不出来的工具退到**整入参的紧凑 JSON**：那样规则至少还有得写，
/// 而返回空串会让带参数模式的规则全部失效。
pub fn primary_arg(tool: &str, input: &Value) -> String {
    let field = match tool {
        "Bash" => "command",
        "Read" | "Write" | "Edit" | "NotebookEdit" => "file_path",
        "Glob" | "Grep" => "pattern",
        // WebFetch / Task / 其它：整体匹配，用户自己按 JSON 形状写规则。
        _ => return serde_json::to_string(input).unwrap_or_default(),
    };
    input
        .get(field)
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default()
}

/// 把一次**具体调用**变成一条只放行它自己的规则文本。
///
/// 用于对话页审批卡的「以后都放行这类」—— 用户不必去设置页手写 glob。
///
/// 两条性质都有测试钉住：
///
/// 1. 生成的规则**一定命中**这次调用。否则用户点了「以后都放行」，下次照样弹卡，
///    而他会以为规则坏了（或者更糟：以为已经放行了而没再看那条卡）。
/// 2. glob 元字符**全部转义成字面量**。`Bash(ls *.rs)` 里的 `*` 若不转义就是
///    通配符，而 globset 的 `*` 连空格都能跨过去 —— 那条规则会顺手放行
///    `ls *.rs && rm -rf /`。界面写着「以后都放行 ls *.rs」，实际放宽的是整类命令，
///    这是本模块最危险的失败方向。
///
/// 取不到主参数时返回 `None`：那时只剩「工具名全放行」一条路（`Bash` 不带括号），
/// 而那是很宽的授权，不替用户做这个决定。
pub fn suggest_rule(tool: &str, input: &Value) -> Option<String> {
    let primary = primary_arg(tool, input);
    if primary.trim().is_empty() {
        return None;
    }
    Some(format!("{}({})", escape_glob(tool), escape_glob(&primary)))
}

/// 把 glob 元字符包进字符类，让它们只匹配自己（`*` → `[*]`）。
///
/// `[` / `]` 也走同一条路（`[[]`、`[]]`）：bash 命令里带方括号是常态
/// （`grep -E '[0-9]+'`），不处理就等于「含方括号的命令不能加规则」。
/// 这两条写法是否被 globset 接受由测试钉住 —— 一旦它不支持，表现是规则
/// **不命中**（fail-closed，安全方向），而不是放宽。
fn escape_glob(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '*' | '?' | '[' | ']' | '{' | '}' | '\\' => {
                out.push('[');
                out.push(ch);
                out.push(']');
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(items: &[&str]) -> RuleSet {
        RuleSet::compile(&items.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    fn bash(cmd: &str) -> Value {
        json!({"command": cmd})
    }

    // ---- 规则解析 ----

    #[test]
    fn tool_only_rule_matches_any_input() {
        let rs = rules(&["Read"]);
        assert!(rs
            .match_rule("Read", &json!({"file_path": "/anywhere/x.rs"}))
            .is_some());
        // 只匹配工具名：别的工具不放行。
        assert!(rs.match_rule("Bash", &bash("ls")).is_none());
    }

    #[test]
    fn tool_and_arg_both_must_match() {
        let rs = rules(&["Bash(git status)"]);
        assert!(rs.match_rule("Bash", &bash("git status")).is_some());
        assert!(
            rs.match_rule("Bash", &bash("git push")).is_none(),
            "参数不匹配"
        );
        assert!(
            rs.match_rule("Read", &json!({"file_path": "git status"}))
                .is_none(),
            "工具不匹配"
        );
    }

    #[test]
    fn glob_star_crosses_slashes_by_default() {
        // globset 默认 `*` 跨 `/`：`Read(src/*)` 能匹配深层路径。
        // 这是有意为之——按「不跨」配置，用户写的 `Read(*)` 连一级子目录都进不去。
        let rs = rules(&["Read(src/*)"]);
        assert!(rs
            .match_rule("Read", &json!({"file_path": "src/a/b/c.rs"}))
            .is_some());
    }

    #[test]
    fn malformed_rules_never_match() {
        // 坏规则 = 永不匹配，绝不是「匹配一切」。
        let rs = rules(&["Bash(", "())", "(**)", "  ", "Bash()"]);
        assert!(rs.is_empty() || rs.match_rule("Bash", &bash("rm -rf /")).is_none());
        assert!(rs.match_rule("Bash", &bash("rm -rf /")).is_none());
    }

    #[test]
    fn empty_rule_list_matches_nothing() {
        let rs = RuleSet::compile(&[]);
        assert!(rs.is_empty());
        assert!(rs.match_rule("Bash", &bash("ls")).is_none());
    }

    #[test]
    fn glob_in_tool_name_works() {
        let rs = rules(&["Ba*h"]);
        assert!(rs.match_rule("Bash", &bash("ls")).is_some());
        assert!(rs.match_rule("Read", &json!({"file_path": "x"})).is_none());
    }

    // ---- 主参数提取 ----

    #[test]
    fn primary_arg_uses_tool_specific_field() {
        assert_eq!(primary_arg("Bash", &bash("ls -la")), "ls -la");
        assert_eq!(
            primary_arg("Read", &json!({"file_path": "/a/b.rs"})),
            "/a/b.rs"
        );
        assert_eq!(
            primary_arg("Edit", &json!({"path": "/old/name.rs"})),
            "/old/name.rs",
            "老字段名 path 也要认"
        );
        assert_eq!(primary_arg("Grep", &json!({"pattern": "TODO"})), "TODO");
    }

    #[test]
    fn unknown_tool_falls_back_to_whole_input_json() {
        let input = json!({"url": "https://x.com", "depth": 2});
        let got = primary_arg("WebFetch", &input);
        assert!(got.contains("https://x.com"), "{got}");
        // 紧凑 JSON：不能有换行（glob 模式里写换行没有意义）。
        assert!(!got.contains('\n'), "{got}");
    }

    /// 取不到主参数时，带参数模式的规则**不能**放行 ——
    /// 看不见要批什么就不能批（例如 `Bash(git *)` 遇到一个没有 command 的入参）。
    #[test]
    fn missing_primary_arg_blocks_param_rules() {
        let rs = rules(&["Bash(git *)"]);
        assert!(rs.match_rule("Bash", &json!({"cwd": "/tmp"})).is_none());
        // 但只匹配工具名的规则不受影响（它本来就不看参数）。
        let rs2 = rules(&["Bash"]);
        assert!(rs2.match_rule("Bash", &json!({"cwd": "/tmp"})).is_some());
    }

    // ---- 真家伙：规则会不会放过危险命令 ----

    #[test]
    fn narrow_rule_does_not_leak_to_other_commands() {
        let rs = rules(&["Bash(git status)", "Bash(git diff *)"]);
        assert!(rs.match_rule("Bash", &bash("git status")).is_some());
        assert!(rs.match_rule("Bash", &bash("git diff HEAD~1")).is_some());
        // 🔴 宽 glob 的固有语义：`git diff *` 的 `*` 跨任意字符，所以
        // `git diff x && rm -rf /` 也命中。这是**用户自己写宽**的结果，
        // 设置页说明文案必须讲明这一点；这里的测试把它固定成事实而非意外。
        assert!(rs
            .match_rule("Bash", &bash("git diff x && rm -rf /"))
            .is_some());
        assert!(
            rs.match_rule("Bash", &bash("rm -rf /")).is_none(),
            "没写到的命令不许过"
        );
        assert!(rs.match_rule("Bash", &bash("sudo rm -rf /")).is_none());
    }

    #[test]
    fn rules_apply_to_write_tools_via_file_path() {
        let rs = rules(&["Edit(src/**)", "Write(docs/*)"]);
        assert!(rs
            .match_rule("Edit", &json!({"file_path": "src/a/b.rs"}))
            .is_some());
        assert!(rs
            .match_rule("Write", &json!({"file_path": "docs/readme.md"}))
            .is_some());
        assert!(rs
            .match_rule("Edit", &json!({"file_path": "secrets/env"}))
            .is_none());
        assert!(rs
            .match_rule("Write", &json!({"file_path": "/etc/passwd"}))
            .is_none());
    }

    #[test]
    fn first_matching_rule_wins_and_reports_raw() {
        let rs = rules(&["Bash(never *)", "Bash(*)"]);
        assert_eq!(rs.match_rule("Bash", &bash("anything")), Some("Bash(*)"));
        // 第一条不命中时报第二条的原文。
        assert_eq!(
            rs.match_rule("Bash", &bash("never mind")),
            Some("Bash(never *)")
        );
    }

    // ---- 从一次调用生成规则（审批卡的「以后都放行这类」）----

    /// 生成的规则必须命中它自己 —— 否则用户点了按钮却没生效，下次照样弹卡。
    #[test]
    fn suggest_rule_matches_its_own_call() {
        let input = bash("git status");
        let rule = suggest_rule("Bash", &input).expect("有主参数");
        let rs = rules(&[rule.as_str()]);
        assert!(
            rs.match_rule("Bash", &input).is_some(),
            "必须命中自己：{rule}"
        );
        assert!(rs.match_rule("Bash", &bash("git push")).is_none());
    }

    /// 🔴 最关键的一条：`*` 若不转义就是通配符，而 globset 的 `*` 连空格都跨得过去。
    /// 那样「以后都放行 `ls *.rs`」实际会放行 `ls *.rs && rm -rf /`。
    #[test]
    fn suggest_rule_escapes_star() {
        let input = bash("ls *.rs");
        let rule = suggest_rule("Bash", &input).expect("有主参数");
        let rs = rules(&[rule.as_str()]);
        assert!(
            rs.match_rule("Bash", &input).is_some(),
            "必须命中自己：{rule}"
        );
        assert!(
            rs.match_rule("Bash", &bash("ls a.rs")).is_none(),
            "星号被当成通配符了：{rule}"
        );
        assert!(
            rs.match_rule("Bash", &bash("ls *.rs && rm -rf /"))
                .is_none(),
            "星号跨过了空格：{rule}"
        );
    }

    /// bash 命令里带方括号是常态（`grep -E '[0-9]+'`），转义必须真的可用。
    #[test]
    fn suggest_rule_escapes_brackets() {
        let input = bash("grep -E '[0-9]+' a.txt");
        let rule = suggest_rule("Bash", &input).expect("有主参数");
        let rs = rules(&[rule.as_str()]);
        assert!(
            rs.match_rule("Bash", &input).is_some(),
            "必须命中自己：{rule}"
        );
        assert!(
            rs.match_rule("Bash", &bash("grep -E 5 a.txt")).is_none(),
            "字符类被当成模式了：{rule}"
        );
    }

    /// 取不到主参数时不给规则：那时只剩「`Bash` 全放行」，不替用户做这个决定。
    #[test]
    fn suggest_rule_gives_up_without_primary_arg() {
        assert!(suggest_rule("Bash", &json!({})).is_none());
        assert!(suggest_rule("Read", &json!({"path": ""})).is_none());
    }

    /// 认不出的工具退到整入参 JSON（`primary_arg` 的口径），规则照样能用。
    #[test]
    fn suggest_rule_works_for_unknown_tools() {
        let input = json!({"url": "https://example.com"});
        let rule = suggest_rule("WebFetch", &input).expect("整入参当主参数");
        let rs = rules(&[rule.as_str()]);
        assert!(
            rs.match_rule("WebFetch", &input).is_some(),
            "必须命中自己：{rule}"
        );
    }
}
