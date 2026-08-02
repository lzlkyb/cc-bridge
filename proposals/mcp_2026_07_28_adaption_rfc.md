# MCP 2026-07-28 协议适配 · RFC

> 状态：📝 待评审（未动代码）
> 基线：cc-bridge v2.3.18 · 当前实现协议版本 `2025-06-18`（回显式）
> 规范来源：<https://modelcontextprotocol.io/specification/2026-07-28/changelog>（已逐条核对原文，非记忆）
> 约束：CLAUDE.md 规则 1（先方案后动手）、规则 7（`cargo fmt` + `cargo clippy --no-default-features`）、规则 10（改 Rust 必须重启 dev）、安全模块不放松、安装包 ≤20MB

---

## 0. 一句话结论

**cc-bridge 运气极好：新协议最大的破坏性变更（去掉 session、去掉 `initialize` 握手、彻底无状态）我们早就是这样实现的，零成本命中。**

真正要补的是「协议门面」——版本协商、`server/discover`、`resultType`、缓存提示、标准请求头。全部是 **可加、可回退、不改任何工具逻辑** 的表层改动。

| Phase | 内容 | 成本 | 破坏性 | 建议 |
|---|---|---|---|---|
| **1** | 版本协商 + `server/discover` + `resultType` + 缓存提示 + 标准头校验 | 中低（~250 行，集中在 `http.rs`） | 无（双时代同端点） | ✅ 做 |
| **2** | 废弃 `sse.rs`（HTTP+SSE 传输已被规范列为 Deprecated） | 低（删代码 + 配置迁移） | 有（Connect 页命令生成） | ⚠️ 走 12 个月窗口，先降级不删 |
| **3** | MRTR 危险命令确认 + `subscriptions/listen` 文件变更推送 | 高 | 无（纯新增） | 🔭 择机，MRTR 优先 |

**关键修正**：我之前口头说 `UnsupportedProtocolVersionError` 是 `-32602` —— **错了**。这一版专门重新编号了错误码，正确值是 **`-32022`**。详见 §1.3。

---

## 1. 新协议关键变更（规范原文核对）

### 1.1 破坏性变更（Major changes 共 9 条）

| # | 变更 | 对 cc-bridge 的影响 |
|---|---|---|
| 1 | 移除协议级 session 与 `Mcp-Session-Id` 头；list 类方法不再随连接变化 | **零影响**：我们 HTTP 通道从来没有 session |
| 2 | 协议彻底无状态：**移除 `initialize` / `notifications/initialized` 握手**；每个请求在 `_meta` 里携带 `io.modelcontextprotocol/protocolVersion`、`clientCapabilities`、`clientInfo` | **零影响**（现状），但需**新增** `_meta` 解析 |
| 3 | 新增 `server/discover`，服务器 **MUST** 实现 | **需新增**（约 30 行） |
| 4 | GET 端点与 `resources/subscribe` 被 `subscriptions/listen` 取代 | 我们无 resources，暂不涉及；Phase 3 可用 |
| 5 | 移除 `ping` / `logging/setLevel` / `notifications/roots/list_changed` | **零影响**：我们本来就没实现（走 `-32601`） |
| 6 | tasks 移出核心，变成 `io.modelcontextprotocol/tasks` 扩展 | 无影响 |
| 7 | **MRTR**：服务端返回 `resultType: "input_required"` + `inputRequests`，客户端带 `inputResponses` 重试原请求 | Phase 3 机会点 |
| 8 | **所有 result 必须带 `resultType`**（`"complete"` / `"input_required"`）；客户端 **MUST** 把旧服务器缺失该字段视为 `"complete"` | **需新增**，但因为有这条兜底规则，**加不加都不会挂**，加了更规范 |
| 9 | 移除 SSE 断点续传（`Last-Event-ID`、事件 ID） | 我们没实现续传，零影响 |

### 1.2 次要变更中与我们相关的 4 条

- **`tools/list` SHOULD 返回确定性顺序**（提升客户端缓存与 LLM prompt cache 命中率）。
- **标准请求头**：`Mcp-Method`（所有请求必填，值 = body 的 `method`）、`Mcp-Name`（`tools/call` 必填，值 = `params.name`）。
- **`CacheableResult`**：`tools/list` 等列表结果 **要求** 带 `ttlMs`（毫秒新鲜度提示）与 `cacheScope`（`"public"` / `"private"`）。
- **`inputSchema` 放宽**到任意 JSON Schema 2020-12 关键字 —— 我们现有 schema 是子集，天然合法。

### 1.3 错误码重新编号（⚠️ 必须按新值实现）

规范对 JSON-RPC server-error 区间做了划分：`-32000`~`-32019` 留给实现自定义，`-32020`~`-32099` 归规范所有。本版新错误码相应改号：

| 错误 | 旧号（草案） | **正式号** |
|---|---|---|
| `HeaderMismatchError` | -32001 | **-32020** |
| `MissingRequiredClientCapability` | -32003 | **-32021** |
| `UnsupportedProtocolVersionError` | -32004 | **-32022** |

另外 resource not found 从 `-32002` 改为 `-32602`（我们无 resources，不涉及）。

`UnsupportedProtocolVersionError` 的规范原文形状：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version",
    "data": { "supported": ["2026-07-28", "2025-11-25"], "requested": "1900-01-01" }
  }
}
```

### 1.4 弃用清单（12 个月最短窗口）

- **HTTP+SSE 传输**（自 `2025-03-26` 起弃用）正式进入 Deprecated 状态 → 直接关系到我们的 `sse.rs`。
- **Roots / Sampling / Logging** 三个特性整体弃用 → 我们都没实现，反而省事；也意味着 Phase 3 **不要**去做 `roots/list`。

---

## 2. cc-bridge 现状核对（已读真实代码，附 file:line）

| 位置 | 现状 | 与新协议的差距 |
|---|---|---|
| `mcp/http.rs:25-47` `build_router` | `/health` GET、`/mcp` POST、`/mcp/sse` GET、`/mcp/messages` POST | GET 流端点已被规范移除；新协议要求对 MCP 端点的 GET 返回 `405` |
| `mcp/http.rs:249` | `let method = body.get("method")...` 直接分发 | 无 `_meta` 解析、无版本校验 |
| `mcp/http.rs:252-278` `"initialize"` | **回显客户端版本**，默认 `2025-06-18`；带 ~1.2KB 中文 `instructions` | 新协议不再有 `initialize`；`instructions` 需要一个新家 → `server/discover` |
| `mcp/http.rs:279-282` `"notifications/initialized"` | 返回 `{"jsonrpc":"2.0","id":null}` JSON 体 | 通知按规范应返回 `202 Accepted` 空体（现状不致命） |
| `mcp/http.rs:283-291` `"tools/list"` | 按 `shell_type` 动态生成描述 | 缺 `resultType` / `ttlMs` / `cacheScope`；顺序未显式保证 |
| `mcp/http.rs:292` `"tools/call"` | 直接进 `handle_tools_call`，**无握手前置检查** | ✅ 正是新协议想要的无状态语义；缺 `resultType` |
| `mcp/http.rs:293-297` | 未知方法 → `-32601` | `server/discover` 目前会落到这里（不合规） |
| `mcp/http.rs:124` `rate_limit_key` | **刻意忽略所有 header**，只用 TCP peer IP（D1 安全修复，有 3 个测试守着 `http.rs:558/575/583`） | 🔒 新增头处理**绝不能**破坏这条 |
| `mcp/registry.rs:27` `ToolRunner` | `fn(Value, &Arc<AppState>) -> BoxFuture<Result<Value, String>>` —— **二态** | MRTR 需要第三态 `input_required` |
| `mcp/registry.rs` `all_tools()` | 17 个工具按字面量顺序（确定性靠巧合，无 sort/断言） | 需要显式保证确定性 |
| `mcp/sse.rs` | sessionId 走 query param；`/mcp/messages` **不校验 token**；默认 `protocolVersion` = `2025-06-18`（`sse.rs:168`）；注释自认「无真正流式推送」 | 传输已弃用 + 存在弱鉴权面 |
| `config.rs:41,101,197-202,352` | `transport: String`，默认 `"http"`，可选 `"sse"` | Phase 2 需要迁移路径 |

---

## 3. 兼容策略：同一 `/mcp` 端点的「双时代服务器」

**这不是我拍脑袋的方案 —— 规范明确背书**（Versioning 页原文）：

> A dual-era server **MAY** serve both eras concurrently on the same endpoint or process.
> - A request carrying modern per-request `_meta` is served statelessly according to this revision.
> - An `initialize` request selects legacy semantics.

### 判定规则（单一入口，`mcp_handler` 开头）

```
现代请求 ⟺ params._meta["io.modelcontextprotocol/protocolVersion"] 存在
           或 MCP-Protocol-Version 头存在
           或 method == "server/discover"
否则 ⟹ 走既有 legacy 分支（initialize 继续回显，一行不改）
```

**为什么用 `_meta` 而不是只看头**：stdio 无头；且我们未来若接 rmcp 也能复用同一判定。

### 兼容矩阵（对照规范的 Compatibility Matrix）

| 客户端 | cc-bridge（改造后 = Dual-era） | 结果 |
|---|---|---|
| Legacy（现网 Claude Code） | 走 `initialize` 分支 | ✅ **一切照旧，零回归** |
| Modern（新版 CC） | 走 `_meta` 分支 | ✅ 合规 |
| Modern 但版本不匹配 | 返回 `-32022` + `supported` 列表 | ✅ 客户端可自动降级重试 |

**关键收益**：现网所有用户的 Claude Code **不需要升级**，改造对他们完全无感。

---

## 4. Phase 1 · diff 级方案（建议本轮实施）

### 4.1 新增常量与 `_meta` 提取（`http.rs` 顶部）

```rust
/// 本服务支持的协议版本，新→旧排列。
/// 2026-07-28：现代（无握手、per-request _meta）
/// 2025-11-25 / 2025-06-18 / 2025-03-26：legacy（initialize 握手），我们只实现
/// tools/list + tools/call，这些方法在各 legacy 版本行为一致，故可一并声明支持。
const SUPPORTED_VERSIONS: &[&str] = &["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const MODERN_VERSION: &str = "2026-07-28";

const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// 从 params._meta 取协议版本。返回 None 表示 legacy 请求。
fn request_protocol_version(body: &serde_json::Value) -> Option<&str> {
    body.pointer("/params/_meta")
        .and_then(|m| m.get(META_PROTOCOL_VERSION))
        .and_then(|v| v.as_str())
}

fn unsupported_version_error(id: Option<&serde_json::Value>, requested: &str) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32022,
            "message": "Unsupported protocol version",
            "data": { "supported": SUPPORTED_VERSIONS, "requested": requested }
        }
    })
}
```

### 4.2 `mcp_handler` 入口分流（改 `http.rs:249` 附近）

```rust
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");

    // ── 现代请求判定（规范允许 dual-era 同端点共存）────────────────
    let modern_version = request_protocol_version(&body);
    let is_modern = modern_version.is_some() || method == "server/discover";

    if let Some(v) = modern_version {
        if !SUPPORTED_VERSIONS.contains(&v) {
            // 规范要求 HTTP 400 + -32022，客户端据此挑一个双方都支持的版本重试
            return (StatusCode::BAD_REQUEST, Json(unsupported_version_error(body.get("id"), v)))
                .into_response();
        }
    }
```

> ⚠️ 返回类型要从 `impl IntoResponse` 的 `Json<Value>` 统一成 `Response`，因为现在需要控制 HTTP status（400 / 202）。这是 Phase 1 里唯一有点侵入性的改动，`.into_response()` 逐分支加即可。

### 4.3 新增 `server/discover`（`instructions` 的新家）

```rust
        "server/discover" => Json(json!({
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "result": {
                "resultType": "complete",
                "supportedVersions": SUPPORTED_VERSIONS,
                "capabilities": { "tools": { "listChanged": false } },
                "_meta": {
                    META_SERVER_INFO: {
                        "name": "cc-bridge",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                },
                "instructions": server_instructions(),   // 抽出现有 1.2KB 中文文案
                "ttlMs": 3600000,
                "cacheScope": "private"
            }
        })),
```

**配套重构**：把 `http.rs:275` 那段 1.2KB 中文 `instructions` 抽成 `fn server_instructions() -> &'static str`，`initialize` 与 `server/discover` **共用同一份**，杜绝两处文案漂移。

**为什么 `cacheScope: "private"`**：这段文案描述的是**这台机器**的白名单与 shell 语义，不该被共享中间层缓存后发给别人。

### 4.4 `tools/list` 补 `resultType` + 缓存提示 + 确定性顺序

```rust
        "tools/list" => {
            let shell_type = state.config.read().await.shell_type.clone();
            Json(json!({
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "result": {
                    "resultType": "complete",
                    "tools": get_tool_definitions(&shell_type),
                    // shell_type / read-only 开关会改描述，故短 TTL + private
                    "ttlMs": 60000,
                    "cacheScope": "private"
                }
            }))
        }
```

**确定性顺序**：`registry.rs` 的 `all_tools()` 目前靠字面量顺序「碰巧确定」。加一个测试钉死即可，**不要**改成按名字排序（会打乱现有的语义分组，反而降低 prompt 可读性）：

```rust
#[test]
fn tool_order_is_deterministic() {
    let a: Vec<_> = all_tools().iter().map(|t| t.name).collect();
    let b: Vec<_> = all_tools().iter().map(|t| t.name).collect();
    assert_eq!(a, b);
    assert_eq!(a[0], "read_files"); // 顺序变更需显式改测试
}
```

### 4.5 `tools/call` 结果补 `resultType`

在 `handle_tools_call`（`http.rs:317`）构造 result 处加 `"resultType": "complete"`。

**风险评估：零。** 规范第 8 条明确要求客户端把缺失该字段的旧服务器结果当作 `"complete"`，反过来 legacy 客户端遇到多出来的字段按 JSON 惯例忽略。所以**无条件加**，不需要按 era 分支。

### 4.6 标准请求头：只校验，不路由（🔒 安全红线）

规范要求现代请求必带 `Mcp-Method`、`Mcp-Name`、`MCP-Protocol-Version`，不一致返回 `400` + `-32020`。

**我的强烈建议 —— 分发永远以 body 为准，header 只做一致性校验：**

```rust
// ✅ 正确：body 是唯一真源，header 仅校验
if let Some(h) = headers.get("mcp-method").and_then(|v| v.to_str().ok()) {
    if h != method { return header_mismatch(body.get("id"), "Mcp-Method", h, method); }
}

// ❌ 绝对禁止：let method = headers.get("mcp-method")...
```

理由：这些头是给反向代理/网关做路由用的，**天然可被伪造**。若拿它决定执行哪个工具，等于把 `run_command` 的分发权交给一个未鉴权的头 —— 会直接掀翻我们的安全模型。同理，`rate_limit_key`（`http.rs:124`）**继续忽略所有 header**，D1 修复与它的 3 个测试（`http.rs:558/575/583`）一行都不动。

**宽松度选择**：规范说缺头 MUST 拒绝，但我建议**只在头存在且与 body 不符时才报 `-32020`，缺头放行**。因为我们是 dual-era 服务器，严格拒绝会误伤 legacy 客户端，而规范本身也允许「支持早期客户端的服务器」对缺头请求作宽松处理。

### 4.7 Phase 1 改动清单汇总

| 文件 | 改动 | 约行数 |
|---|---|---|
| `mcp/http.rs` | 常量 + `_meta` 解析 + 版本校验 + `server/discover` + `resultType` ×2 + 头校验 + `instructions` 抽函数 + 返回类型改 `Response` | ~200 |
| `mcp/registry.rs` | 顺序确定性测试 | ~10 |
| `mcp/http.rs` (tests) | 新增：`-32022` 版本拒绝、`server/discover` 形状、`resultType` 存在性、legacy `initialize` 不回归、头不匹配 `-32020`、头缺失放行 | ~120 |
| `README.md` | 协议版本说明表 | ~5 |

**零新依赖，二进制体积增量 ≈ 0**（纯 JSON 文本与分支）。

---

## 5. Phase 2 · `sse.rs` 何去何从

### 现状问题（不只是「过时」）

1. HTTP+SSE 传输已被规范正式列为 **Deprecated**，新实现不应采用。
2. `sse.rs` 的 `/mcp/messages` 端点 **不校验 token** —— 这是当前代码里最值得注意的一处弱鉴权面。
3. 注释自认「无真正流式推送」，即这条通道**并没有提供 HTTP 通道之外的任何能力**。
4. 新协议要求 MCP 端点的 GET 返回 `405 Method Not Allowed`，与 `/mcp/sse` GET 语义冲突（虽然路径不同，但会让探测型客户端困惑）。

### 三个选项

| 方案 | 动作 | 优点 | 缺点 |
|---|---|---|---|
| **A · 立即删** | 删 `sse.rs`、删路由、`config.transport` 只留 `http` | 最干净，去掉弱鉴权面 | 破坏已配置 `sse` 的存量用户 |
| **B · 先补洞再降级**（推荐） | ① 给 `/mcp/messages` 加与 `/mcp` 相同的 token 校验；② 设置页把 `sse` 选项标「已弃用」并默认不可选；③ CHANGELOG 公告 12 个月移除窗口 | 立即消除安全面，零破坏 | 代码多留一段时间 |
| **C · 不动** | — | 零成本 | 弱鉴权面留着，且越拖越难删 |

**建议 B**。其中「① 补 token 校验」可以**脱离本 RFC 单独先做**，属于纯安全修复，成本约 10 行。

> ⚠️ 触点提醒：`config.transport` 直接驱动 **Connect 页的命令生成**（`claude mcp add` 那串）。改选项前必须同步核对 Connect 页与托盘「复制 IP」的生成逻辑，避免出现「配置说 sse、命令生成 http」的错位。

---

## 6. Phase 3 · 新协议带来的真正新能力

### 6.1 MRTR：危险命令的「协议原生确认」（高价值）

**今天的痛点**：远程 CC 让 cc-bridge 跑一条命中危险名单的命令 → 我们返回一个错误字符串 → 模型只能靠猜或让远端用户重新表述。确认这件事**没有协议位置**。

**MRTR 之后**：

```json
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "resultType": "input_required",
    "inputRequests": [{
      "method": "elicitation/create",
      "params": {
        "message": "即将在本机执行高风险命令：\n  rm -rf D:\\build\n该命令命中危险名单，请确认。",
        "requestedSchema": { "type": "object", "properties": { "confirm": { "type": "boolean" } }, "required": ["confirm"] }
      }
    }],
    "requestState": "cc-bridge:pending:9f2a…"
  }
}
```

客户端弹确认 UI → 用户勾选 → **带 `inputResponses` 重试同一个 `tools/call`** → 我们凭 `requestState` 认出这是已确认的重放，放行执行。

**价值定位**（说清楚边界）：这提供的是**远端**确认 UI，和我们本机 Tauri 侧的确认是**互补**而非替代 —— 远端确认解决「模型不该替用户拍板」，本机确认解决「机主对本机有最终否决权」。两者叠加才是完整模型。

**实现关键 —— 不要动 `ToolRunner` 签名**：

`registry.rs:27` 的 `ToolRunner` 是二态 `Result<Value, String>`。改成三态枚举要动全部 17 个工具，成本极高。

**推荐做法**：保持签名不变，让需要确认的工具（目前只有 `run_command`）在 `Ok(Value)` 里返回一个哨兵字段，由 `http.rs` 在出口处翻译成 MRTR 响应：

```rust
// run_command 内部
Ok(json!({ "__mcp_input_required": { "message": ..., "requestState": ... } }))
```

→ 16 个工具零改动，新增面收敛在 `http.rs` 一处 + `run_command` 一处。这条建议是本 RFC 里我最有把握的工程判断。

**`requestState` 的安全设计**（别在这里开洞）：
- 必须是**服务端生成**的随机 token，不能让客户端自己编一个「已确认」；
- 必须绑定「命令原文哈希 + 生成时刻」，防止「确认 A 命令、重放执行 B 命令」；
- 必须有短 TTL（建议 60s）与一次性消费，可以直接复用现有的后台命令注册表回收机制（5 分钟自动回收那套已实现的基础设施）。

### 6.2 `subscriptions/listen`：文件变更推送（中价值，有坑）

可以让远程 CC 订阅「白名单目录下文件变更」，不必轮询。但有两个硬约束必须先解决：

1. **并发预算**：`http.rs:45` 的 `ConcurrencyLimitLayer::new(256)` 是**全局**的。长活 listen 流会一直占着 permit，几十个订阅就能把普通 `tools/call` 饿死。必须把长活流排除在这层之外，或给它单独的配额。
2. **压缩层**：`CompressionLayer`（`http.rs:44`）对长活 SSE 流会造成缓冲/延迟，需要按 content-type 跳过。

**结论**：价值真实但不紧急，且我们没有 resources 概念，`toolsListChanged` 对固定 17 工具意义不大。**建议排在 MRTR 之后**。

### 6.3 明确「不做」的事

| 特性 | 为什么不做 |
|---|---|
| Roots | 规范已弃用；我们的 `list_allowed_roots` 工具是更好的替代 |
| Sampling | 规范已弃用 |
| Logging（`logging/setLevel`） | 规范已移除该方法；我们有自己的审计日志 |
| Tasks 扩展 | 我们的后台命令注册表已覆盖同类需求，重复投入 |
| `structuredContent` 大改造 | 现有 text content 工作良好，ROI 低 |

---

## 7. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 返回类型从 `Json<Value>` 改 `Response` 触及所有分支 | 中 | 一次性机械改造 + 现有 ~40 个 `tools/call` 集成测试全跑一遍兜底 |
| 头校验误伤 legacy 客户端 | 中 | §4.6 采用「有头才校验、缺头放行」的宽松策略 |
| `SUPPORTED_VERSIONS` 声明过宽（宣称支持却未验证的 legacy 版本） | 低 | 我们只实现 `tools/list` + `tools/call`，这两个方法跨 legacy 版本行为一致；沿用现有回显策略的同款理由 |
| `Mcp-Name` 头被误用于分发 | **高**（若做错） | §4.6 已定死红线 + 加一条断言测试 |
| 规范后续再变 | 低 | `SUPPORTED_VERSIONS` 是单一常量，加版本只改一行 |

---

## 8. 验收清单

- [ ] `cargo fmt` 干净
- [ ] `cargo clippy --no-default-features` 零告警（规则 7，必须带 flag）
- [ ] `cargo test --no-default-features` 全绿，**尤其现有 `initialize` 回显测试（`http.rs:811-816`）不得回归**
- [ ] 新增测试：`-32022` / `server/discover` 形状 / `resultType` 存在 / `-32020` 头不匹配 / 缺头放行 / 工具顺序确定
- [ ] 真机验证：现网版 Claude Code（legacy）连接后 `tools/list` + 一次 `read_files` 正常
- [ ] `curl` 手工验证一条现代请求（带 `_meta` + 三个标准头）
- [ ] 二进制体积无明显增长（预算 ≤20MB）
- [ ] README 协议版本表更新

---

## 9. 建议的落地顺序

1. **先单独做**：`/mcp/messages` 补 token 校验（纯安全，~10 行，可独立 commit）
2. **Phase 1**：协议门面适配，一个 `feat:` commit
3. **Phase 2-B**：SSE 标弃用 + CHANGELOG 公告窗口
4. **Phase 3**：MRTR（先）→ `subscriptions/listen`（后）

按规则 5，以上均等待你确认后再动手；也请确认 Phase 1 的范围是否要按 §4.7 全量做，还是先只做 §4.1-4.5（不含头校验）作为最小集。
