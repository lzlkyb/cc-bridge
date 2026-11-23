//! 模型中转的 IPC 命令层（P0 探测）。
//!
//! 现在只有一个诊断入口 [`relay_probe`]：给定上游地址打一发请求，回报状态码 /
//! 首块延迟 / 块数。它存在的**唯一目的是保住 release 二进制里的流式转发代码路径**
//! ——否则 linker 会把 reqwest 里我们没引用的部分全剔除，P0 的体积结论就是假的。
//!
//! P1 会把这里替换成正式的启停 / 配置 / 日志命令；届时删掉 `relay_probe`。

use crate::relay::{probe, ProbeOutcome};

/// 打一发上游请求，回报协议层事实（不返回正文）。
///
/// `url` 必须是完整的 Messages 端点（如 `https://host/apps/anthropic/v1/messages`）。
/// `token` 由前端传入而不从配置读：P0 阶段还没有「中转 token」这个配置项，
/// P1 会改成从加密存储里取、前端一个字节都看不到。
#[tauri::command]
pub async fn relay_probe(
    url: String,
    token: String,
    body: String,
    timeout_s: Option<u64>,
) -> Result<ProbeOutcome, String> {
    probe(&url, &token, &body, timeout_s.unwrap_or(120)).await
}
