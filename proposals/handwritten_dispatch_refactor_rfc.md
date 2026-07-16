# RFC：手写 dispatch 折中重构（注册表 + Schema 自动派生）

> 状态：**已实施**（2026-07-14 起，`registry.rs`/`http.rs` 已按本方案落地，CLAUDE.md 规则 7 已同步更新；本文档保留作为设计记录）
> 关联：`proposals/session_cwd_persistence_rfc.md`、CLAUDE.md 规则 7（三件套）/ 规则 8（二进制体积）/ 规则 7 安全红线
> 目标读者：维护者（非用户可见功能）

---

## 1. 背景与动机

当前 17 个 MCP 工具采用「手写三件套」模式（CLAUDE.md 规则 7 已固化）。实测代码规模：

| 位置 | 行数 | 内容 |
|------|------|------|
| `mcp/tools/mod.rs:1-17` | 17 行 | `pub mod xxx;` 声明（17 个） |
| `mcp/http.rs:436-522` `dispatch_tool` 的 `match` | ~87 行 | 17 个**逐字相同**的 match 臂：`from_value::<XxxArgs>` + `handle(parsed, state)` |
| `mcp/http.rs:526-779` `get_tool_definitions` | ~254 行 | 17 段手写 `json!` 描述 input_schema |
| `mcp/http.rs:417-435` | ~19 行 | `WRITE_TOOLS` 常量 + 只读闸门（保留，不重构） |

**核心痛点不是「样板多」，而是「同一份信息在 3 处重复维护」：**

1. `XxxArgs` 结构体字段（`mcp/tools/*.rs`，已强类型 + `#[serde(rename/default)]`）
2. `dispatch_tool` 的 match 臂（把字段名重新 `from_value` 一次）
3. `get_tool_definitions` 的 `json!` schema（把字段名/类型/必填**再手写一遍**）

第 3 处与第 1 处**双重维护**，是真正的浪费源（~254 行），且存在**隐性漂移 bug 类**：在 `XxxArgs` 增删字段后若漏改 `get_tool_definitions`，客户端拿到的 schema 会缺字段/多字段，而编译器和测试都不会报错（目前 `handle_tools_call` 测试只验 `dispatch_tool` 成功路径，不验 definitions 内容）。`run_command` 新增 `session_id` 时这类风险已出现。

---

## 2. 目标 / 非目标

**目标**
- 加/改一个工具时，dispatch 与 schema 自动跟随，**不再手动维护 match 臂和 json!**。
- 消除第 1、3 处之间的字段漂移，让 schema 永远 = `XxxArgs` 的真实形状。
- 删除 ~250–300 行手写样板（净减）。
- **零行为变化**：`/mcp` 的 `tools/list` 与 `tools/call` 对外输出逐字节等价（除可能的字段顺序/空格，不影响语义）。

**非目标**
- ❌ 不引入 rmcp / 不替换 transport 层（SSE、握手、生命周期全不动）。
- ❌ 不改动任何安全闸门（见 §4.4）。
- ❌ 不为「未来协议兼容」做任何前瞻设计（那是全量 rmcp 的事）。

---

## 3. 现状架构盘点（精确锚点）

```
请求入口 (handle_tools_call, http.rs:269)
 ├─ Bearer 校验        http.rs:151-155   (authorization 头 strip + 常量时间比较)
 ├─ 限流               http.rs:103-188   (按对端 TCP IP 计数)
 └─ dispatch_tool      http.rs:411
      ├─ WRITE_TOOLS 只读闸门  http.rs:417-435   ← 保留原样
      └─ match name { 17 臂 http.rs:436-522 }   ← 重构为注册表查找
           每个臂: from_value::<XxxArgs>(args)?; XxxArgs::handle(parsed, state)

工具定义 (get_tool_definitions, http.rs:526-779)  ← 重构为「遍历注册表」

每个 handler 内部:
   security::path::resolve_safe_path(...)         ← 白名单 canonicalize，在各 handler 内，不动
```

**关键约束（来自实测）**
- `batch.rs:54` 内部 `Box::pin(dispatch_tool(&op.tool, op.arguments.clone(), state)).await` —— **`dispatch_tool` 的公开签名 `(&str, Value, &Arc<AppState>) -> Result<Value,String>` 必须保持不变**，否则 batch 编译断。
- `get_tool_definitions` 是同步 `fn`、无状态依赖（http.rs:242 在 `tools/list` 响应里调用），重构后仍为同步 `fn`。
- 17 个 handler **已强类型**：签名统一为 `pub async fn handle(args: XxxArgs, state: &Arc<AppState>) -> Result<Value, String>`（grep 实证，见 `mcp/tools/*.rs`），参数提取早已 `from_value`，只是入口在 match 臂里重复写。

---

## 4. 设计方案

### 4.1 注册表 + `register_tool!` 宏

新增 `mcp/tools/registry.rs`（或并入 `mod.rs`）：

```rust
// 示意（非最终签名）
pub struct ToolSpec {
    pub name: &'static str,
    pub desc: &'static str,
    pub is_write: bool,
    pub schema: serde_json::Value,                    // 由 §4.2 derive 生成
    pub run: for<'a> fn(                                            // 包装成 boxed future
        serde_json::Value,
        &'a Arc<AppState>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>,
}

// 每个工具文件底部自注册（co-located，与 handler 同文件）
register_tool!(ListDirectoryArgs, "List directory contents...", false);
// 宏展开 ≈ ToolSpec { name:"list_directory", desc, is_write:false,
//                      schema: ListDirectoryArgs::schema(), run: list_directory_run_boxed }
```

为做到「加工具只改 1 处」，宏放在**每个工具文件底部**（与 `handle` 同文件），而非集中列表：
- 新增工具 = 写 `XxxArgs` + `handle` + 文件底部一行 `register_tool!`。
- `mod.rs` 仍需 `pub mod xxx;`（Rust 硬性要求，无法消除），但这是机械声明，不算「逻辑重复」。
- `dispatch_tool` 的 match 与 `get_tool_definitions` 的 json! 整体消失。

> 净效果：**中央 match（87 行）+ 手写 schema（254 行）删除**，替换为 1 个注册表文件 + 每工具 1 行底部宏。逻辑上「加工具从 3 处 → 1 处（handler 内）」。

### 4.2 Schema 自动派生（二选一）

`XxxArgs` 已是 `serde::Deserialize` 且带 `#[serde(rename/default/default="fn")]`，足以反推 JSON Schema。两种实现路径：

| 方案 | 做法 | 体积影响（规则 8） | 复杂度 | 推荐 |
|------|------|------|--------|------|
| **A. 本地 derive 宏** `#[derive(ToolSchema)]` | 自写 ~100–150 行 proc-macro，读 serde 属性（type→json type、`rename`→属性名、`default`/`default="fn"`→非 required + default 值、嵌套 `Vec`/`Option`/struct 递归） | **0 新增依赖** | 中 | ✅ 主推 |
| **B. 依赖 `schemars`** | `derive(Serialize, JsonSchema)`，直接吐 schema | 增加 exe 体积（需实测，可能 +数百 KB） | 低 | 备选（若体积预算允许） |

**推荐 A**：符合规则 8「守二进制体积」红线，且本项目的 `XxxArgs` 类型很简单（String/bool/u32/Option/Vec/嵌套 struct），derive 覆盖成本低。

派生需正确处理的属性（来自实测字段）：
- `list_directory.rs:13` `#[serde(default)] pub recursive: bool` → `required` 不含、类型 boolean
- `list_directory.rs:15-16` `#[serde(default="default_max_depth")] #[serde(rename="maxDepth")]` → 属性名 `maxDepth`、带 default 值、非 required
- `run_command.rs` `session_id: Option<String>` + `#[serde(default, rename="sessionId")]` → 必须尊重 `rename`，否则客户端拿不到 `sessionId`
- `batch.rs` `Vec<BatchOp>` 嵌套 → 派生须递归生成 `items`

### 4.3 改写两个函数（数据驱动）

```rust
// http.rs —— dispatch_tool（签名不变，match → 查找）
pub async fn dispatch_tool(name: &str, args: Value, state: &Arc<AppState>)
    -> Result<Value, String> {
    const WRITE_TOOLS: [&str; 9] = [ /* 原样保留 417-427 */ ];
    if WRITE_TOOLS.contains(&name) { /* 只读闸门原样保留 428-435 */ }
    let spec = registry::all_tools().iter().find(|t| t.name == name)
        .ok_or_else(|| format!("Unknown tool: {name}"))?;
    (spec.run)(args, state).await          // 等价于原 match 臂
}

// http.rs —— get_tool_definitions（手写 json! → 遍历）
fn get_tool_definitions() -> Value {
    registry::all_tools().iter().map(|t| json!({
        "name": t.name,
        "description": t.desc,
        "inputSchema": t.schema,
    })).collect()
}
```

### 4.4 安全闸门零改动确认（规则 7 红线）

| 闸门 | 位置 | 本 RFC 是否触碰 |
|------|------|----------------|
| Bearer 常量时间比较 | http.rs:151-155 | ❌ 不动（在 dispatch 之前） |
| 按对端 IP 限流 | http.rs:103-188 | ❌ 不动 |
| `WRITE_TOOLS` 只读拦截 | http.rs:417-435 | ❌ **原样保留**于 `dispatch_tool` 入口 |
| 白名单 canonicalize + 祖先遍历 | 各 handler 内 `security::path::resolve_safe_path` | ❌ 不动（handler 代码一行不改） |
| 危险命令黑名单 / 审计落盘 | handler 内 + `write_audit_for_call` | ❌ 不动 |

结论：**安全模型无任何削弱路径**，重构范围严格限定于「dispatch 路由 + schema 生成」。

---

## 5. 迁移步骤（机械、可逐工具提交）

1. 新增 `mcp/tools/registry.rs`：`ToolSpec` 结构 + `all_tools()` 返回 `&'static [ToolSpec]` + `register_tool!` 宏（§4.1）。
2. 实现 `ToolSchema` derive（方案 A）或接入 `schemars`（方案 B）。
3. 逐个工具文件：
   - 给 `XxxArgs` 加 `#[derive(ToolSchema)]`；
   - 文件底部加 `register_tool!(XxxArgs, "desc", is_write);`（desc 从 `get_tool_definitions` 原样搬入）。
4. 把 `http.rs` 的 `dispatch_tool` 改为注册表查找（保留 WRITE_TOOLS + 只读闸门原样）。
5. 把 `get_tool_definitions` 改为遍历注册表；删除原 254 行 `json!`。
6. `mod.rs` 不变（`pub mod` 声明保留）。
7. 编译 + `cargo clippy --no-default-features --lib` 零警告 + `cargo test --no-default-features --lib` 全绿。

> 可分批：每迁 1 个工具保持编译通过，或直接一次性替换两函数（因 `register_tool!` 与旧 match 可短暂共存）。建议一次性（逻辑简单、影响面可控）。

---

## 6. 收益量化

| 指标 | 当前 | 重构后 |
|------|------|--------|
| 加工具需改文件/位置 | 3 处（mod + match 臂 + json!） | **1 处**（handler 内 `register_tool!`） |
| `dispatch_tool` match 样板 | ~87 行 | 0（注册表查找 ~5 行） |
| `get_tool_definitions` 手写 schema | ~254 行 | 0（遍历 ~6 行） |
| 字段漂移 bug 类 | 存在（漏改不报错） | **消除**（schema = `XxxArgs` 单一来源） |
| 二进制体积 | 基准 | 方案 A：**0 增加** |
| 71 个 lib 测试 | 全绿 | 全绿（签名不变，batch 不受影响） |

**净减约 250–300 行手写样板**，且把「工具的真理来源」收敛为 `XxxArgs` 一处。

---

## 7. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| derive 宏属性覆盖不全（`rename`/`default="fn"`/嵌套 Vec） | 中 | 以 `run_command`（`sessionId` rename）、`batch`（`Vec<BatchOp>` 嵌套）为首批验证用例；加 1 条测试断言 schema 含预期属性名 |
| `batch` 递归派发断裂 | 低 | `dispatch_tool` 签名严格保持不变（§3 约束），`batch.rs:54` 无感 |
| `tools/list` 输出字段顺序/空格变化 | 低 | 语义等价即可；客户端只解析 JSON 不依赖顺序 |
| 引入 proc-macro crate 的编译复杂度 | 低 | 仅为 `ToolSchema` 一个小 derive，无运行时依赖 |
| 测试断言 definitions 内容 | 无 | 经 grep 确认：无测试直接断言 `get_tool_definitions` 文本；`handle_tools_call` 测试（http.rs:286）只验 dispatch 成功 |

**安全相关风险：无**（§4.4 已确认所有闸门在重构范围外）。

---

## 8. 与全量 rmcp 迁移对比

| 维度 | 本折中方案 | 全量 rmcp |
|------|-----------|-----------|
| 加工具 3→1 处 | ✅ | ✅ |
| 手写 schema 删除 | ✅（derive 自动） | ✅ |
| 安全闸门重挂风险 | ✅ **0**（原样保留） | ❌ 高（port 到 middleware） |
| 二进制体积 | ✅ **0 增加**（方案 A） | ❌ 可能 +数百 KB~1MB |
| 71 测试回归 | ✅ 基本不动 | ❌ 大爆炸重建 transport 层 |
| transport 升级（SSE/握手/2026-07 RC 无状态化） | ❌ 不拿 | ✅ 拿到 |
| 实施风险 | 低 | 高 |

**结论**：本方案吃掉 rmcp 在「开发体验 + schema 一致性」上的几乎全部收益（~80%），代价仅为「放弃未来 transport 升级」——而该收益在你这场景确定性本就低（Claude Code 用 http transport 已可用，RC 要等 2026-07-28）。

---

## 9. 决策建议

- **风险**：低。不碰安全、不增依赖（方案 A）、测试基本不动、可一次性完成。
- **优先级**：**低于一切用户可感知项**（性能 / UX / cwd 类）。它纯属维护者侧架构健康，用户无感。
- **时机**：建议**推迟**到「自然需要加一个新工具」的节点顺手做，或作为低风险 cleanup sprint；不要在用户价值工作排队时抢占资源。
- **不阻塞**：与「等 2026-07-28 RC 再评估全量 rmcp」互不冲突——届时若决定全换，本折中方案的 `XxxArgs` 强类型基础反而让迁移更顺。

---

## 10. 测试影响（对 71 lib 测试）

- **不受影响**：`dispatch_tool` 签名不变 → `batch.rs:54` 递归派发无感；`handle_tools_call` 测试（http.rs:286）行为等价。
- **需新增**：1 条测试遍历 `registry::all_tools()`，断言 (a) 数量 == 17、(b) 每工具 schema 非空且含 `properties`、(c) `run_command` schema 含 `sessionId`、`list_directory` 含 `maxDepth`（验证 rename 派生）。
- **可直接删**：原 `get_tool_definitions` 对应的任何手工对照（如有）；当前 grep 显示无此类测试。
