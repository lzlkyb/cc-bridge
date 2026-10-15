//! MCP 工具参数入口的容错反序列化（审计日志 A 类错误治理）。
//!
//! 审计实锤（近 30 天 66 条工具级错误里约 12 条）：部分客户端把本应是**数组**的参数
//! 先 `JSON.stringify` 成字符串再发（read_files `paths`、edit_files `edits`、
//! write_files `files`）。serde 严格类型下直接 `invalid type: string` 拒掉，
//! 客户端看到的是「参数没传/类型不对」，比实际问题难自查得多。
//!
//! 治理原则与 `mcp_proxy::normalize_args` 一致：**能确定性还原的就接受**；
//! 解不出目标形状的照样报错，不拿猜测的空值充数。

use serde::{Deserialize, Deserializer};

/// 接受 `Vec<T>`（正规形态），或一段能解出 `Vec<T>` 的 JSON 字符串（客户端 stringify 形态）。
///
/// 用法：`#[serde(deserialize_with = "vec_from_json_or_string")] pub files: Vec<T>`。
/// 仅在字段级生效；schema 仍按正规数组 advertise（ToolSchema 不受影响）。
/// 注意 `T` 必须是 `DeserializeOwned`：内部经 `serde_json::from_value`（owned Value，
/// 无借用生命周期），`Deserialize<'de>` 借用型 bound 会报 not general enough。
pub fn vec_from_json_or_string<'de, T, D>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    T: serde::de::DeserializeOwned,
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let array = match value {
        arr @ serde_json::Value::Array(_) => arr,
        serde_json::Value::String(s) => {
            let parsed: serde_json::Value = serde_json::from_str(s.trim())
                .map_err(|e| serde::de::Error::custom(format!("参数是字符串但解不出 JSON：{e}")))?;
            parsed
        }
        _ => {
            return Err(serde::de::Error::custom(
                "期望数组（或 JSON 字符串化的数组），不要传其他类型",
            ))
        }
    };
    serde_json::from_value(array).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Item {
        path: String,
    }

    #[derive(Debug, Deserialize)]
    struct Args {
        #[serde(deserialize_with = "vec_from_json_or_string")]
        files: Vec<Item>,
    }

    #[test]
    fn accepts_plain_array() {
        let a: Args =
            serde_json::from_value(json!({ "files": [{ "path": "a.rs" }, { "path": "b.rs" }] }))
                .expect("正规数组应直接通过");
        assert_eq!(a.files.len(), 2);
        assert_eq!(a.files[1].path, "b.rs");
    }

    #[test]
    fn accepts_stringified_array() {
        let a: Args = serde_json::from_value(json!({
            "files": "[{\"path\": \"a.rs\"}, {\"path\": \"b.rs\"}]"
        }))
        .expect("字符串化数组应被解析接受");
        assert_eq!(a.files.len(), 2);
        assert_eq!(a.files[0].path, "a.rs");
    }

    #[test]
    fn rejects_non_json_string() {
        let r: Result<Args, _> = serde_json::from_value(json!({ "files": "不是 JSON" }));
        assert!(r.is_err(), "解不出 JSON 的字符串必须报错，不得静默");
    }

    #[test]
    fn rejects_wrong_inner_shape() {
        // 字符串能解出 JSON 但不是目标形状（对象数组 vs 数字数组）→ 报错。
        let r: Result<Args, _> = serde_json::from_value(json!({ "files": "[1,2,3]" }));
        assert!(r.is_err(), "内层形状不符必须报错");
    }

    #[test]
    fn rejects_other_types() {
        let r: Result<Args, _> = serde_json::from_value(json!({ "files": 42 }));
        assert!(r.is_err());
    }
}
