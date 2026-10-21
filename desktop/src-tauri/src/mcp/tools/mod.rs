use serde_json::{json, Value};

pub mod analyze_file;
pub mod batch;
pub mod command_policy;
pub mod copy_files;
pub mod create_directory;
pub mod delete_files;
pub mod edit_files;
pub mod flex_args;
pub mod get_command_output;
pub mod list_allowed_roots;
pub mod list_directory;
pub mod mcp_list_servers;
pub mod mcp_proxy;
pub mod move_files;
pub mod notebook_edit;
pub mod output_filter;
pub mod prepare_download;
pub mod prepare_upload;
#[cfg(feature = "notifications")]
pub mod push_notification;
pub mod read_files;
pub mod registry;
pub mod remove_directory;
pub mod run_command;
pub mod search_files;
pub mod shell;
pub mod stop_command;
pub mod view_image;
pub mod wait_command;
pub mod write_files;

/// 按 MCP `tools/call` 规范把结果包成 `content` 数组（`content[0].text` 是一段 JSON 文本）。
///
/// 🔴 裸返回对象会被客户端判为格式错误，所以**每个**工具的结果都必须走这里。
/// 以前这段壳散在 3 个私有同名函数 + 18 处内联里，改一次 envelope 形状要改 21 处。
///
/// `text_result` = pretty 缩进（人读友好：日志与手工调试能看清结构）；
/// `text_result_compact` = 紧凑（结构化输出的工具用，见 `read_files`／`batch`）。
///
/// 泛型收 `&impl Serialize`：既接受 `json!(...)` 临时值，也接受 `Vec<Value>` 之类的容器，
/// 调用方不必为了迎合签名先把它包成 `Value`。
pub(crate) fn text_result(value: &impl serde::Serialize) -> Value {
    json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(value).unwrap() }] })
}

pub(crate) fn text_result_compact(value: &impl serde::Serialize) -> Value {
    json!({ "content": [{ "type": "text", "text": serde_json::to_string(value).unwrap() }] })
}

/// 估算「这次结果给下一轮上下文添了多少字符」——**只数 text 块**。
///
/// 🔴 不能拿 `to_vec(&content).len()`：`view_image` 之类返回 image 内容块的工具，块里是
/// 一整段 base64，按字节记会让审计里的 estTokens 虚高两个数量级（一张 200KB 的图 ≈ 27 万
/// 「token」，实际客户端按像素计费、只有一千上下），Token 用量页会直接失去参考价值。
/// 图片块按 0 计：它与字符数无关，估不准就别估，好过给个错得离谱的数。
pub(crate) fn result_text_bytes(result: &Value) -> u64 {
    match result.get("content").and_then(|c| c.as_array()) {
        Some(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .map(|s| s.len() as u64)
            .sum(),
        // 没有 content 数组（异常形状）：回退到整体序列化长度，别把用量记成 0。
        None => serde_json::to_vec(result)
            .map(|v| v.len() as u64)
            .unwrap_or(0),
    }
}

/// `mcp/tools/*` 各 `mod tests` 共用的测试脚手架。
///
/// 2026-10-16 前 `unique_subdir` 与 `make_state` 各被抄了 7 份（只有 label 不同），
/// 改一次临时目录命名规则要改 14 处。
#[cfg(test)]
pub(crate) mod testutil {
    use crate::config::BridgeConfig;
    use crate::db;
    use crate::state::AppState;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// 全局自增，保证并发跑的测试拿到互不相同的目录名。
    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 唯一、可写的临时目录。
    ///
    /// 用 `std::env::temp_dir()` 而非 tempfile crate——cc-bridge 没有 dev-deps 段，
    /// 而测试只需要一棵「独立、唯一、可写」的目录树，stdlib 足够。
    pub(crate) fn unique_subdir(label: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cc-bridge-test-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir create");
        dir
    }

    /// 造 `AppState`：临时目录里建库，白名单根预置为该目录，再让 `f` 覆写其余配置。
    ///
    /// 返回 `(state, dir)`；`dir` 即白名单根，测试可往里写 fixture。
    pub(crate) fn make_state(f: impl FnOnce(&mut BridgeConfig)) -> (Arc<AppState>, PathBuf) {
        let dir = unique_subdir("state");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        let mut cfg = BridgeConfig {
            allowed_roots: vec![dir.to_string_lossy().into_owned()],
            ..BridgeConfig::default()
        };
        f(&mut cfg);
        (Arc::new(AppState::new(conn, cfg, dir.clone())), dir)
    }

    /// 造 `AppState`：`BridgeConfig::default()`（白名单为空），无自定义。
    pub(crate) fn make_state_default() -> Arc<AppState> {
        let dir = unique_subdir("default");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        Arc::new(AppState::new(conn, Default::default(), dir))
    }

    /// 造 `AppState`：白名单根替换为给定的 `roots`。
    pub(crate) fn make_state_with_roots(roots: Vec<PathBuf>) -> Arc<AppState> {
        let dir = unique_subdir("roots");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        let cfg = BridgeConfig {
            allowed_roots: roots
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            ..BridgeConfig::default()
        };
        Arc::new(AppState::new(conn, cfg, dir))
    }
}

#[cfg(test)]
mod result_bytes_tests {
    //! `result_text_bytes` 的口径：只数 text 块。
    //!
    //! 这条之所以要测，是因为它的错误方向很隐蔽——把 image 块里的 base64 也算进去不会报错，
    //! 只会让审计的 estTokens 在用了 `view_image` 的会话里虚高两个数量级，
    //! 看起来「正常」但数字全是错的。

    use super::*;

    #[test]
    fn counts_only_text_blocks() {
        let r = json!({
            "content": [
                { "type": "image", "data": "A".repeat(10_000), "mimeType": "image/png" },
                { "type": "text", "text": "abc" },
            ]
        });
        assert_eq!(result_text_bytes(&r), 3, "图片块的 base64 不该被计入");
    }

    #[test]
    fn sums_multiple_text_blocks() {
        let r = json!({ "content": [{ "type": "text", "text": "ab" }, { "type": "text", "text": "cde" }] });
        assert_eq!(result_text_bytes(&r), 5);
    }

    #[test]
    fn falls_back_to_serialized_len_without_content_array() {
        let r = json!({ "ok": true });
        assert_eq!(
            result_text_bytes(&r),
            serde_json::to_vec(&r).unwrap().len() as u64,
            "异常形状要回退到整体长度，不能记成 0"
        );
    }
}

#[cfg(test)]
mod schema_tests {
    //! 锁住 `#[derive(ToolSchema)]` 对 `#[serde(...)]` 属性的解析。
    //!
    //! 为何需要这组测试：2026-08-03 发现 derive 里 `parse_nested_meta` 的回调没有
    //! 把非目标项的 `= value` 消费掉，导致属性里**后续项全部读不到**。后果是
    //! 静默的：`timeoutMs` / `maxOutputBytes` / `stopOnError` 在 schema 里掉回 snake_case，
    //! 而 serde 只认 camelCase → 调用方按 schema 传参被静默忽略、永远用默认值
    //! （实际踩到过：传 `timeout_ms: 180000` 仍按默认超时结束）；
    //! 而 `maxResults` 反方向丢了 `default`，被误标成必填。
    //!
    //! 这类 bug 不会报错、不会失败构建，只能用断言 schema 形状来卡住。

    use super::{batch::BatchArgs, run_command::RunCommandArgs, search_files::SearchFilesArgs};

    fn prop_names(schema: &serde_json::Value) -> Vec<String> {
        schema["properties"]
            .as_object()
            .expect("schema 应有 properties")
            .keys()
            .cloned()
            .collect()
    }

    fn required(schema: &serde_json::Value) -> Vec<String> {
        schema["required"]
            .as_array()
            .expect("schema 应有 required")
            .iter()
            .map(|v| v.as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// `#[serde(default = "fn", rename = "x")]`：rename 写在 default 之后，以前会丢。
    #[test]
    fn rename_survives_when_written_after_default() {
        let props = prop_names(&RunCommandArgs::schema());
        for name in ["timeoutMs", "maxOutputBytes"] {
            assert!(
                props.contains(&name.to_string()),
                "{name} 丢了 rename，schema 会告诉调用方传 snake_case，而 serde 只认 camelCase，
                 参数会被静默忽略。当前 properties = {props:?}"
            );
        }
        for stale in ["timeout_ms", "max_output_bytes"] {
            assert!(
                !props.contains(&stale.to_string()),
                "{stale} 不应再出现（说明 rename 未生效）"
            );
        }

        let props = prop_names(&BatchArgs::schema());
        assert!(
            props.contains(&"stopOnError".to_string())
                && !props.contains(&"stop_on_error".to_string()),
            "batch 的 stopOnError 同样是 rename-在-default-之后，properties = {props:?}"
        );
    }

    /// `#[serde(rename = "x", default = "fn")]`：default 写在 rename 之后，以前会丢
    /// → 带默认值的字段被误标成 required。
    #[test]
    fn default_survives_when_written_after_rename() {
        let schema = SearchFilesArgs::schema();
        let req = required(&schema);
        assert!(
            !req.contains(&"maxResults".to_string()),
            "maxResults 有 `default = \"default_max_results\"`，不应是必填。required = {req:?}"
        );
        // rename 本身也要仍然正确。
        assert!(prop_names(&schema).contains(&"maxResults".to_string()));
    }
}
