//! 来源守卫：拒浏览器、拒 DNS rebinding、给「谁在打这个端口」一个明确答案。
//!
//! §4.10 第 7 条是这一节的全部理由：**`127.0.0.1:4100` 这个端口任何网页都能访问**。
//! 回环地址不等于安全边界——恶意页面可以用 no-cors POST 打请求、用 WebSocket 探端口，
//! 或者用 DNS rebinding 把域名解析换成本机回环。
//!
//! 判定条件（三者任一即拒）：
//! - 带 `Origin` 头
//! - `Sec-Fetch-Site` 存在且不是 `none`
//! - 带 `Upgrade` 头
//!
//! Claude Code 这类 CLI 客户端不会发这三个头里的任何一个，所以正常请求不受影响。
//! 这条在**内网直连模式下同样生效**。

use axum::http::HeaderMap;

/// 守卫结论。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// 看起来是浏览器请求。403。
    Browser {
        why: &'static str,
    },
    /// `Host` 不在白名单。421 Misdirected Request。
    BadHost {
        host: String,
    },
}

impl Verdict {
    pub fn is_allow(&self) -> bool {
        matches!(self, Verdict::Allow)
    }

    /// 给用户的说明。**要和「token 填错」区分开**——两者都是 4xx，但原因完全不同。
    pub fn message(&self) -> String {
        match self {
            Verdict::Allow => "允许".into(),
            Verdict::Browser { why } => format!(
                "中转拒绝了来自浏览器的请求（{why}）。这个端口只给命令行客户端用：\
                 网页能访问本机回环地址，如果放行，任何页面都能消耗你的上游额度。"
            ),
            Verdict::BadHost { host } => format!(
                "中转拒绝了主机名「{host}」：它不在监听地址的白名单里。\
                 这通常意味着有域名被解析到了本机（DNS rebinding），或者配置里的监听地址变了。"
            ),
        }
    }
}

/// 判一次请求。
///
/// `allowed_hosts` 由 [`allowed_hosts`] 生成，调用方在监听启动时算一次。
pub fn check(headers: &HeaderMap, allowed_hosts: &[String]) -> Verdict {
    // 1. 浏览器指纹
    if headers.contains_key("origin") {
        return Verdict::Browser {
            why: "带 Origin 头",
        };
    }
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if !site.eq_ignore_ascii_case("none") {
            return Verdict::Browser {
                why: "Sec-Fetch-Site 表明是页面发起的请求",
            };
        }
    }
    if headers.contains_key("upgrade") {
        return Verdict::Browser {
            why: "带 Upgrade 头（WebSocket 探测）",
        };
    }

    // 2. Host 白名单（防 DNS rebinding 的第二道闸）
    //    没有 Host 头时不拦：HTTP/1.0 或某些本地库不发它，而那种请求也做不了
    //    rebinding——rebinding 的前提就是浏览器把域名塞进 Host。
    if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
        let host = host.trim();
        if !allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            return Verdict::BadHost {
                host: host.to_string(),
            };
        }
    }

    Verdict::Allow
}

/// 生成 Host 白名单：监听地址本身 + 回环的三种写法。
///
/// 带端口与不带端口两种形态都要进去：不同客户端写法不一致，`Host: 127.0.0.1:4100`
/// 与 `Host: localhost` 都是合法的。
pub fn allowed_hosts(listen_host: &str, port: u16) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    let mut push = |h: &str| {
        let with_port = if h.contains(':') && !h.starts_with('[') {
            // IPv6 裸地址必须补方括号，否则 `::1:4100` 是非法 Host
            format!("[{h}]:{port}")
        } else {
            format!("{h}:{port}")
        };
        if !hosts.contains(&with_port) {
            hosts.push(with_port);
        }
        if !hosts.iter().any(|x| x == h) {
            hosts.push(h.to_string());
        }
    };

    push("127.0.0.1");
    push("localhost");
    push("[::1]");
    push("::1");
    if !listen_host.is_empty() && listen_host != "127.0.0.1" {
        push(listen_host);
    }
    hosts
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

    fn hosts() -> Vec<String> {
        allowed_hosts("10.0.19.194", 4100)
    }

    #[test]
    fn cli_request_is_allowed() {
        let h = headers(&[
            ("host", "127.0.0.1:4100"),
            ("content-type", "application/json"),
        ]);
        assert_eq!(check(&h, &hosts()), Verdict::Allow);
    }

    #[test]
    fn origin_header_is_rejected() {
        let h = headers(&[("host", "127.0.0.1:4100"), ("origin", "https://evil.com")]);
        assert!(matches!(check(&h, &hosts()), Verdict::Browser { .. }));
    }

    #[test]
    fn cross_site_fetch_metadata_is_rejected() {
        let h = headers(&[("host", "127.0.0.1:4100"), ("sec-fetch-site", "cross-site")]);
        assert!(matches!(check(&h, &hosts()), Verdict::Browser { .. }));
        // same-origin 也不行：页面内请求同样是浏览器发起
        let h = headers(&[
            ("host", "127.0.0.1:4100"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(matches!(check(&h, &hosts()), Verdict::Browser { .. }));
        // none 放行（文档口径）
        let h = headers(&[("host", "127.0.0.1:4100"), ("sec-fetch-site", "none")]);
        assert_eq!(check(&h, &hosts()), Verdict::Allow);
    }

    #[test]
    fn upgrade_header_is_rejected() {
        let h = headers(&[("host", "127.0.0.1:4100"), ("upgrade", "websocket")]);
        assert!(matches!(check(&h, &hosts()), Verdict::Browser { .. }));
    }

    #[test]
    fn foreign_host_is_misdirected() {
        // DNS rebinding：evil.com 的 A 记录指到 127.0.0.1，浏览器仍认为在访问 evil.com
        let h = headers(&[("host", "evil.com:4100")]);
        assert_eq!(
            check(&h, &hosts()),
            Verdict::BadHost {
                host: "evil.com:4100".into()
            }
        );
    }

    #[test]
    fn loopback_forms_and_listen_ip_are_allowed() {
        for host in [
            "127.0.0.1:4100",
            "localhost:4100",
            "[::1]:4100",
            "10.0.19.194:4100",
            "localhost",
        ] {
            let h = headers(&[("host", host)]);
            assert_eq!(check(&h, &hosts()), Verdict::Allow, "{host} 应放行");
        }
    }

    #[test]
    fn missing_host_is_allowed() {
        // 没有 Host 头做不了 rebinding，拦它只会误伤本地库。
        let h = headers(&[("content-type", "application/json")]);
        assert_eq!(check(&h, &hosts()), Verdict::Allow);
    }

    #[test]
    fn ipv6_listen_address_gets_brackets() {
        let list = allowed_hosts("::1", 4100);
        assert!(list.iter().any(|h| h == "[::1]:4100"), "{list:?}");
        assert!(list.iter().any(|h| h == "[::1]"), "{list:?}");
    }
}
