//! `prepare_download`：签一张一次性票据，让 AI 端用 `curl -o` 把桥端文件**直接**取走。
//!
//! WHY：反方向的 `read_files` 一样贵——从 Windows 拿一张渲染截图回来看，base64 进上下文
//! 就是几万 token；二进制的 pptx/png 还会被编码与截断规则一起搞坏。
//!
//! 与 `prepare_upload` 的差别：下载是**读**操作，所以本工具 `is_write: false`，只读模式
//! 下照常可用。哈希与大小在发票据时就算好并写进返回值，AI 拿到文件后本地 `sha256sum`
//! 比对即可确认完整。

use std::sync::Arc;

use chrono::{Duration as ChronoDuration, Local};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::tools::text_result;
use crate::mcp::transfer::{self, TicketKind, DEFAULT_TTL_SECS, MAX_TTL_SECS};
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct PrepareDownloadArgs {
    /// 桥端文件绝对路径。
    pub path: String,
    /// 票据有效期秒数，默认 300，上限 1800。
    #[serde(default, rename = "ttlSeconds")]
    pub ttl_seconds: Option<u64>,
}

pub async fn handle(args: PrepareDownloadArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let (max_bytes, allowed_ext, exclude, whitelist) = {
        let config = state.config.read().await;
        (
            config.max_file_size_bytes,
            config.allowed_extensions.clone(),
            config.exclude_patterns.clone(),
            config.whitelist_enabled,
        )
    };

    let resolved = crate::security::path::resolve_safe_path_cached(
        &args.path,
        &state.cached_roots(),
        &exclude,
        whitelist,
    )?;
    // 先判「是不是普通文件」再查扩展名：目录本来没有扩展名，先查白名单只会报一句
    // 「File has no extension」，对调用方毫无指导意义。
    let meta = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("读取文件失败：{e}"))?;
    if !meta.is_file() {
        return Err(format!("不是普通文件：{}", resolved.display()));
    }
    crate::security::extension::assert_extension_allowed(&resolved, &allowed_ext)?;
    if meta.len() > max_bytes {
        return Err(format!(
            "文件 {} 字节超过上限 {} 字节，无法直传；请上调设置里的「最大文件大小」后重试",
            meta.len(),
            max_bytes
        ));
    }

    // 当场算一遍哈希：既让 AI 拿到可独立验证的期望值，也把「文件此刻是可读的」验证掉。
    let hash_path = resolved.clone();
    let (bytes, sha256) =
        tokio::task::spawn_blocking(move || transfer::sha256_file(&hash_path, u64::MAX))
            .await
            .map_err(|e| format!("哈希计算任务失败：{e}"))??;

    let ttl = args
        .ttl_seconds
        .unwrap_or(DEFAULT_TTL_SECS)
        .clamp(1, MAX_TTL_SECS);
    let (ticket_id, _expires_at) = state.transfer_tickets.issue(
        TicketKind::Download,
        resolved.clone(),
        Some(bytes),
        Some(sha256.clone()),
        false,
        std::time::Duration::from_secs(ttl),
    )?;

    let base = base_url(state).await;
    let path = format!("/transfer/{ticket_id}");
    let url = format!("{base}{path}");
    // 🔴 `-f` 不能省：`curl -sS` 对 4xx/5xx **仍然返回退出码 0**，而 `-o` 会把错误 JSON
    // 原样写进本地文件——调用方既看不到非零退出码，又拿到一个「内容是报错」的文件。
    // 下载侧不用 `--fail-with-body`，因为那正好会把错误体写进 `-o` 指定的文件。
    let curl = format!(
        "curl -sS{} -f -o '<local-file>' '{url}'",
        if base.starts_with("https://") {
            " -k"
        } else {
            ""
        }
    );
    let expires_local = Local::now() + ChronoDuration::seconds(ttl as i64);

    Ok(text_result(&json!({
        "ticketId": ticket_id,
        "method": "GET",
        "url": url,
        "path": path,
        "bytes": bytes,
        "sha256": sha256,
        "expiresAt": expires_local.to_rfc3339(),
        "expiresInSeconds": ttl,
        "curl": curl,
        "note": "Replace '<local-file>' with the real destination path and run the command from your own shell, then verify the file with `sha256sum` against `sha256`. A non-zero exit code means the download FAILED — with `-f` curl does not write the error body into the output file, so the local file is not a usable copy. The ticket works exactly ONCE and expires at expiresAt; re-call prepare_download if you need another copy."
    })))
}

/// 本次请求的对外基地址；`task_local` 拿不到时回退配置 + 网卡。
async fn base_url(state: &Arc<AppState>) -> String {
    if let Some(base) = transfer::current_base_url() {
        return base;
    }
    transfer::base_url(&axum::http::HeaderMap::new(), state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::make_state;

    fn args(path: &str) -> PrepareDownloadArgs {
        PrepareDownloadArgs {
            path: path.to_string(),
            ttl_seconds: None,
        }
    }

    fn parse(out: &Value) -> Value {
        serde_json::from_str(out["content"][0]["text"].as_str().expect("text")).expect("json")
    }

    #[tokio::test]
    async fn returns_real_size_and_hash() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".bin".to_string());
        });
        let target = dir.join("payload.bin");
        let data = vec![0x5au8; 4096];
        std::fs::write(&target, &data).unwrap();

        let v = parse(
            &handle(args(&target.to_string_lossy()), &state)
                .await
                .expect("issue"),
        );
        assert_eq!(v["method"], "GET");
        assert_eq!(v["bytes"], 4096);
        assert_eq!(
            v["sha256"].as_str().unwrap(),
            crate::mcp::transfer::sha256_of(&data),
            "返回值里的哈希必须就是文件内容的哈希"
        );
        assert!(v["url"].as_str().unwrap().starts_with("http://"));
    }

    #[tokio::test]
    async fn rejects_missing_file() {
        let (state, dir) = make_state(|_| {});
        let err = handle(args(&dir.join("nope.txt").to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        assert!(!err.is_empty());
        assert_eq!(state.transfer_tickets.len(), 0);
    }

    #[tokio::test]
    async fn rejects_directory() {
        let (state, dir) = make_state(|_| {});
        let err = handle(args(&dir.to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        assert!(err.contains("普通文件"), "{err}");
    }

    #[tokio::test]
    async fn rejects_oversized_file() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".txt".to_string());
            c.max_file_size_bytes = 4;
        });
        let target = dir.join("big.txt");
        std::fs::write(&target, b"12345").unwrap();
        let err = handle(args(&target.to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        assert!(err.contains("超过上限"), "{err}");
        // 不许再指去 read_files：它受同一个 max_file_size 约束，改了没用。
        assert!(!err.contains("read_files"), "{err}");
    }

    /// 🔴 回归：`-f` 让 curl 在 4xx/5xx 时退出码非 0，且不把错误 JSON 写进 `-o` 指定的文件。
    #[tokio::test]
    async fn curl_command_fails_on_http_error() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".bin".to_string());
        });
        let target = dir.join("c.bin");
        std::fs::write(&target, b"x").unwrap();
        let v = parse(
            &handle(args(&target.to_string_lossy()), &state)
                .await
                .expect("issue"),
        );
        let curl = v["curl"].as_str().unwrap();
        assert!(curl.contains(" -f "), "{curl}");
        assert!(curl.contains("-o "), "{curl}");
        assert!(
            !curl.contains("--fail-with-body"),
            "会污染 -o 指定的文件：{curl}"
        );
        assert!(!curl.contains("  "), "命令行里不该有连续空格：{curl}");
    }
}
