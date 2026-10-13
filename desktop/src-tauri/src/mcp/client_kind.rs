//! MCP 客户端识别：从 `initialize` 请求的 `params.clientInfo.name` 判定接入方类型。
//!
//! WHY：桥已面向「任意 MCP 客户端」（Claude Code / Codex / WorkBuddy / 通用），但
//! `initialize` 响应里的 `instructions` 会**下发给每一个接入的客户端**——若里面写死
//! 某一家的假设，别的客户端就会对本服务形成错误认知。识别只发生在 initialize 那一次
//! 响应里，**不引入跨请求状态**（HTTP transport 本就无状态，SSE 也不额外记）。
//!
//! 实测取值（2026-10-13 从客户端二进制提取，非猜测）：
//! - Claude Code → `claude-code`（另有 `Claude Code` 变体）
//! - WorkBuddy   → `workbuddy-acp-client`
//! - Codex       → `codex-mcp-client`（本机未安装，按子串规则同样命中；待真机复核）
//!
//! 因此匹配规则刻意宽松：小写化后按**子串**判定，落空一律归 [`ClientKind::Generic`]。

use serde_json::Value;

/// 接入方类型。用于按客户端下发不同的 `instructions`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
    ClaudeCode,
    Codex,
    WorkBuddy,
    /// 未识别（含未带 `clientInfo` 的裸客户端）——按中性措辞处理。
    Generic,
}

impl ClientKind {
    /// 从 `initialize` 请求体推断客户端类型。
    pub fn from_initialize(body: &Value) -> Self {
        let name = body
            .get("params")
            .and_then(|p| p.get("clientInfo"))
            .and_then(|c| c.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        Self::from_name(name)
    }

    /// 按 `clientInfo.name` 判定；大小写不敏感、子串匹配。
    pub fn from_name(name: &str) -> Self {
        let n = name.to_ascii_lowercase();
        if n.contains("claude") {
            ClientKind::ClaudeCode
        } else if n.contains("codex") {
            ClientKind::Codex
        } else if n.contains("workbuddy") || n.contains("work-buddy") || n.contains("work buddy") {
            ClientKind::WorkBuddy
        } else {
            ClientKind::Generic
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 三家实测取值 + 大小写变体，全部命中正确分类。
    #[test]
    fn matches_measured_client_names() {
        assert_eq!(ClientKind::from_name("claude-code"), ClientKind::ClaudeCode);
        // Claude Code 另有 "Claude Code"（空格 + 大写）变体
        assert_eq!(ClientKind::from_name("Claude Code"), ClientKind::ClaudeCode);
        assert_eq!(
            ClientKind::from_name("workbuddy-acp-client"),
            ClientKind::WorkBuddy
        );
        assert_eq!(ClientKind::from_name("codex-mcp-client"), ClientKind::Codex);
    }

    /// 未知 / 空 / 缺失 clientInfo → Generic（落空不 panic、不误判）。
    #[test]
    fn unknown_falls_back_to_generic() {
        assert_eq!(ClientKind::from_name(""), ClientKind::Generic);
        assert_eq!(ClientKind::from_name("cursor"), ClientKind::Generic);
        assert_eq!(
            ClientKind::from_name("Some Random Client"),
            ClientKind::Generic
        );

        let no_client_info = json!({ "params": { "protocolVersion": "2025-06-18" } });
        assert_eq!(
            ClientKind::from_initialize(&no_client_info),
            ClientKind::Generic
        );

        let body = json!({
            "params": { "clientInfo": { "name": "claude-code", "version": "2.0.0" } }
        });
        assert_eq!(ClientKind::from_initialize(&body), ClientKind::ClaudeCode);
    }
}
