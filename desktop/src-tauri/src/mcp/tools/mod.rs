pub mod analyze_file;
pub mod batch;
pub mod command_policy;
pub mod copy_files;
pub mod create_directory;
pub mod delete_files;
pub mod edit_files;
pub mod get_command_output;
pub mod list_allowed_roots;
pub mod list_directory;
pub mod mcp_list_servers;
pub mod mcp_proxy;
pub mod move_files;
pub mod notebook_edit;
#[cfg(feature = "notifications")]
pub mod push_notification;
pub mod read_files;
pub mod registry;
pub mod remove_directory;
pub mod run_command;
pub mod search_files;
pub mod shell;
pub mod stop_command;
pub mod write_files;

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
            props.contains(&"stopOnError".to_string()) && !props.contains(&"stop_on_error".to_string()),
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
