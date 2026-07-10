# 性能优化可行性调研：响应 gzip 压缩 + 跨类型 batch 工具

> 调研结论（2026-07-10）。背景：此前 `search_files` 并行化（P6-1）已吃掉服务端 ~75% 墙钟，瓶颈从"服务端慢"转为"网络往返数 × 局域网延迟 + 响应体体积"。本次调研两项针对性优化的**可行性**，不涉及实现。

## TL;DR

| 项 | 能做？ | 风险 | 生效确定性 | 改动量 |
|---|---|---|---|---|
| ① 响应 gzip 压缩 | ✅ 能 | 低 | **确定**（纯服务端） | 极小（Cargo + 1 层） |
| ② 跨类型 batch 工具 | ✅ 能 | 低（复用现有护栏，零新攻击面） | **取决于客户端是否采用** | 小（新工具 + 复用 dispatch） |

---

## 一、响应 gzip 压缩

### 现状证据
- `Cargo.toml:21` → `tower-http = { version = "0.6", features = ["limit"] }`，**未开 `compression`**。
- `mcp/http.rs` → axum `Router`，`/mcp` 走 `post(mcp_handler)`，响应用 `axum::Json(...)`（即 `axum::body::Body`）。
- 传输层 = MCP Streamable HTTP（POST `/mcp`）。Claude Code 是 Node 应用，MCP TypeScript SDK 的 `StreamableHTTPClientTransport` 用全局 `fetch`（底层 undici）。
- undici 的 `fetch` **默认自动带 `Accept-Encoding: gzip, deflate, br` 并透明解压**——Node 标准行为，客户端零改动。

### 能否做：能
- 服务端加 `CompressionLayer` 后，只要请求头带 `Accept-Encoding: gzip`，tower-http 会对 `application/json` 响应体（默认判定为可压缩类型）gzip 后回传，客户端 undici 自动解压。
- 这是标准 HTTP 内容编码，不触碰 MCP 协议语义。源码文本压缩率 5–10×，`read_files` 回传代码体直接砍掉一大截线缆时间。

### 改动量（极小）
- `Cargo.toml`：`features = ["limit", "compression"]`
- `http.rs`：在 router 最外层加 `.layer(tower_http::compression::CompressionLayer::new())`，位置在 `auth_middleware` **之前**（确保压缩到最终响应）。
  - 层顺序（外→内）：`CompressionLayer` → `auth_middleware` → `RequestBodyLimitLayer` → handler。
  - 说明：`CompressionLayer` 虽也会"解压入站请求体"，但客户端不会发压缩请求，属 no-op；对 401/429 等小响应因低于阈值/不可压缩类型不压缩，无副作用。

### 风险与唯一需确认点
- 风险：低。
- ⚠️ **唯一待验证**：实测确认 Claude Code 的 HTTP 客户端确实发送 `Accept-Encoding`。
  - 验证法（5 分钟，不动业务逻辑）：在 `mcp_handler` 入口临时 `log::info!("headers: {:?}", req.headers())`，用真实 Claude Code 跑一次 `tools/call`，看日志里有没有 `accept-encoding`。确认后删掉日志再提交。
  - 高置信度会发（undici 默认行为），但不实测不提交。

### 顺手零成本优化
- `read_files.rs:68` 用 `serde_json::to_string_pretty`——改 `to_string`（紧凑 JSON）再缩 ~15–25% 体积且略快。同法检查 `write_files`/`edit_files` 回传是否也 pretty-print。

---

## 二、跨类型 batch 工具

### 现状证据
- `dispatch_tool`（`mcp/http.rs:283`）是统一入口：先查 `WRITE_TOOLS` 做只读拦截，再按 `name` match 到各 handler（`tools::X::handle(parsed, state)`）。
- 每个 handler 签名统一：`async fn handle(args: XxxArgs, state: &Arc<AppState>) -> Result<Value, String>`。
- **路径安全在 handler 内部**：`read_files.rs:80`、`edit_files.rs:72`、`write_files.rs:51`、`search_files.rs:82` 等均调用 `security::path::resolve_safe_path(...)` + `assert_extension_allowed` + 文件大小校验。
- `run_command` 由 `shell_enabled` + `readonly_mode` 双重护栏（已在 `WRITE_TOOLS`）。
- 现有 `read_files`/`write_files`/`edit_files` 已支持**同类型数组**入参（一次调用读/写/改多个）——batch 新增的是**跨类型合并**（读→搜→改→读压成 1 次往返）。

### 能否做：能，且极干净
- 新增 `batch` 工具，入参 `operations: [{ "tool": <name>, "args": <object> }]` 数组。
- handler 内对每个 op 直接调用现有 `dispatch_tool(op_tool, op_args, state)`（将 `dispatch_tool` 改为 `pub`，或抽到 `tools/dispatch.rs`）：
  - ✅ 复用只读模式检查、`WRITE_TOOLS` 拦截、Shell 开关、路径白名单、扩展名/大小校验——**零新攻击面**。
  - ✅ 无需重写任何 handler 逻辑，只是"在一个 HTTP 往返里串起多次派发"。
- MCP 协议允许任意 JSON schema 工具，batch 完全合法。

### 设计要点
- **结果格式**：每个 op 返回 `{ tool, ok, content/error }`，batch 聚合为数组回传（一个 `content[].text` 内放 JSON），Claude 可解析。
- **错误处理**：默认"逐 op 报告、不整批中止"（某 read 失败不影响其余）；可选 `abortOnError` 提前停。
- **v1 放开范围**：允许全部现有工具（`dispatch_tool` 既有护栏已覆盖危险项）；`run_command` 的后台 handle 仍可跨 batch 调用轮询（handle 在 `AppState` 注册表，进程内共享）。
- **审计/限流**：batch 是 1 次 `tools/call` = 1 条审计 + 1 次限流计数；建议 batch handler 内对每个子 op 也单独写审计（或至少外层记一条含子 op 数的汇总），保持可观测。

### ⚠️ 关键前提：收益取决于 Claude Code 是否采用
- batch 把"N 次往返"压成"1 次"。但 Claude Code 的工具调用由模型决策，**不会自动合并**自己的调用。体感收益只有在 Claude 真的用 `batch`（如"读这 8 个文件 + 搜 1 处 + 改 3 处"→ 一次 batch 调用）时才兑现。
- 促成手段：
  1. `batch` 工具描述里明确要求"多文件读/写/搜请优先用 batch"；
  2. 在 `list_allowed_roots` 返回或 `serverInfo` 注入一条使用提示；
  3. 看真实 `audit.log`：若 agentic 循环天然出现"一次连发多读/多改"，batch 命中率高。
- 若想**不依赖客户端**确定性拿收益，需在 Linux 端放轻量 sidecar 代理合并请求（早期 Tier C-8），架构更重，一般不必——batch 已够。

---

## 三、建议落地顺序
1. **先 ① gzip**：确定性、零风险、立刻见效，且为 batch 的大响应体进一步减负。
2. **再 ② batch**：需配套 tool description 引导才能发挥；先小范围观察 audit.log 命中率。
3. 两者都建议**先落地 O1 结构化耗时拆解**，用真实数据确认收益（避免再靠猜——这是上次误判的教训）。

## 附：不在本次范围（已确认无需做）
- 目录缓存、大文件流式返回：边际收益，保持不做。
- 审计/备份异步化：真实数据看 ROI 已低（占 ~3% 且本身快），改作"合规正确性修复"另行排期，不计入提速主线。
