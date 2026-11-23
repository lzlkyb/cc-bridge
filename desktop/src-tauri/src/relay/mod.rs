//! 模型中转（P0 骨架）。
//!
//! **当前阶段只做一件事**：让「上游请求 + 响应体逐块读取」这条代码路径真实存在于
//! release 二进制里，从而能测出 P1 的体积代价。
//!
//! 为什么不能只加一条 `Cargo.toml` 声明就测体积：reqwest 早就被
//! `tauri-plugin-updater` 链接进 exe 了，单独加声明、代码里不引用，linker 会把
//! 我们没用到的泛型实例化全部剔除，测出来是假的「零增量」。所以这里必须有一段
//! **真实可达**的代码（经 Tauri 命令表注册，LTO 不敢删）——它用的正是 P1 转发
//! 的核心 API：构造请求 → 发出去 → 逐块读响应体。
//!
//! P1 会把它重写成正式实现（协议透传、规则表清洗、日志、SSE 直通），届时删除
//! [`probe`] 这个诊断入口。

use std::time::{Duration, Instant};

use serde::Serialize;

/// 一次探测的结果。
///
/// **刻意只回协议层事实**（状态码、块数、字节数、首块延迟），不回响应正文——
/// 探测是给人排查「连不通还是慢」用的，不该顺手把上游内容吐到前端。
#[derive(Debug, Serialize)]
pub struct ProbeOutcome {
    /// 上游 HTTP 状态码（不做任何映射，P1 同样原样透传）。
    pub status: u16,
    pub content_type: Option<String>,
    /// 收到多少块。SSE 场景下这一项远大于 1，说明流是真在流、没被缓冲成整体。
    pub chunks: u64,
    pub bytes: u64,
    /// 首个数据块的耗时。TTFB 的真实指标——比「请求总耗时」有意义得多。
    pub first_chunk_ms: Option<u64>,
    pub total_ms: u64,
    /// 非 2xx 时截取响应体开头，便于看上游的 OriginalError 原文。
    pub error_head: Option<String>,
}

/// 把一次请求打到指定上游，并把响应体逐块读完。
///
/// 逐块读（而不是 `resp.text()`）有两个目的，P1 会原样沿用：
/// 1. 流式响应必须块到手就往下游写，收全再写等于把 SSE 变成一次性返回；
/// 2. 块读取能边收边计数，超限可以立刻断流，而不是等整个 body 进内存。
pub async fn probe(
    url: &str,
    token: &str,
    body: &str,
    timeout_s: u64,
) -> Result<ProbeOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_s.max(1)))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let start = Instant::now();
    let mut resp = client
        .post(url)
        .header("content-type", "application/json")
        // Anthropic Messages 协议同时接受 x-api-key 与 Bearer；两个都发，兼容性最好。
        .header("x-api-key", token)
        .header("authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .body(body.to_owned())
        .send()
        .await
        .map_err(|e| format!("请求未送达：{e}"))?;

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let mut chunks: u64 = 0;
    let mut bytes: u64 = 0;
    let mut first_chunk_ms = None;
    // 非 2xx 时留一点点正文用于看清上游怎么说；2xx 完全不缓存正文，避免大响应占内存。
    let mut error_head = Vec::new();

    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if chunks == 0 {
                    first_chunk_ms = Some(start.elapsed().as_millis() as u64);
                }
                chunks += 1;
                bytes += chunk.len() as u64;
                if status >= 400 && error_head.len() < 512 {
                    let room = 512 - error_head.len();
                    error_head.extend_from_slice(&chunk[..chunk.len().min(room)]);
                }
            }
            Ok(None) => break,
            Err(e) => {
                // 已经收到数据时不要整个失败——把已收到的量如实报出去更有诊断价值。
                if chunks == 0 {
                    return Err(format!("读取响应体失败：{e}"));
                }
                log::warn!("中转探测：流在 {chunks} 块后中断：{e}");
                break;
            }
        }
    }

    Ok(ProbeOutcome {
        status,
        content_type,
        chunks,
        bytes,
        first_chunk_ms,
        total_ms: start.elapsed().as_millis() as u64,
        error_head: if error_head.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&error_head).into_owned())
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 首块延迟与总耗时都不该是负值或溢出的怪数——这里只锁「时间字段单调」，
    /// 真正的网络行为留给 P1 的录制回放用例。
    #[test]
    fn probe_outcome_serializes_expected_fields() {
        let outcome = ProbeOutcome {
            status: 200,
            content_type: Some("text/event-stream".into()),
            chunks: 7,
            bytes: 1024,
            first_chunk_ms: Some(12),
            total_ms: 30,
            error_head: None,
        };
        let json = serde_json::to_value(&outcome).expect("序列化失败");
        assert_eq!(json["status"], 200);
        assert_eq!(json["chunks"], 7);
        // 空正文必须是 null 而非空字符串，前端才能用 `!= null` 判断。
        assert!(json["error_head"].is_null());
    }
}
