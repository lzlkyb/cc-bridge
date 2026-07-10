# 实施方案：① 响应 gzip 压缩　② 跨类型 batch 工具

> 前置文档：`proposals/perf_compression_and_batch_feasibility.md`（可行性已闭合，本文只讲"怎么改"）
> 代码基线：v2.2.17，锚点已按当前 `http.rs` / `Cargo.toml` / `tools/mod.rs` 核对
> 遵循 CLAUDE.md 规则5：本方案不含 commit / push / 版本 bump，实现后等用户明确说"提交"才只 commit 不 push

---

## 实现状态（2026-07-10 已完成代码）

- ① gzip：`Cargo.toml` 加 `compression-gzip` feature；`http.rs` 引入 `CompressionLayer` 并在 router 最外层挂载 `CompressionLayer::new().gzip(true)`；`read_files.rs` 的 `to_string_pretty` → `to_string`（紧凑 JSON）。
- ② batch：新增 `tools/batch.rs`；`dispatch_tool` 改 `pub`；`tools/mod.rs` 注册；`http.rs` match 加 `batch` 分支 + `get_tool_definitions` 加定义；`batch.rs` 内对 `dispatch_tool` 用 `Box::pin` 断开互递归。
- 验证：`cargo test --lib` **58 passed / 0 failed / 1 ignored**（原 52 + 新增 6 个 batch 测试：空操作拒绝、嵌套拒绝、白名单内读成功、白名单外拒绝、只读拦截写、stopOnError 中断）。
- **关键语义修正（实测发现）**：`read_files` 等工具对单文件错误是**内联进结果、工具级仍返回 Ok**（从不向上抛 Err）。因此 batch 的 `ok` 标志只反映"子工具是否工具级失败"（如未知工具、只读模式拦截的写），判断读文件是否真成功需看子结果内部的 `error` 字段。测试断言已据此修正。
- 仍未做：O1 结构化耗时拆解（独立度量项，用于量化这两项收益）。

### 真实 over-the-wire 测试（2026-07-10 已补充）

为验证"真能用"，新增 `desktop/src-tauri/tests/perf_real.rs` 集成测试：把 `build_router(state)` 绑到随机端口
（`TcpListener::bind("127.0.0.1:0")`）真实起一个 MCP HTTP server，用真实 `reqwest` 客户端打请求，走完
`auth 中间件 → CompressionLayer → mcp_handler → dispatch_tool` 全链路。`build_router` 是从 `spawn_mcp_server`
抽出的 `pub async fn`，供 spawn 与测试共用（测试无需走 Tauri GUI）。

4 个测试全部通过（连同原有 58 个 lib 测试，全量 **62 passed / 0 failed**）：

| 测试 | 验证点 | 结果 |
|---|---|---|
| `gzip_compression_over_the_wire` | 客户端发 `Accept-Encoding: gzip` 时响应头含 `Content-Encoding: gzip`，且 ~120KB 源码文本 gzip 后体积 **< 明文一半**；客户端自动解压后内容正确；仅声明 `identity` 时透明跳过压缩 | ✅ |
| `batch_collapses_multiple_ops_into_one_round_trip` | 一次 `tools/call` 携带 read+read+list_directory 三个跨类型操作，返回 `total == 3`，且复用安全校验（读取成功） | ✅ |
| `batch_writes_are_audited` | batch 内的 `write_files` 在 `data_dir/audit.log` 中有**独立**审计记录（不被外层 batch 调用覆盖） | ✅ |
| `batch_respects_readonly_mode` | 开启只读模式后，batch 内的 `write_files` 被拦截，结果 `ok == false` 且含"只读模式" | ✅ |

**实现过程中踩到的 axum 0.8 坑（可复用）**：
- `axum::serve(listener, router)` 不会自动提供 `ConnectInfo`；`auth_middleware` 强依赖它取客户端 IP，
  提取失败会直接 500。必须显式 `router.into_make_service_with_connect_info::<SocketAddr>()`。
- `into_make_service_with_connect_info` 是 `Router<()>` 的**固有方法**（不是 trait 方法），且 `with_state`
  返回的是 `Router<()>`（state 被内联进内部、外层 S 变 `()`）。所以 `build_router` 的返回类型应标 `Router`
  （即 `Router<()>`），**不能**标 `Router<Arc<AppState>>`，否则该方法不可见、`serve` 也只接受 `Router<()>`。

---

## 总览

| 项 | 改动面 | 风险 | 收益 | 生效确定性 |
|---|---|---|---|---|
| ① gzip 压缩 | Cargo 1 行 + http.rs 2 处 | 极低 | 传输体积压 5–10× | **确定**（undici 默认解压） |
| ② batch 工具 | tools/mod.rs + 新增 batch.rs + http.rs 3 处 | 低（零新攻击面） | 往返数 N→1 | **取决于模型是否调用** |

建议先做 ①（纯服务端、确定生效），再做 ②。两项都建议先落 O1 结构化耗时拆解，用真实 audit.log 量化收益。

---

## ① 响应 gzip 压缩

### 改动 1：Cargo.toml
`tower-http` feature 加 `compression-gzip`：

```toml
# 第 21 行
tower-http = { version = "0.6", features = ["limit", "compression-gzip"] }
```

> 只加 gzip 而非 `compression-full`：避免拉入 br/zstd 依赖增大二进制（本项目已在 profile 里体积优先）。undici 默认只协商 gzip/deflate/br，gzip 足够覆盖。

### 改动 2：http.rs — 引入并挂载 CompressionLayer
顶部 use 区（第 1–16 行附近）加：

```rust
use tower_http::compression::CompressionLayer;
```

router 构建处（当前第 32–40 行）在**最外层**加压缩层。注意顺序：压缩层要包在 auth / limit **之外**，这样对所有响应（含 /health）生效，且不影响入站 body limit 判定：

```rust
let app = axum::Router::new()
    .route("/health", get(health_handler))
    .route("/mcp", post(mcp_handler))
    .layer(axum::middleware::from_fn_with_state(
        state.clone(),
        auth_middleware,
    ))
    .layer(tower_http::limit::RequestBodyLimitLayer::new(body_limit))
    .layer(CompressionLayer::new().gzip(true)) // ← 新增：响应体 gzip
    .with_state(state);
```

> `CompressionLayer` 会读请求的 `accept-encoding`，只有客户端声明支持才压缩；不支持时透明跳过——**无害**。它也会自动跳过太小的 body（默认阈值），避免小响应压缩反而变大。

### 改动 3（可选，零成本再缩体积）：read_files.rs
把 `to_string_pretty` 换成紧凑 `to_string`（当前 `read_files.rs:68` 附近）。pretty-print 的缩进和换行在压缩后收益减小，但紧凑 JSON 本身仍能少 ~10–15% 明文体积，且是纯零风险改动。

### 验证
1. `cargo build` 通过。
2. **部署前 5 分钟实测**：在 `mcp_handler` 入口临时 `log::info!("accept-encoding: {:?}", req.headers().get("accept-encoding"))`（需临时把 handler 改成能拿 headers，或在 auth_middleware 里打），确认 Claude Code 客户端确实发 `gzip`。高置信度会发（undici 默认）。确认后删掉临时日志。
3. 对比同一个 `read_files` 大响应压缩前后的字节数（可用 O1 拆解里的传输字节字段）。

### 回滚
去掉那一行 `.layer(CompressionLayer::new()...)` + Cargo feature 即可，无状态、无数据迁移。

---

## ② 跨类型 batch 工具

### 设计原则
- **零重写**：batch 内部逐个调用**现有** `dispatch_tool`，复用其全部安全逻辑（只读模式、WRITE_TOOLS 拦截、每个 handler 内部的 `resolve_safe_path` 校验）。**不新增任何文件操作代码 = 零新攻击面。**
- **禁止嵌套**：batch 内不允许再调 `batch`（防递归炸栈 / 放大攻击），在分发处显式拒绝。
- **失败策略**：默认 `stopOnError=true`（遇错即停，返回已完成结果 + 出错项）；可选 `false` 全部执行、逐项报告成败。
- **审计**：当前审计在 `mcp_handler` 里对"一次 tools/call"记一条。batch 会让一条审计覆盖 N 个真实操作——**必须在 batch 内部对每个子操作单独补写 audit**，否则写操作绕过审计（合规回退）。这是本项唯一需要额外接线的点。

### 改动 1：http.rs — dispatch_tool 改 pub
当前第 283 行 `async fn dispatch_tool(...)` → `pub async fn dispatch_tool(...)`，供 batch 模块调用。

### 改动 2：tools/mod.rs — 注册模块
```rust
pub mod batch;   // 新增（按字母序插在 analyze_file 之后）
```

### 改动 3：新增 tools/batch.rs

```rust
use std::sync::Arc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::mcp::http::dispatch_tool;

#[derive(Deserialize)]
pub struct BatchArgs {
    pub operations: Vec<BatchOp>,
    #[serde(default = "default_true")]
    pub stop_on_error: bool,
}

#[derive(Deserialize)]
pub struct BatchOp {
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
}

fn default_true() -> bool { true }

pub async fn handle(args: BatchArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let mut results = Vec::with_capacity(args.operations.len());

    for (idx, op) in args.operations.into_iter().enumerate() {
        // 禁止嵌套 batch：防递归炸栈 / 审计黑洞
        if op.tool == "batch" {
            return Err(format!("operation[{idx}]: nested batch is not allowed"));
        }

        // 复用现有分发 = 复用全部安全校验（只读模式 / WRITE_TOOLS / 路径白名单）
        let res = dispatch_tool(&op.tool, op.arguments.clone(), state).await;

        // 逐子操作补审计（batch 外层那条不够细，写操作必须单独留痕）
        let audit_enabled = state.config.read().await.audit_enabled;
        if audit_enabled {
            let entry = match &res {
                Ok(_)  => crate::audit::new_entry(&op.tool, &op.arguments.to_string(), true,  None, None, None),
                Err(e) => crate::audit::new_entry(&op.tool, &op.arguments.to_string(), false, Some(e.clone()), None, None),
            };
            crate::audit::write_audit_log(&state.data_dir, &entry).ok();
        }

        match res {
            Ok(v) => results.push(json!({ "index": idx, "tool": op.tool, "ok": true, "result": v })),
            Err(e) => {
                results.push(json!({ "index": idx, "tool": op.tool, "ok": false, "error": e }));
                if args.stop_on_error {
                    break; // 已完成的结果照常返回，调用方能看到断点
                }
            }
        }
    }

    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string(&results).unwrap_or_default() }] }))
}
```

> 说明：
> - `dispatch_tool` 是 `async` 且被 `async fn` 递归调用——本实现是**循环内 await**，不是函数自递归，无需 `Box::pin`。
> - 子操作的 audit 里 `source_ip` / `elapsed` 传 `None`（batch 外层已记来源与总耗时）；如需精确到子操作耗时，可在循环内包一层 `Instant`，属可选增强。

### 改动 4：http.rs — dispatch_tool 加分支
在 `match name` 里加（注意：**batch 不进 WRITE_TOOLS**，其写权限由内部子操作各自判定；只读模式下子写操作会被 dispatch_tool 自身拒绝）：

```rust
"batch" => {
    let parsed: tools::batch::BatchArgs =
        serde_json::from_value(args).map_err(|e| e.to_string())?;
    tools::batch::handle(parsed, state).await
}
```

### 改动 5：http.rs — get_tool_definitions 加定义
tool description 要**主动引导模型合并调用**（这是收益能否兑现的关键）：

```json
{
    "name": "batch",
    "description": "Run multiple cc-bridge tool calls in ONE round trip. Prefer this whenever you need several file operations together (e.g. read many files then edit several, or search then read matches) — it collapses N network round trips into 1, which is the single biggest latency win over a remote link. Each operation reuses the same security checks as calling the tool directly (read-only mode, path whitelist). Nested batch is not allowed.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "operations": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "tool": { "type": "string", "description": "Any cc-bridge tool name except 'batch'" },
                        "arguments": { "type": "object", "description": "That tool's arguments object" }
                    },
                    "required": ["tool", "arguments"]
                }
            },
            "stopOnError": { "type": "boolean", "default": true, "description": "Stop at first failing op (still returns completed results). false = run all, report each." }
        },
        "required": ["operations"]
    }
}
```

> `stopOnError` 用 camelCase 对齐其他工具的入参风格（如 `maxDepth`/`replaceAll`）；Rust 侧 `BatchArgs` 用 `#[serde(rename = "stopOnError")]` 或 `#[serde(rename_all = "camelCase")]` 接住。上面结构体示例请补 rename。

### 验证
1. `cargo test --lib` 全绿（现有 52 passed 不回退）。
2. 新增单测：
   - batch 里混合 `read_files` + `list_directory`，断言返回两条 ok 结果。
   - batch 里塞一个越权路径的 read，断言该项 `ok=false` 且 error 是路径校验信息（证明复用了安全校验）。
   - 只读模式下 batch 里塞 `write_files`，断言该项被拒（证明 WRITE_TOOLS 拦截仍生效）。
   - batch 里塞 `{"tool":"batch"}`，断言整体报 "nested batch not allowed"。
   - `stopOnError=true` 时第 2 项失败，断言第 3 项未执行、结果只有 2 条。
3. 审计核对：batch 跑 3 个写操作后，`audit.log` 里应出现 3 条子操作记录（+ 外层那条）。

### 回滚
删 batch.rs、移除 mod.rs 一行、http.rs 三处分支/定义、dispatch_tool 改回私有。无状态。

---

## 建议执行顺序
1. **O1 结构化耗时拆解先落地**（清单里仍是 ⬜）——建立"网络/传输/读写"基线，否则无法量化收益。
2. **① gzip**（含 read_files 紧凑 JSON）——纯服务端、确定生效，先拿这份确定收益。
3. **② batch**——配套 description 引导；上线后用 O1 数据看模型实际调用率 + 往返下降幅度。

## 待确认（动手前）
- [ ] gzip：部署前实测 Claude Code 客户端确发 `accept-encoding: gzip`（高置信度会发）。
- [ ] batch：`BatchArgs` 的 camelCase rename 补全（`stopOnError`）。
- [ ] 是否需要子操作级耗时（可选增强，默认不做）。
