//! `prepare_upload`：签一张一次性票据，让 AI 端用 `curl -T` 把文件**直接**推到桥端。
//!
//! WHY：`write_files(encoding:"base64")` 的每个字节都要过模型上下文（一个 169KB 的
//! pptx ≈ 十几万 token，还会抄错字符）。这里只把「路径 + 期望哈希」送进上下文，
//! 字节走 `PUT /transfer/{ticket}` 的裸 HTTP 通道，由 `mcp/transfer.rs` 流式落盘。
//!
//! 本工具**只发票据、不碰文件内容**；所有校验在发票据时就做完（白名单、扩展名、
//! 只读模式、大小、覆盖），失败直接报错不发票据——让 AI 在动手 curl 之前就知道不行。

use std::sync::Arc;

use chrono::{Duration as ChronoDuration, Local};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::tools::text_result;
use crate::mcp::transfer::{self, TicketKind, DEFAULT_TTL_SECS, MAX_TTL_SECS};
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct PrepareUploadArgs {
    /// 桥端目标绝对路径。
    pub path: String,
    /// 可选：期望的 sha256（hex，64 字符）。传了就由**服务端**在写完时比对，
    /// 不一致整次作废、目标文件不变——比让模型自己抄哈希可靠。
    #[serde(default)]
    pub sha256: Option<String>,
    /// 可选：期望字节数。用于提前拒绝超限，并在完成时比对。
    #[serde(default)]
    pub size: Option<u64>,
    /// 默认 true。false 时目标已存在直接报错。
    #[serde(default)]
    pub overwrite: Option<bool>,
    /// 票据有效期秒数，默认 300，上限 1800。
    #[serde(default, rename = "ttlSeconds")]
    pub ttl_seconds: Option<u64>,
}

pub async fn handle(args: PrepareUploadArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let (max_bytes, allowed_ext, exclude, whitelist, readonly) = {
        let config = state.config.read().await;
        (
            config.max_file_size_bytes,
            config.allowed_extensions.clone(),
            config.exclude_patterns.clone(),
            config.whitelist_enabled,
            config.readonly_mode,
        )
    };
    // 只读模式：`registry` 已把本工具标成 write、`dispatch_tool` 会先拦一道；
    // 这里再判一次是因为「发票据 = 授权未来的一次写入」，语义上必须与 write_files 同级。
    if readonly {
        return Err(
            "只读模式已开启，已拒绝签发上传票据。如需写入，请在 CC Bridge 设置页关闭「只读模式」。"
                .to_string(),
        );
    }

    let resolved = crate::security::path::resolve_safe_path_cached(
        &args.path,
        &state.cached_roots(),
        &exclude,
        whitelist,
    )?;
    // 目录要单独判一次，而且要在扩展名校验**之前**：目录通常没有扩展名，先查白名单只会
    // 报一句「File has no extension」，而真正的原因是「你把一个目录当成了文件路径」。
    // 若放过去，上传会在最后的 rename 阶段炸成 500（Windows 不允许把文件改名到已存在的
    // 目录上），临时文件清了、错误文案却毫无指导性。
    if resolved.is_dir() {
        return Err(format!(
            "目标路径是一个目录，不能作为上传目标：{}",
            resolved.display()
        ));
    }
    crate::security::extension::assert_extension_allowed(&resolved, &allowed_ext)?;

    if let Some(size) = args.size {
        if size > max_bytes {
            return Err(format!(
                "声明的大小 {size} 字节超过上限 {max_bytes} 字节；请先在 AI 端压缩或拆分，再重新申请"
            ));
        }
    }

    let overwrite = args.overwrite.unwrap_or(true);
    if !overwrite && resolved.exists() {
        return Err(format!(
            "目标文件已存在且 overwrite=false：{}",
            resolved.display()
        ));
    }

    let expected_sha256 = match args.sha256.as_deref() {
        None => None,
        Some(raw) => Some(normalize_sha256(raw)?),
    };

    let ttl = args
        .ttl_seconds
        .unwrap_or(DEFAULT_TTL_SECS)
        .clamp(1, MAX_TTL_SECS);
    let (ticket_id, _) = state.transfer_tickets.issue(
        TicketKind::Upload,
        resolved.clone(),
        args.size,
        expected_sha256.clone(),
        overwrite,
        std::time::Duration::from_secs(ttl),
    )?;

    let base = base_url(state).await;
    let path = format!("/transfer/{ticket_id}");
    let url = format!("{base}{path}");
    // 🔴 `--fail-with-body` 不能省：`curl -sS` 对 4xx/5xx **仍然返回退出码 0**，
    // 只看退出码的调用方会把「401 票据无效」「409 哈希不符」当成上传成功。
    // 带上它之后退出码非 0，同时仍能打印服务端返回的 JSON 错误。
    let curl = format!(
        "curl -sS --fail-with-body{} -T '<local-file>' '{url}'",
        if base.starts_with("https://") {
            " -k"
        } else {
            ""
        }
    );
    // 票据的到期时刻（票据表内部也有一份 Instant；这里只为人读）。
    let expires_local = Local::now() + ChronoDuration::seconds(ttl as i64);

    Ok(text_result(&json!({
        "ticketId": ticket_id,
        "method": "PUT",
        "url": url,
        "path": path,
        "maxBytes": max_bytes,
        "overwrite": overwrite,
        "expiresAt": expires_local.to_rfc3339(),
        "expiresInSeconds": ttl,
        "expectedSha256": expected_sha256,
        "curl": curl,
        "note": "Replace '<local-file>' with the real source path and run the command from your own shell to stream the bytes. The HTTP response is JSON — check `ok`, and note that a non-zero exit code means the upload FAILED (`--fail-with-body` makes curl exit non-zero on HTTP 4xx/5xx). The ticket works exactly ONCE and expires at expiresAt; if the upload fails, call prepare_upload again."
    })))
}

/// 校验并规整 sha256：64 位 hex，统一小写（`eq_ignore_ascii_case` 之外再规整一次，
/// 让返回值里能直接给人看）。
fn normalize_sha256(raw: &str) -> Result<String, String> {
    let t = raw.trim().to_ascii_lowercase();
    if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "sha256 必须是 64 位十六进制字符串（收到 {} 个字符）。也可以不传，由服务端返回计算结果供你比对。",
            raw.trim().len()
        ));
    }
    Ok(t)
}

/// 本次请求的对外基地址；`task_local` 拿不到时回退配置 + 网卡（同 `transfer::base_url`）。
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

    fn args(path: &str) -> PrepareUploadArgs {
        PrepareUploadArgs {
            path: path.to_string(),
            sha256: None,
            size: None,
            overwrite: None,
            ttl_seconds: None,
        }
    }

    /// `current_base_url` 只在 `mcp_handler` 的 task_local 作用域里才有值，
    /// 单测直接调 handler 时走「无 Host 回退」分支，但仍必须给出 http(s) 绝对地址。
    #[tokio::test]
    async fn issues_ticket_with_absolute_url() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".pptx".to_string());
        });
        let target = dir.join("a.pptx");
        let out = handle(args(&target.to_string_lossy()), &state)
            .await
            .expect("issue");
        let text = out["content"][0]["text"].as_str().expect("text");
        let v: Value = serde_json::from_str(text).expect("json");
        assert_eq!(v["method"], "PUT");
        let url = v["url"].as_str().unwrap();
        assert!(url.starts_with("http://"), "{url}");
        assert!(url.ends_with(v["path"].as_str().unwrap()));
        assert_eq!(
            v["path"].as_str().unwrap(),
            format!("/transfer/{}", v["ticketId"].as_str().unwrap())
        );
        assert_eq!(state.transfer_tickets.len(), 1);
    }

    #[tokio::test]
    async fn rejects_extension_outside_whitelist() {
        let (state, dir) = make_state(|_| {});
        let target = dir.join("a.exe");
        let err = handle(args(&target.to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        // 文案必须点名扩展名与「去哪儿改」：原来只回一句英文 "Extension ... is not in
        // the allowed list"，AI 端只会原地重试或改用 base64 绕路。
        assert!(err.contains(".exe"), "{err}");
        assert!(err.contains("文件管控"), "必须给出可操作指引：{err}");
        assert_eq!(state.transfer_tickets.len(), 0, "失败不发票据");
    }

    /// 目录必须被明确拒绝：放过去会在最后的 rename 阶段炸成 500
    /// （Windows 不允许把文件改名到已存在的目录上），错误文案还毫无指导性。
    #[tokio::test]
    async fn rejects_directory_target() {
        let (state, dir) = make_state(|_| {});
        let sub = dir.join("a-folder");
        std::fs::create_dir_all(&sub).unwrap();
        let err = handle(args(&sub.to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        assert!(err.contains("目录"), "{err}");
        assert_eq!(state.transfer_tickets.len(), 0);

        // 带扩展名的目录同样要拦住（否则会先过扩展名白名单）
        let dotted = dir.join("looks-like.pptx");
        std::fs::create_dir_all(&dotted).unwrap();
        let err = handle(args(&dotted.to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        assert!(err.contains("目录"), "{err}");
    }

    #[tokio::test]
    async fn rejects_path_outside_whitelist() {
        let (state, _dir) = make_state(|_| {});
        let err = handle(args("C:/Windows/System32/drivers/etc/hosts"), &state)
            .await
            .expect_err("must reject");
        assert!(!err.is_empty());
        assert_eq!(state.transfer_tickets.len(), 0);
    }

    #[tokio::test]
    async fn rejects_oversized_declared_size() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".pptx".to_string());
            c.max_file_size_bytes = 10;
        });
        let mut a = args(&dir.join("big.pptx").to_string_lossy());
        a.size = Some(11);
        let err = handle(a, &state).await.expect_err("must reject");
        assert!(err.contains("超过上限"), "{err}");
        assert_eq!(state.transfer_tickets.len(), 0);
    }

    #[tokio::test]
    async fn rejects_existing_target_when_overwrite_false() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".txt".to_string());
        });
        let target = dir.join("exists.txt");
        std::fs::write(&target, b"old").unwrap();
        let mut a = args(&target.to_string_lossy());
        a.overwrite = Some(false);
        let err = handle(a, &state).await.expect_err("must reject");
        assert!(err.contains("已存在"), "{err}");
    }

    #[tokio::test]
    async fn rejects_readonly_mode() {
        let (state, dir) = make_state(|c| {
            c.readonly_mode = true;
        });
        let err = handle(args(&dir.join("x.txt").to_string_lossy()), &state)
            .await
            .expect_err("must reject");
        assert!(err.contains("只读"), "{err}");
    }

    #[tokio::test]
    async fn normalizes_and_rejects_bad_sha256() {
        assert_eq!(
            normalize_sha256(
                "  ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789  "
            )
            .unwrap(),
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        assert!(normalize_sha256("deadbeef").is_err());
        assert!(normalize_sha256(
            "zzzzzz0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        )
        .is_err());
    }

    #[tokio::test]
    async fn clamps_ttl() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".txt".to_string());
        });
        let mut a = args(&dir.join("t.txt").to_string_lossy());
        a.ttl_seconds = Some(999_999);
        let out = handle(a, &state).await.expect("issue");
        let text = out["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["expiresInSeconds"], MAX_TTL_SECS);
    }

    /// 🔴 回归：`curl -sS` 对 4xx/5xx 仍返回退出码 0，漏掉 `--fail-with-body` 时
    /// 「401 票据无效」会被调用方当成上传成功。
    #[tokio::test]
    async fn curl_command_fails_on_http_error() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions.push(".txt".to_string());
        });
        let out = handle(args(&dir.join("c.txt").to_string_lossy()), &state)
            .await
            .expect("issue");
        let text = out["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        let curl = v["curl"].as_str().unwrap();
        assert!(curl.contains("--fail-with-body"), "{curl}");
        assert!(curl.contains("-T "), "{curl}");
        assert!(curl.contains(v["url"].as_str().unwrap()), "{curl}");
        // 不许出现旧实现的连续双空格（`-k  -T`），说明拼接用的是「带前导空格」而非「带尾随空格」
        assert!(!curl.contains("  "), "命令行里不该有连续空格：{curl}");
    }
}
