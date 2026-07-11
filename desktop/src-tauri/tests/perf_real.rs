//! 真实 over-the-wire 集成测试：把 MCP server 真起在随机端口上，
//! 用真实 HTTP 客户端（reqwest）打请求，验证 gzip 压缩与 batch 工具。
//!
//! 与 `src/mcp/tools/batch.rs` 内的单元测试不同，这里走的是完整的
//! axum 路由 → auth 中间件 → CompressionLayer → mcp_handler → dispatch_tool 链路，
//! 因此能验证"响应真的被 gzip"、"batch 真的把多步压成一次往返"等端到端行为。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::serve;
use cc_bridge_desktop::config::BridgeConfig;
use cc_bridge_desktop::mcp::http::build_router;
use cc_bridge_desktop::state::AppState;
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::net::TcpListener;

struct TestServer {
    base_url: String,
    state: Arc<AppState>,
    root: PathBuf,
    data_dir: PathBuf,
    token: String,
}

/// 起一个真实 MCP server（随机端口），返回访问信息。
async fn start() -> TestServer {
    let uniq = format!(
        "cc-bridge-perf-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let root = std::env::temp_dir().join(uniq);
    std::fs::create_dir_all(&root).unwrap();
    let data_dir = root.join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    let config = BridgeConfig {
        allowed_roots: vec![root.to_string_lossy().to_string()],
        token: "test-token".to_string(),
        whitelist_enabled: true,
        readonly_mode: false,
        audit_enabled: true,
        rate_limit_enabled: false, // 测试内避免限流干扰
        shell_enabled: false,
        host: "127.0.0.1".to_string(),
        port: 0, // 实际端口由 TcpListener 决定
        ..Default::default()
    };

    let conn = Connection::open_in_memory().unwrap();
    let state = Arc::new(AppState::new(conn, config, data_dir.clone()));

    let router = build_router(state.clone()).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });

    let base_url = format!("http://127.0.0.1:{port}");

    // 轮询 /health 直到 server 真正可服务
    let probe = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..100 {
        if probe.get(format!("{base_url}/health")).send().await.is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ready, "MCP server 未在预期时间内启动可服务");

    TestServer {
        base_url,
        state,
        root,
        data_dir,
        token: "test-token".to_string(),
    }
}

fn mcp_call(tool: &str, args: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": args }
    })
}

/// 真实验证 gzip：默认 client 自动解压拿到明文 → 验证内容正确；
/// 关闭自动解压 + 强制 Accept-Encoding: gzip → 验证服务器真的产出
/// `Content-Encoding: gzip` 且体积显著缩小。
#[tokio::test]
async fn gzip_compression_over_the_wire() {
    let srv = start().await;

    // 写一个 ~120KB 高冗余源码文本（压缩率应很好）
    let line = "fn main() {\n    println!(\"hello cc-bridge\");\n}\n";
    let big = line.repeat(4000);
    let big_path = srv.root.join("big_source.rs");
    std::fs::write(&big_path, &big).unwrap();

    let tool_args = json!({ "files": [big_path.to_string_lossy().to_string()] });
    let body = mcp_call("read_files", tool_args.clone());

    // 1) 默认 client（自动解压 gzip）→ 拿到明文，验证内容 + 记录明文长度
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/mcp", srv.base_url))
        .header("Authorization", format!("Bearer {}", srv.token))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.unwrap();
    let parsed: Value = serde_json::from_str(&text).unwrap();
    let content = parsed["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        content.contains("fn main()"),
        "自动解压后 read_files 应回传源码内容"
    );
    let plaintext_len = text.len();

    // 2) 关闭自动解压 + 手动强制 Accept-Encoding: gzip → 观察原始压缩响应
    let client_no_dec = reqwest::Client::builder().gzip(false).build().unwrap();
    let resp2 = client_no_dec
        .post(format!("{}/mcp", srv.base_url))
        .header("Authorization", format!("Bearer {}", srv.token))
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "gzip")
        .json(&body)
        .send()
        .await
        .unwrap();
    let ce = resp2
        .headers()
        .get("content-encoding")
        .map(|v| v.to_str().unwrap().to_string());
    assert_eq!(
        ce.as_deref(),
        Some("gzip"),
        "客户端支持 gzip 时，服务器应返回 Content-Encoding: gzip"
    );
    let raw = resp2.bytes().await.unwrap();
    println!(
        "明文响应 {plaintext_len} 字节 → gzip 后 {gzip_len} 字节",
        gzip_len = raw.len()
    );
    assert!(
        raw.len() < plaintext_len / 2,
        "gzip 后体积应显著缩小（< 明文一半）：明文 {plaintext_len} vs gzip {}",
        raw.len()
    );

    // 反例：客户端不声明 gzip → 不应压缩（透明跳过）
    let resp3 = client_no_dec
        .post(format!("{}/mcp", srv.base_url))
        .header("Authorization", format!("Bearer {}", srv.token))
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity")
        .json(&body)
        .send()
        .await
        .unwrap();
    let ce3 = resp3.headers().get("content-encoding").cloned();
    assert_eq!(
        ce3, None,
        "客户端只声明 identity 时，服务器应透明跳过压缩（无 Content-Encoding）"
    );
}

/// 真实验证 batch：一次 HTTP 往返完成多个跨类型操作，且复用安全校验。
#[tokio::test]
async fn batch_collapses_multiple_ops_into_one_round_trip() {
    let srv = start().await;

    let a = srv.root.join("a.txt");
    std::fs::write(&a, "alpha").unwrap();
    let b = srv.root.join("b.txt");
    std::fs::write(&b, "beta").unwrap();

    let body = mcp_call(
        "batch",
        json!({
            "operations": [
                { "tool": "read_files", "arguments": { "files": [a.to_string_lossy().to_string()] } },
                { "tool": "read_files", "arguments": { "files": [b.to_string_lossy().to_string()] } },
                { "tool": "list_directory", "arguments": { "path": srv.root.to_string_lossy().to_string() } }
            ]
        }),
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/mcp", srv.base_url))
        .header("Authorization", format!("Bearer {}", srv.token))
        .json(&body)
        .send()
        .await
        .unwrap();
    let parsed: Value = serde_json::from_str(&resp.text().await.unwrap()).unwrap();
    let inner: Value =
        serde_json::from_str(parsed["result"]["content"][0]["text"].as_str().unwrap()).unwrap();

    assert_eq!(
        inner["total"], 3,
        "3 个操作应全部执行（N 次往返被压成 1 次）"
    );
    assert_eq!(inner["results"][0]["ok"], true);
    assert_eq!(inner["results"][1]["ok"], true);
    assert_eq!(inner["results"][2]["ok"], true);
    assert!(inner["results"][0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("alpha"));
    assert!(inner["results"][1]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("beta"));
}

/// 真实验证 batch 内写操作审计留痕：外层只记一条 "batch"，
/// 但 write_files 必须在 audit.log 中另有独立记录，否则绕过审计。
#[tokio::test]
async fn batch_writes_are_audited() {
    let srv = start().await;

    let newfile = srv.root.join("written.txt");
    let body = mcp_call(
        "batch",
        json!({
            "operations": [
                { "tool": "write_files", "arguments": { "files": [
                    { "path": newfile.to_string_lossy().to_string(), "content": "hello from batch" }
                ] } }
            ]
        }),
    );

    let client = reqwest::Client::new();
    client
        .post(format!("{}/mcp", srv.base_url))
        .header("Authorization", format!("Bearer {}", srv.token))
        .json(&body)
        .send()
        .await
        .unwrap();

    let log = std::fs::read_to_string(srv.data_dir.join("audit.log")).expect("audit.log 应被创建");
    assert!(
        log.contains("\"tool\":\"write_files\""),
        "batch 内的 write_files 必须单独留审计记录，不应被外层 batch 调用覆盖"
    );
}

/// 真实验证 batch 遵守只读模式：开启只读后，batch 内的写操作应被拦截。
#[tokio::test]
async fn batch_respects_readonly_mode() {
    let srv = start().await;

    {
        let mut cfg = srv.state.config.write().await;
        cfg.readonly_mode = true;
    }

    let body = mcp_call(
        "batch",
        json!({
            "operations": [
                { "tool": "write_files", "arguments": { "files": [
                    { "path": srv.root.join("x.txt").to_string_lossy().to_string(), "content": "y" }
                ] } }
            ]
        }),
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/mcp", srv.base_url))
        .header("Authorization", format!("Bearer {}", srv.token))
        .json(&body)
        .send()
        .await
        .unwrap();
    let parsed: Value = serde_json::from_str(&resp.text().await.unwrap()).unwrap();
    let inner: Value =
        serde_json::from_str(parsed["result"]["content"][0]["text"].as_str().unwrap()).unwrap();

    assert_eq!(inner["results"][0]["ok"], false);
    assert!(
        inner["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("只读模式"),
        "只读模式下 batch 内的写操作应被拦截"
    );
}
