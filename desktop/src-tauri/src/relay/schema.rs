//! 工具 schema 里 `pattern` 的转义归一化（转发前）。
//!
//! Claude Code 新版内置的 `Artifact` 工具，`input_schema` 里带
//! `"pattern": "^[^\\0]*$"`。`\0` 是 ECMAScript 的空字符转义，RE2 认；
//! 但 DeepSeek 一类的上游校验器不认，**整条请求** 400：
//!
//! ```text
//! 400 Invalid schema for function 'Artifact': "^[^\0]*$" is not a "regex"
//! ```
//!
//! 归一化是**语义等价**的——`\0` 与 `\x00` 在正则里都表示 NUL，约束强度一分不差。
//! 所以这条默认开启，不像 `clamp_max_tokens` 那样需要用户显式决定：那条会改变
//! 行为，这条不会。
//!
//! 只碰三处，其余字节不动（重新序列化时 key 顺序由 `preserve_order` 保住）：
//!
//! - `tools[*].input_schema` / `tools[*].parameters` / `tools[*].function.parameters`
//!   下的 `pattern` 值
//! - 同一位置的 `patternProperties` **键**（键本身是正则）
//!
//! 递归只走 [`SCHEMA_KEYS`] 这些 schema 关键字，不做「无脑遍历所有字符串」：
//! `enum` / `default` / `examples` 里的字符串也可能长得像正则，改它等于替用户
//! 编造约束。
//!
//! 参考实现（同一个坑，三家都踩过）：
//!
//! - `yetone/magpie` `internal/gateway/deepseek_schema.go`：`\0` → `\u0000`，
//!   按 `tools` 逐个找 `pattern` 后**就地拼接字节**，避免重编码破坏 prompt cache
//! - `dagonet/cc-proxy`：`\0` → `\x00`，连 `patternProperties` 的键一起改写，
//!   并明确「`\0` 后跟数字、`\\0` 一律不动」
//! - `MadAppGang/claudish` #341：`isPortablePattern()` 把 `\0` 当数字转义放行，
//!   于是同一份 schema 在 DeepSeek 侧 400

use serde_json::{Map, Value};

/// `\0` 的替换值。
///
/// 选 `\x00` 而不是 `\u0000`：两者都表示 NUL，但 `\x00` 是正则自己的十六进制
/// 转义，不依赖 JSON 层把 `\u0000` 还原成真正的 NUL 字符——那个字符会出现在
/// 日志与界面里，肉眼不可见，排查时反而更糊涂。
///
/// `magpie` 用 `\u0000`、`cc-proxy` 用 `\x00`，两边都在生产验证过。将来若真有
/// 上游只认前者，改这一行即可。
const NULL_ESCAPE: &str = "\\x00";

/// 值是「名字 → schema」映射的关键字：要把**每个 value** 当 schema 递归。
///
/// 这些键本身不是 schema 关键字——`properties` 的键是属性名、`$defs` 的键是定义名、
/// `patternProperties` 的键是正则。把它们当成 schema 直接递归，`properties` 下面的
/// 字段一个都扫不到（第一版就这么错的：Artifact 的 pattern 正在
/// `properties.file_paths` 下面）。
const SCHEMA_MAPS: [&str; 5] = [
    "properties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
];

/// 值本身是 schema 或 schema 数组的关键字。
const SCHEMA_KEYS: [&str; 14] = [
    "items",
    "prefixItems",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "allOf",
    "anyOf",
    "oneOf",
];

/// 就地归一化 `tools` 里所有 schema 的 `\0`。返回带路径的发现，空 = 没动过。
///
/// 调用方据此决定要不要重新序列化、日志里记什么。**幂等**：同一份 body 跑第二
/// 遍不会再有发现，也不会再改字节。
pub fn normalize_null_escapes(body: &mut Value) -> Vec<String> {
    let mut findings = Vec::new();
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return findings;
    };
    for (i, tool) in tools.iter_mut().enumerate() {
        // 带上工具名：日志里 `tools[0]` 与 `tools[0](Artifact)` 的排查效率差很多。
        let at = match tool.get("name").and_then(Value::as_str) {
            Some(name) => format!("tools[{i}]({name})"),
            None => format!("tools[{i}]"),
        };
        for key in ["input_schema", "parameters"] {
            if let Some(schema) = tool.get_mut(key) {
                walk(schema, &format!("{at}.{key}"), &mut findings);
            }
        }
        // OpenAI 形态：`{"type":"function","function":{"parameters":…}}`。
        if let Some(params) = tool
            .get_mut("function")
            .and_then(|f| f.get_mut("parameters"))
        {
            walk(params, &format!("{at}.function.parameters"), &mut findings);
        }
    }
    findings
}

fn walk(node: &mut Value, path: &str, findings: &mut Vec<String>) {
    match node {
        // `allOf` / `prefixItems` 这类是数组，元素还是 schema。
        Value::Array(items) => {
            for (i, item) in items.iter_mut().enumerate() {
                walk(item, &format!("{path}[{i}]"), findings);
            }
        }
        Value::Object(obj) => {
            // 先取成 owned 再插入：`get` 的借用若还活着，`insert` 拿不到可变借用。
            let fixed = obj.get("pattern").and_then(Value::as_str).and_then(rewrite);
            if let Some(fixed) = fixed {
                obj.insert("pattern".into(), Value::String(fixed));
                findings.push(format!("{path}.pattern：\\0 → \\x00"));
            }
            if let Some(Value::Object(props)) = obj.get_mut("patternProperties") {
                rename_keys(props, path, findings);
            }
            // 先走「名字 → schema」的映射：`properties` 里每个属性都要单独进去。
            for key in SCHEMA_MAPS {
                if let Some(Value::Object(inner)) = obj.get_mut(key) {
                    for (name, child) in inner.iter_mut() {
                        walk(child, &format!("{path}.{key}.{name}"), findings);
                    }
                }
            }
            for key in SCHEMA_KEYS {
                if let Some(child) = obj.get_mut(key) {
                    walk(child, &format!("{path}.{key}"), findings);
                }
            }
        }
        // `enum` / `default` / `examples` 里的字符串一律不碰。
        _ => {}
    }
}

/// 改写 `patternProperties` 的键。键就是正则，和后端校验的是同一个东西。
fn rename_keys(props: &mut Map<String, Value>, path: &str, findings: &mut Vec<String>) {
    let mut mapping: Vec<(String, String)> = Vec::new();
    for key in props.keys() {
        if let Some(fixed) = rewrite(key) {
            // 改名后撞上已有键就放弃：宁可让上游照原样报错（错误信息里能看到原文），
            // 也不能覆盖掉另一个 pattern 的 schema。
            let clash = props.contains_key(&fixed) || mapping.iter().any(|(_, new)| new == &fixed);
            if !clash {
                mapping.push((key.clone(), fixed));
            }
        }
    }
    if mapping.is_empty() {
        return;
    }
    let mut rebuilt = Map::new();
    for (key, value) in std::mem::take(props) {
        let target = mapping
            .iter()
            .find(|(old, _)| old == &key)
            .map_or(key, |(_, new)| new.clone());
        rebuilt.insert(target, value);
    }
    *props = rebuilt;
    for (_, new) in &mapping {
        findings.push(format!("{path}.patternProperties 键 {new}：\\0 → \\x00"));
    }
}

/// 把 `\0` 换成 `\x00`；没有可换的返回 `None`（调用方据此判断「逐字节不变」）。
///
/// 两个不碰的边界，两边参考实现都是这么定的：
///
/// - `\\0`（转义反斜杠 + `0`）是字面反斜杠，不是 NUL
/// - `\012` 是八进制转义（换行），不是 NUL
///
/// 用 `chars` 而不是字节下标：pattern 里可能有中文，按字节切片会落到字符中间。
fn rewrite(pattern: &str) -> Option<String> {
    let mut out = String::with_capacity(pattern.len());
    let mut changed = false;
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // 后面还跟数字 = 八进制，不是 NUL。
            Some('0') if !chars.peek().is_some_and(|next| next.is_ascii_digit()) => {
                out.push_str(NULL_ESCAPE);
                changed = true;
            }
            // `\\` 落到这里：两个反斜杠原样保留，后面的 `0` 是普通字符。
            Some(next) => {
                out.push('\\');
                out.push(next);
            }
            // 结尾孤零零一个 `\`：非法正则，但不是我们要修的东西。
            None => out.push('\\'),
        }
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 真实形态：Artifact 的 `file_paths` 是数组，pattern 在 `items` 里。
    fn artifact_body() -> Value {
        json!({
            "model": "deepseek-v4.1-flash",
            "messages": [],
            "tools": [
                {
                    "name": "Artifact",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "file_paths": {
                                "type": "array",
                                "items": { "type": "string", "pattern": "^[^\\0]*$" }
                            }
                        }
                    }
                },
                {
                    "name": "Read",
                    "input_schema": {
                        "type": "object",
                        "properties": { "path": { "type": "string" } }
                    }
                }
            ]
        })
    }

    #[test]
    fn artifact_pattern_is_normalized_in_place() {
        let mut body = artifact_body();
        let notes = normalize_null_escapes(&mut body);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(
            notes[0]
                .contains("tools[0](Artifact).input_schema.properties.file_paths.items.pattern"),
            "路径要能定位到具体工具与字段：{}",
            notes[0]
        );
        assert_eq!(
            body["tools"][0]["input_schema"]["properties"]["file_paths"]["items"]["pattern"],
            "^[^\\x00]*$"
        );
        // 没问题的工具一个字符都不动
        assert_eq!(
            body["tools"][1]["input_schema"]["properties"]["path"]["type"],
            "string"
        );
    }

    #[test]
    fn escaped_backslash_and_octal_are_left_alone() {
        // `\\0` = 字面反斜杠 + '0'
        assert_eq!(rewrite("^\\\\0$"), None);
        // `\012` = 八进制换行
        assert_eq!(rewrite("^\\012$"), None);
        // `\0` 后面紧跟数字，哪怕不是合法八进制也不动
        assert_eq!(rewrite("^\\09$"), None);
    }

    #[test]
    fn real_null_escape_is_rewritten() {
        assert_eq!(rewrite("^[^\\0]*$").as_deref(), Some("^[^\\x00]*$"));
        // 一个 pattern 里出现两次
        assert_eq!(rewrite("\\0|\\0").as_deref(), Some("\\x00|\\x00"));
    }

    #[test]
    fn non_tool_strings_are_not_touched() {
        let mut body = json!({
            "messages": [{ "role": "user", "content": "pattern ^[^\\0]*$ 只是用户正文" }],
            "tools": [{
                "name": "T",
                "input_schema": {
                    "type": "object",
                    // enum / default 不是约束正则，改它就是编造语义
                    "properties": { "s": { "type": "string", "enum": ["^[^\\0]*$"] } },
                    "default": "^[^\\0]*$"
                }
            }]
        });
        let before = body.clone();
        assert!(normalize_null_escapes(&mut body).is_empty());
        assert_eq!(body, before, "非 schema 位置必须逐字节不变");
    }

    #[test]
    fn missing_tools_is_a_noop() {
        let mut body = json!({ "model": "m", "messages": [] });
        assert!(normalize_null_escapes(&mut body).is_empty());
        // tools 不是数组也不能 panic
        let mut body = json!({ "tools": "oops" });
        assert!(normalize_null_escapes(&mut body).is_empty());
    }

    #[test]
    fn openai_function_shape_is_covered() {
        let mut body = json!({
            "tools": [{
                "type": "function",
                "function": {
                    "name": "write",
                    "parameters": {
                        "type": "object",
                        "properties": { "p": { "type": "string", "pattern": "^[^\\0]*$" } }
                    }
                }
            }]
        });
        let notes = normalize_null_escapes(&mut body);
        assert_eq!(notes.len(), 1);
        assert_eq!(
            body["tools"][0]["function"]["parameters"]["properties"]["p"]["pattern"],
            "^[^\\x00]*$"
        );
    }

    #[test]
    fn pattern_properties_keys_are_rewritten() {
        let mut body = json!({
            "tools": [{
                "name": "T",
                "input_schema": {
                    "type": "object",
                    "patternProperties": { "^[^\\0]*$": { "type": "string" } }
                }
            }]
        });
        let notes = normalize_null_escapes(&mut body);
        assert_eq!(notes.len(), 1);
        let props = body["tools"][0]["input_schema"]["patternProperties"]
            .as_object()
            .expect("仍是对象");
        assert!(props.contains_key("^[^\\x00]*$"), "{props:?}");
        assert!(!props.contains_key("^[^\\0]*$"));
        // 键改了，值不能丢
        assert_eq!(props["^[^\\x00]*$"]["type"], "string");
    }

    #[test]
    fn conflicting_key_rename_is_dropped() {
        // 改名后会撞上已有的同名键 → 放弃改名，两个 schema 都要留着。
        let mut body = json!({
            "tools": [{
                "name": "T",
                "input_schema": {
                    "type": "object",
                    "patternProperties": {
                        "^[^\\0]*$": { "type": "string" },
                        "^[^\\x00]*$": { "type": "integer" }
                    }
                }
            }]
        });
        let notes = normalize_null_escapes(&mut body);
        assert!(notes.is_empty(), "有冲突就不该动");
        let props = body["tools"][0]["input_schema"]["patternProperties"]
            .as_object()
            .unwrap();
        assert_eq!(props.len(), 2);
        assert_eq!(props["^[^\\x00]*$"]["type"], "integer");
    }

    #[test]
    fn second_pass_is_a_noop() {
        let mut body = artifact_body();
        assert_eq!(normalize_null_escapes(&mut body).len(), 1);
        assert!(
            normalize_null_escapes(&mut body).is_empty(),
            "幂等：第二次不能再报发现，否则日志会重复记"
        );
    }

    #[test]
    fn multi_byte_pattern_is_intact() {
        let mut body = json!({
            "tools": [{ "name": "T", "input_schema": { "type": "object",
                "properties": { "s": { "type": "string", "pattern": "^[^中文\\0]*$" } } } }]
        });
        normalize_null_escapes(&mut body);
        assert_eq!(
            body["tools"][0]["input_schema"]["properties"]["s"]["pattern"],
            "^[^中文\\x00]*$"
        );
    }
}
