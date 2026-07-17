# RFC：MCP 协议层全量迁移到官方 `rmcp` SDK（P5-1）

> 状态：**方案草案，未实施**（仅供决策参考）
> 关联：`proposals/handwritten_dispatch_refactor_rfc.md`（§8 已预判本方案，建议推迟）、功能优化清单.md P5-1
> 目标读者：决策者（本文档产出于 2026-07-17 的方案讨论，含真实调研的 rmcp 官方 SDK 现状，非猜测）

---

## 1. 背景与动机

`功能优化清单.md` P5-1 提出：MCP 协议层从当前手写 dispatch（`http.rs` + `mcp/tools/registry.rs`）换成官方 `rmcp` crate，理由是「补齐 SSE 流式 + 协议协商，手写 dispatch 换官方维护」。

**需要先澄清的前提**：2026-07-14 已完成一次「折中半程重构」（见 `handwritten_dispatch_refactor_rfc.md`），把手写 `match` + 手写 `json!` schema 换成了 `registry.rs` 的 `register_tool!` 宏 + 自动派生 schema。该 RFC 的 §8 已经把「折中方案」与「全量 rmcp」做过一次对比，结论是：**折中方案吃掉了 rmcp 在"开发体验 + schema 一致性"上约 80% 的收益，且零风险**；rmcp 独有的剩余收益只有两项——**SSE 流式**、**协议版本协商**——并建议「推迟到 2026-07-28 协议修订版（RC）落地后再评估」。

本文档是该次「再评估」的产出，基于 2026-07-17 对 `rmcp` 官方仓库/crates.io 的实测调研（非猜测），目的是让你看到**具体方案长什么样、成本在哪**，而不是重复"值不值得"的抽象讨论。

---

## 2. 目标 / 非目标

**目标**
- 如果做：拿到 SSE 流式响应能力 + SDK 自动处理的协议版本协商/握手。
- 现有安全模型（Bearer 鉴权、限流、审计日志、只读工具拦截、路径白名单）**零削弱**地迁移过去。

**非目标**
- 不追求「文件级偷懒」——`registry.rs` 折中方案已经把 schema/dispatch 的样板问题解决了，本方案不重复这部分收益。

---

## 3. `rmcp` 官方 SDK 现状（2026-07-17 实测调研，非猜测）

| 维度 | 事实 | 来源 |
|------|------|------|
| 当前版本 | crates.io 最新稳定版 **2.2.0**（2026-07-08） | crates.io/rust-sdk releases |
| 稳定性 | **仍在做破坏性变更**，非严格 semver：`2.0.0` 整体重排类型体系（`Annotated<T>`/多个 `Raw*` 合并为 `ContentBlock`、多个类型改名、wire 类型改 `#[non_exhaustive]`）；`1.8.0`（minor 号）也含 source-breaking 变更（`Peer::peer_info()` 返回类型变化），官方在该 issue 里建议不想跟进的项目锁 `=1.7.x` | GitHub Discussion #926、Releases |
| 支持的协议版本 | `V_2024_11_05`/`V_2025_03_26`/`V_2025_06_18`，2.x 系列对齐 `2025-11-25` 规范；**2026-07-28 还有一版协议修订**，2.0.0 的类型重排就是为它预留空间——即migrate 到 rmcp 之后仍要预期后续还有破坏性变更 | Discussion #926 |
| HTTP 传输 | `transport-streamable-http-server` feature；`StreamableHttpService` 是标准 **tower `Service`**，可用 `Router::new().nest_service("/mcp", service)` 挂到现有 axum `Router`，**不独占监听器/进程** | docs.rs、Shuttle 博客实例 |
| 工具定义 | `#[tool_router]` + `#[tool(description="...")]` + `Parameters<T>`（`T: Deserialize + schemars::JsonSchema`），`#[tool_handler]` 生成默认分发；schema 由 `schemars` 自动派生 | rup12.net 教程、docs.rs |
| 协议协商 | `ServerHandler::get_info()` 返回 `ServerInfo`（含 `protocol_version` + `ServerCapabilities::builder()`），`initialize()` 默认实现直接回它——握手细节 SDK 自动处理 | docs.rs |
| 已知迁移经验 | **没有找到任何"手写 axum MCP server 迁移到 rmcp"的公开战报**，只有"从零用 rmcp 写"的教程；client 侧有已知鉴权 header 相关 bug（issue #464/#431，不直接影响 server 端但反映 SDK 打磨程度） | 全网检索结果 |

**最关键的一条（直接决定本方案设计）**：HTTP 层中间件（Bearer/限流/压缩/并发上限）**可以原样复用**，因为 `StreamableHttpService` 就是个 tower `Service`；但 **cc-bridge 现在「逐工具审计日志」+「按工具名的只读拦截（`WRITE_TOOLS`）」是无法用 tower 中间件实现的**——因为 streamable HTTP 把 `initialize`/`list_tools`/`call_tool` 全部复用同一个 POST 端点，HTTP 中间件看到的只是不透明 JSON-RPC body。目前**没有查到 rmcp 提供细粒度的 per-tool 拦截 hook**，唯一途径是覆盖粗粒度的 `ServerHandler::call_tool()` 统一入口，在里面手写审计/只读校验——这部分逻辑必须整体搬家，不是"包一层中间件"就能解决。

---

## 4. 设计方案

### 4.1 分层改造范围

```
现状：
  axum Router
   ├─ auth_middleware（Bearer 常量时间比较）        ← 可原样保留（外层包住 rmcp 的 nest_service）
   ├─ RequestBodyLimitLayer / CompressionLayer      ← 可原样保留
   ├─ ConcurrencyLimitLayer                          ← 可原样保留
   └─ dispatch_tool（registry 查找）
        ├─ WRITE_TOOLS 只读闸门                      ← 必须搬进 ServerHandler::call_tool
        └─ 17 个 handler（XxxArgs::handle）           ← 必须改造成 #[tool] 方法 + Parameters<T>

审计日志（每次调用记 tool/args/result/耗时）           ← 必须搬进 ServerHandler::call_tool（同上，无法用 tower 中间件截获）
```

### 4.2 迁移步骤（概要，非最终实现）

1. 引入 `rmcp = "2.2"`（锁死小版本，见 §5 风险）+ 隐式引入 `schemars`（rmcp 工具宏依赖它派生 schema）。
2. 新建 `CcBridgeServerHandler` struct，持有 `Arc<AppState>`；用 `#[tool_router]` 把现有 17 个 `handle()` 函数改造成该 struct 上的 `#[tool]` 方法（入参从 `XxxArgs` 改用 `Parameters<XxxArgs>` 包装）。
3. 在 `call_tool()`（`#[tool_handler]` 生成的默认实现之外手动覆盖，或在其前后手写包装）里：
   - 保留 `WRITE_TOOLS` 名单校验（原样迁移 `http.rs:417-435` 的逻辑，只是挂载点换了）；
   - 保留审计日志写入（原样迁移 `write_audit_for_call` 调用点）。
4. `build_router` 里把 `StreamableHttpService::new(...)` 通过 `nest_service("/mcp", ...)` 挂进现有 `Router`，**外层 `auth_middleware`/`CompressionLayer`/`ConcurrencyLimitLayer` 原样保留**（这是 §3 调研确认可行的部分）。
5. `get_info()` 声明 `protocol_version` + `ServerCapabilities`，SSE/握手细节交给 SDK。
6. `batch` 工具的内部递归派发（`batch.rs:54` 直接调用 `dispatch_tool`）需要改造成调用新 `ServerHandler::call_tool`，或保留一个瘦身版 `dispatch_tool` 做内部转发（避免 batch 自身逻辑大改）。
7. 全部 `over_wire_tests`（`http.rs` 里 `spawn_server`/`rpc` 等测试基建）需要重写，因为请求/响应现在走 rmcp 的 `StreamableHttpService`，不再是当前手写的 `/mcp` POST handler。

### 4.3 安全闸门迁移风险表

| 闸门 | 现状挂载点 | rmcp 下挂载点 | 风险 |
|------|-----------|--------------|------|
| Bearer 常量时间比较 | axum middleware（http 层） | **原样保留**，包住 `nest_service` | 低 |
| 按 IP 限流 | axum middleware | 原样保留 | 低 |
| `WRITE_TOOLS` 只读闸门 | `dispatch_tool` 入口 | 必须搬进 `call_tool()` 手写覆盖 | **中**（逻辑对不对需要新写测试验证，不是无脑复制粘贴） |
| 逐工具审计日志 | `dispatch_tool`/各 handler | 同上，搬进 `call_tool()` | **中**（同上） |
| 路径白名单 canonicalize | 各 handler 内部 | 不变（handler 内部逻辑，只是外壳换了） | 低 |
| `batch` 内部递归派发 | 直接调用 `dispatch_tool` | 需要改造调用点 | 低-中 |

---

## 5. 成本 / 收益量化对比

| 维度 | 现状（已实施折中方案） | 全量 rmcp |
|------|----------------------|-----------|
| SSE 流式 | ❌ 无（`get_command_output` 轮询已覆盖后台命令输出场景） | ✅ 有，但当前**无具体未被满足的场景**（见 2026-07-17 会话分析：轮询已够用） |
| 协议版本协商 | 手写，锚定当前协议版本 | ✅ SDK 自动处理，为未来协议演进上保险 |
| 加工具样板 | 已是 3→1 处（`registry.rs` 折中方案） | 同等或略优（`#[tool]` 宏），**边际收益很小** |
| 二进制体积 | 基准（方案 A 未引入 schemars） | **必然增加**（rmcp 工具宏依赖 `schemars`，与 CLAUDE.md 规则 8「二进制体积红线」冲突，需重新评估该红线是否让步） |
| 安全闸门迁移 | 不涉及 | 中风险，需重写 + 新测试覆盖 `WRITE_TOOLS`/审计两个关键路径 |
| 测试面 | 81 个测试基本不动 | `over_wire_tests` 全部重写（http.rs 的 `spawn_server`/`rpc`/`assert_dispatch_ok` 等测试基建作废重建） |
| SDK 自身稳定性 | 不涉及 | **SDK 本身仍在破坏性变更**（2.0.0/1.8.0 均有 breaking change），迁移过去不是"从此免维护"，而是换一种持续要跟版本的维护负担 |
| 已知迁移先例 | — | **零**（未找到任何真实迁移案例可参考，属于"自己蹚路"） |

---

## 6. 决策建议

维持 2026-07-16 会话的判断，本次调研进一步坐实、没有推翻：

- **SSE 流式**：当前无具体痛点（`get_command_output` 轮询已覆盖真实场景），收益是理论上的。
- **协议协商**：唯一站得住的价值，但属于"给未来买保险"，不解决当前问题；且 rmcp 自己也在持续 breaking change，买的保险本身还在变形。
- **加工具样板**：已被 2026-07-14 的折中方案吃掉了大半，边际收益很小。
- **成本**：审计日志 + 只读闸门必须整体搬进 `ServerHandler::call_tool()`（无法用中间件旁路解决，本次调研确认），`over_wire_tests` 全部重写，二进制体积很可能违反规则 8 红线，且**没有任何公开的同类迁移案例可参考**，风险自担。

**建议：不启动。** 保持功能优化清单里的现状（⬜ 待做，不排期），除非未来出现具体的"协议不兼容导致 Claude Code 连不上"这类硬故障,或"轮询确实撑不住了"的实测场景，再重新评估。如果你仍想做，我建议至少等 2026-07-28 的协议修订版发布、观察 rmcp 是否借机稳定下来，再决定，而不是现在用一个还在剧烈变动的 SDK 去动核心协议层。
