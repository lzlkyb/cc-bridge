//! 模型目录：从上游问「你有哪些模型」，而不是让用户手打。
//!
//! 「支持全部模型」的正解不是内置一张永远过时的名单，是**问上游**。绝大多数
//! Anthropic 兼容端点与 OpenAI 兼容端点都实现了模型列表（`GET {root}/v1/models`
//! 或 `{root}/models`），返回形状也基本一致（`{"data":[{"id":"..."}]}`）。
//!
//! 三条设计：
//!
//! - **不缓存到磁盘。** 模型列表变动不频繁，但它一旦变了，缓存就是错的；而这个
//!   请求只值几百毫秒，用户点「获取列表」时等得起。不落盘也就不用加 DB 字段、
//!   不用做迁移。
//! - **失败不是错误，是「请手填」。** 上游没实现这个端点、网关拦了、或者返回
//!   401，都只让下拉退化，不影响保存与转发。
//! - **不跟随重定向。** 与 `probe` / 转发同一条策略：`x-api-key` 不在 reqwest
//!   的敏感头清单里，跟一个 302 就会把这把上游密钥带到重定向目标。

use serde_json::Value;

use super::config::AuthStyle;
use super::profile::{self, Dialect};

/// 一次模型列表请求的超时。比 `probe` 短：用户点了按钮在等，久了就该放弃。
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 从 `base_url` 推出模型列表端点。
///
/// `base_url` 存的是**完整对话端点**（`.../v1/messages` 或 `.../chat/completions`），
/// 所以先去掉那一段再拼 `/v1/models`。
pub fn models_url(base_url: &str, dialect: Dialect) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return String::new();
    }
    match dialect {
        Dialect::Anthropic => {
            let root = base.strip_suffix("/v1/messages").unwrap_or(base);
            format!("{root}/v1/models")
        }
        Dialect::OpenAi => {
            let root = base.strip_suffix("/chat/completions").unwrap_or(base);
            // 已经带 /v1 的别叠第二层；Azure 那类不带 /v1 的由用户自己填全。
            if root.ends_with("/v1") {
                format!("{root}/models")
            } else {
                format!("{root}/v1/models")
            }
        }
    }
}

/// 解析模型列表。容忍三种形状：
/// `{"data":[{"id":"m"}]}`（Anthropic / OpenAI 通用）、`{"models":[{"id":"m"}]}`、
/// 以及裸字符串数组。
///
/// 输出排序去重，保证同一份响应每次得到同样的顺序——界面不该因为上游换个顺序
/// 就重新排一遍。
pub fn parse_models(text: &str) -> Result<Vec<String>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("上游返回的不是 JSON：{e}"))?;
    let array = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array())
        .ok_or_else(|| "上游返回的 JSON 里没有模型数组。".to_string())?;

    let mut out: Vec<String> = array
        .iter()
        .filter_map(|item| match item {
            Value::String(s) => Some(s.trim().to_string()),
            Value::Object(obj) => obj
                .get("id")
                .or_else(|| obj.get("name"))
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
        .collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// 问上游要模型列表。
///
/// 错误一律是可展示的字符串——界面把它放在按钮旁边，不弹窗。
pub async fn fetch(
    base_url: &str,
    api_key: &str,
    auth_style: AuthStyle,
    profile_id: &str,
) -> Result<Vec<String>, String> {
    let preset = profile::resolve(base_url, profile_id);
    // 用与保存时同一套归一化，避免「测列表用 A 地址、转发用 B 地址」。
    let endpoint = crate::relay::config::normalize_endpoint_with(
        base_url,
        preset.endpoint_hint,
        preset.dialect,
    );
    let url = models_url(&endpoint, preset.dialect);
    if url.is_empty() {
        return Err("上游地址还没填。".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let mut request = client.get(&url);
    request = match auth_style {
        AuthStyle::XApiKey => request.header("x-api-key", api_key),
        AuthStyle::Bearer => request.header("authorization", format!("Bearer {api_key}")),
    };
    // Anthropic 官方要求这个头；兼容端点大多忽略它，带着更安全。
    request = request.header("anthropic-version", "2023-06-01");

    let response = request
        .send()
        .await
        .map_err(|e| super::server::describe_send_error(&e, &url))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "上游返回 {}：{}",
            status.as_u16(),
            truncate(&text, 300)
        ));
    }
    let models = parse_models(&text)?;
    if models.is_empty() {
        return Err("上游返回了空的模型列表，请手动填写模型名。".into());
    }
    Ok(models)
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_url_strips_the_chat_endpoint() {
        assert_eq!(
            models_url(
                "https://api.deepseek.com/anthropic/v1/messages",
                Dialect::Anthropic
            ),
            "https://api.deepseek.com/anthropic/v1/models"
        );
        assert_eq!(
            models_url(
                "https://api.openai.com/v1/chat/completions",
                Dialect::OpenAi
            ),
            "https://api.openai.com/v1/models"
        );
        // 未归一化（只到域名）也能用
        assert_eq!(
            models_url("https://host/anthropic", Dialect::Anthropic),
            "https://host/anthropic/v1/models"
        );
        assert_eq!(models_url("", Dialect::Anthropic), "");
    }

    #[test]
    fn parse_models_accepts_both_shapes() {
        // Anthropic / OpenAI 通用形状
        let v = parse_models(r#"{"data":[{"id":"m-b"},{"id":"m-a"}]}"#).unwrap();
        assert_eq!(v, vec!["m-a", "m-b"], "排序去重，输出稳定");

        // 裸字符串数组
        let v = parse_models(r#"["x","y","x"]"#).unwrap();
        assert_eq!(v, vec!["x", "y"]);

        // 另一种键
        let v = parse_models(r#"{"models":[{"name":"n1"}]}"#).unwrap();
        assert_eq!(v, vec!["n1"]);
    }

    #[test]
    fn parse_models_rejects_junk() {
        assert!(parse_models("not json").unwrap_err().contains("JSON"));
        assert!(parse_models(r#"{"data":"oops"}"#).is_err());
        // 空数组是合法的空结果，不报错——由 fetch 决定怎么说
        assert!(parse_models(r#"{"data":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn parse_models_skips_entries_without_id() {
        let v = parse_models(r#"{"data":[{"id":"ok"},{"object":"x"},{"id":"   "}]}"#).unwrap();
        assert_eq!(v, vec!["ok"]);
    }
}
