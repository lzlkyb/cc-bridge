//! MCP 客户端识别：从请求体里的 `clientInfo.name` 判定接入方类型。
//!
//! 两代协议的取位置不同（见 [`ClientKind::from_request`]）：
//! - legacy：`initialize` 的 `params.clientInfo.name`
//! - 现代（`2026-07-28` 起）：per-request 的 `params._meta["io.modelcontextprotocol/clientInfo"].name`
//!
//! WHY：桥已面向「任意 MCP 客户端」（Claude Code / Codex / WorkBuddy / 通用），但
//! `initialize` / `server/discover` 响应里的 `instructions` 会**下发给接入的客户端**——
//! 若里面写死某一家的假设，别的客户端就会对本服务形成错误认知。识别只发生在响应里，
//! **不引入跨请求状态**（HTTP transport 本就无状态，SSE 也不额外记）。
//!
//! 实测取值（2026-10-13 从客户端二进制提取，非猜测）：
//! - Claude Code → `claude-code`（另有 `Claude Code` 变体）
//! - WorkBuddy   → `workbuddy-acp-client`
//! - Codex       → `codex-mcp-client`（本机未安装，按子串规则同样命中；待真机复核）
//!
//! 因此匹配规则刻意宽松：小写化后按**子串**判定，落空一律归 [`ClientKind::Generic`]。

use serde_json::Value;

/// `_meta` 里的 `clientInfo` 键（规范固定字符串，勿改）。
const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";

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
    /// 从请求体推断客户端类型，**两代协议都认**：
    /// - 现代（`2026-07-28` 起）：`params._meta["io.modelcontextprotocol/clientInfo"].name`
    /// - legacy：`params.clientInfo.name`（`initialize` 的参数）
    ///
    /// 🔴 只看 `params.clientInfo` 的话，**每个现代客户端都会被判成 Generic**——
    /// 新协议移除了 `initialize` 握手，clientInfo 搬进了 per-request 的 `_meta`。
    /// 而本模块存在的全部意义就是「别让某一家客户端拿到错的 instructions」，
    /// 判成 Generic 等于对现代客户端整体失效。
    ///
    /// 取值用链式 `get` 而非 `pointer("/params/_meta/…")`：键里含 `.` 无所谓，
    /// 但 `io.modelcontextprotocol/clientInfo` 里的 **`/` 在 JSON Pointer 语法里是分隔符**，
    /// 得写成 `~1` 才行——那种转义写错了不会报错，只会静默解不出来。
    pub fn from_request(body: &Value) -> Self {
        let name = body
            .get("params")
            .and_then(|p| p.get("_meta"))
            .and_then(|m| m.get(META_CLIENT_INFO))
            .and_then(|c| c.get("name"))
            .and_then(|n| n.as_str())
            .or_else(|| {
                body.get("params")
                    .and_then(|p| p.get("clientInfo"))
                    .and_then(|c| c.get("name"))
                    .and_then(|n| n.as_str())
            })
            .unwrap_or("");
        Self::from_name(name)
    }

    /// 兼容旧名（`initialize` 路径）。内部就是 [`Self::from_request`]。
    pub fn from_initialize(body: &Value) -> Self {
        Self::from_request(body)
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

    /// 🔴 现代请求（`2026-07-28` 起）把 `clientInfo` 放在 `params._meta` 里。
    /// 只认 `params.clientInfo` 会把每一个现代客户端都判成 Generic。
    #[test]
    fn reads_modern_meta_client_info() {
        let modern = json!({
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": { "name": "claude-code", "version": "3.0.0" }
                }
            }
        });
        assert_eq!(ClientKind::from_request(&modern), ClientKind::ClaudeCode);

        let modern_wb = json!({
            "params": { "_meta": {
                "io.modelcontextprotocol/clientInfo": { "name": "workbuddy-acp-client" }
            } }
        });
        assert_eq!(ClientKind::from_request(&modern_wb), ClientKind::WorkBuddy);

        // `_meta` 里没有 clientInfo 时回退到 legacy 位置（dual-era 两种写法都能判）。
        let both = json!({
            "params": {
                "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
                "clientInfo": { "name": "codex-mcp-client" }
            }
        });
        assert_eq!(ClientKind::from_request(&both), ClientKind::Codex);

        // `_meta` 优先于 legacy 位置（两处都有且不同时，以现代位置为准）。
        let conflict = json!({
            "params": {
                "_meta": { "io.modelcontextprotocol/clientInfo": { "name": "codex-mcp-client" } },
                "clientInfo": { "name": "claude-code" }
            }
        });
        assert_eq!(ClientKind::from_request(&conflict), ClientKind::Codex);
    }
}
