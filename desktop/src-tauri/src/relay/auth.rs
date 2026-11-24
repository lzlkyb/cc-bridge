//! 入站鉴权：`Authorization: Bearer` 与 `x-api-key` **两种都认**。
//!
//! §4.10 第 11 条：Claude Code 配 `ANTHROPIC_AUTH_TOKEN` 时发前者、配
//! `ANTHROPIC_API_KEY` 时发后者。只认一种会让照着别人教程配的用户收到 401，
//! 而 401 与「token 填错」在表面上完全一样，排查会绕远路。
//!
//! 比较用常量时间（`subtle`），失败原因分「没带」与「不对」两种——
//! 前者是配置问题，后者是被试错，界面提示与封禁策略要能区分。

use axum::http::HeaderMap;
use subtle::ConstantTimeEq;

/// 鉴权结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthOutcome {
    Ok,
    /// 没带任何凭据。通常是客户端环境变量没配。
    Missing,
    /// 带了但不对。
    Mismatch,
}

impl AuthOutcome {
    pub fn is_ok(self) -> bool {
        matches!(self, AuthOutcome::Ok)
    }

    /// 给用户的说明。**不能回显期望值**，也不能回显收到的值。
    pub fn message(self) -> &'static str {
        match self {
            AuthOutcome::Ok => "",
            AuthOutcome::Missing => {
                "请求没有带凭据。远端配置文件里要有 ANTHROPIC_AUTH_TOKEN（或 ANTHROPIC_API_KEY），\
                 值等于「中转」页里的访问令牌。"
            }
            AuthOutcome::Mismatch => {
                "访问令牌不匹配。请重新复制「中转」页里的令牌——它可能在本机重新生成过。"
            }
        }
    }
}

/// 从请求头里取令牌。两种头都认，先 Bearer 再 x-api-key。
pub fn provided_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let trimmed = value.trim();
        if let Some(rest) = trimmed
            .strip_prefix("Bearer ")
            .or_else(|| trimmed.strip_prefix("bearer "))
        {
            let token = rest.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 校验。`expected` 是配置里的中转 token（`rly_` 前缀）。
///
/// 期望值为空时**一律拒绝**：内网直连模式下 token 必须非空（§4.10 第 1 条），
/// 空值放行等于公开额度。这条不该依赖"UI 没给清空入口"这种间接保证。
pub fn verify(expected: &str, headers: &HeaderMap) -> AuthOutcome {
    if expected.trim().is_empty() {
        return AuthOutcome::Mismatch;
    }
    let Some(provided) = provided_token(headers) else {
        return AuthOutcome::Missing;
    };
    // 常量时间比较：长度不同会先在 ConstantTimeEq 内部短路，这不算泄露——
    // token 长度固定（rly_ + 32 hex），长度本身不携带秘密。
    if provided.as_bytes().ct_eq(expected.as_bytes()).into() {
        AuthOutcome::Ok
    } else {
        AuthOutcome::Mismatch
    }
}

/// 生成一枚新 token：`rly_` + 32 位十六进制。
///
/// 前缀让它在日志/截图里一眼能认出是「中转令牌」而不是 MCP token——
/// 两者是分开的（§4.10 第 2 条），混用会导致一串两用。
pub fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let hex: String = (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect();
    format!("rly_{hex}")
}

/// 掩码显示，如 `rly_7f3a…c91d`。日志与界面只出现这个形态（§4.10 第 5 条）。
///
/// 🔴 **必须按 char 切，不能按字节切**：`&t[..8]` 在字符串中间落在多字节字符上时
/// 直接 panic（`byte index N is not a char boundary`）。上游密钥是用户自由输入，
/// 一个中文/emoji 密钥就能触发，而 `relay_status` 每 2 秒轮询一次——必崩。
/// 同目录 `mod.rs` 的 `truncate` 早就做了 char 边界回退，这里补齐同一条防线。
pub fn mask(token: &str) -> String {
    let t = token.trim();
    let count = t.chars().count();
    if count <= 12 {
        return "…".into();
    }
    let head: String = t.chars().take(8).collect();
    let tail: String = t.chars().skip(count - 4).collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn bearer_and_api_key_are_both_accepted() {
        let h = headers(&[("authorization", "Bearer rly_abc")]);
        assert_eq!(verify("rly_abc", &h), AuthOutcome::Ok);

        let h = headers(&[("x-api-key", "rly_abc")]);
        assert_eq!(verify("rly_abc", &h), AuthOutcome::Ok);
    }

    #[test]
    fn missing_and_mismatch_are_distinguished() {
        assert_eq!(
            verify("rly_abc", &headers(&[("content-type", "application/json")])),
            AuthOutcome::Missing
        );
        assert_eq!(
            verify("rly_abc", &headers(&[("x-api-key", "rly_wrong")])),
            AuthOutcome::Mismatch
        );
        // 两种提示必须不同：一个是配置问题，一个是被试错
        assert_ne!(
            AuthOutcome::Missing.message(),
            AuthOutcome::Mismatch.message()
        );
    }

    #[test]
    fn empty_expected_token_rejects_everything() {
        // 空 token 放行等于公开额度，必须一律拒。
        let h = headers(&[("x-api-key", "")]);
        assert_eq!(verify("", &h), AuthOutcome::Mismatch);
        let h = headers(&[("x-api-key", "anything")]);
        assert_eq!(verify("", &h), AuthOutcome::Mismatch);
    }

    #[test]
    fn malformed_authorization_falls_back_to_api_key() {
        // 有的客户端写成 `Bearer` + 无空格或 `Basic`；此时仍应认 x-api-key。
        let h = headers(&[("authorization", "Basic xyz"), ("x-api-key", "rly_abc")]);
        assert_eq!(verify("rly_abc", &h), AuthOutcome::Ok);
    }

    #[test]
    fn generated_token_has_prefix_and_fixed_length() {
        let t = generate_token();
        assert!(t.starts_with("rly_"));
        assert_eq!(t.len(), 4 + 32);
        assert_ne!(t, generate_token(), "两次生成必须不同");
    }

    #[test]
    fn mask_never_reveals_middle() {
        let token = "rly_7f3a000000000000000000000000c91d";
        let masked = mask(token);
        assert!(masked.starts_with("rly_7f3a"));
        assert!(masked.ends_with("c91d"));
        assert!(!masked.contains("00000000"));
    }

    /// 回归：上游 api_key 是用户自由输入，非 ASCII 密钥曾让 `&t[..8]`
    /// 字节切片 panic（`relay_status` 2 秒轮询一次，必崩）。
    /// 现在必须既不 panic，也仍然不泄露中段。
    #[test]
    fn mask_survives_non_ascii_keys_without_panicking() {
        // 13 个 char（>12）才会走到切片分支；若按字节长度判断这里连分支都进不去。
        let masked = mask("sk-密钥密钥密钥密钥密钥");
        assert!(masked.starts_with("sk-密钥密"), "{masked}");
        assert!(masked.ends_with("密钥"), "{masked}");
        assert!(!masked.contains("密钥密钥密钥密钥"), "中段不许出现");

        // 带空格的输入先 trim 再切，前后段不能把空格算进去。
        assert_eq!(
            mask("  rly_7f3a000000000000c91d  "),
            mask("rly_7f3a000000000000c91d")
        );

        // 短串（char 数 <= 12）一律只给省略号，与字节长度无关。
        assert_eq!(mask("sk-测试测试"), "…");
        assert_eq!(mask("short"), "…");
    }
}
