# 会话级 cwd 持久化 RFC

> 状态：草案 / 待评审 · 日期：2026-07-11
> 关联：对标 native Claude Code 分析（`docs/benchmark-vs-native-claude-code.md`）B 组 🟡2
> 调研来源：网络调研同类案例 + MCP 官方规范（Tools 规范 / 2026-07-28 RC）

---

## 1. 背景与问题

- cc-bridge `run_command` 当前**刻意无状态**：`cwd` 每次必传，每次 `resolve_safe_path` 重校验白名单。这是"远程不可信"设计哲学，不是缺陷。
- **最大语义差距**（对标文档 🟡2）：native / litecode 的 Bash 跨调用保留 cwd（litecode 用 `PWD_MARKER` 技巧），cc-bridge 做不到。
- 目标：在**不削弱安全护栏**（白名单 / 只读 / 审计）的前提下，提供"跨 `run_command` 调用保持工作目录"的能力。

---

## 2. 网络调研结论（决定设计对错）

### 2.1 同类案例：大量、成熟，但都围绕"持久 shell 会话"组织

| 案例 | 形态 | 持久化方式 |
|---|---|---|
| **Arbitrium** | Claude Code 持久化 shell MCP | `arbitrium_spawn→exec→close`，"shell retains all state (cwd, env, processes) between interactions"，pipe+sentinel 检测完成 |
| **sshmcp / remote-session-mcp** | 有状态 SSH MCP | `ssh_connect` 开持久会话 → `ssh_exec` 复用，cwd/env 跨调用保留 |
| **ssh-mcp / Conch** | Go/Rust 有状态 SSH MCP | 按 `session_id` 持常驻连接，cwd/env 在 exec 间保留，空闲超时回收 |

**共同模式**：都是**显式 `session_id` handle 串起一组调用**，客户端因为"先 spawn/connect 拿 id、再 exec"，**天然持有该 id**。

### 2.2 MCP 官方规范：纠正"按 token 隐式关联"的设想

- **MCP 无协议级 session**（官方 Tools 规范原文）：
  > "a server cannot rely on implicit per-connection state to relate one tool call to the next"

  跨调用状态的标准做法是：**创建工具返回一个显式 handle（`session_id`），后续调用把它作为参数传回**，服务端按 key 存储、每次调用校验授权。
- **MCP 正走向无状态（2026-07-28 RC）**：规范移除 `Mcp-Session-Id` 与 `initialize` 生命周期，维护者推荐 mint 显式 handle + 外部持久化（文件系统/Redis/Postgres）。
- **纠正**：早前设想"按 Bearer token 在 AppState 隐式存 cwd"**不严谨**——同一 token 可能来自多个并发连接/客户端，传输层无关联保证。**必须走显式 handle 模式**。

---

## 3. 设计方案：显式 session_id handle

### 3.1 协议 / schema 改动（`run_command`）

- **入参**新增可选 `session_id: string?`。
- **返回**新增 `session_id: string` 与 `cwd: string`（本次生效的工作目录）。
- 解析逻辑：
  1. 若提供 `session_id` 且有效 → 取绑定的已校验 cwd；
  2. 否则若提供 `cwd` 参数 → 走现有 `resolve_safe_path` 校验，并新建 session 返回新 id；
  3. 否则（既无 id 也无 cwd）→ 沿用现有默认/根目录行为，**不创建 session**（向后兼容）。
- **每次调用、无论走哪条路径，session 内的 cwd 在使用前仍重跑 `resolve_safe_path` + 白名单校验**（防御存储被绕过 / 竞态，不信任"已存"）。

### 3.2 服务端存储（`AppState`）

- 新增 `cwd_sessions: DashMap<String, CwdSession>`，`CwdSession { cwd: PathBuf, last_active: Instant }`。
- 生成 id：`Uuid::new_v4()`（足够熵），**不编码内部结构**（opaque handle），避免被猜测/解析。
- 复用 D2 回收机制：在现有 60s gc 任务里追加 `cwd_sessions` 过期清理（建议 30min 空闲）。

### 3.3 安全护栏（规则 7 红线不削弱）

- **白名单**：session cwd 每次仍 `resolve_safe_path` + 白名单校验；越界返回 `isError` + 白名单提示。
- **只读模式**：session 内写命令仍被 `readonly_mode` 拦截；`shell_enabled` 门控同样生效。
- **审计**：审计日志落 `session_id`，与现有 O1 耗时、审计链路一致。
- **开关 `session_cwd_enabled` 默认 `false`**：关闭时行为完全不变（纯加固、零行为变化）。

### 3.4 客户端回传引导（关键不确定项）

- 工具描述明确写道："返回 `session_id` 请在下一次 `run_command` 时通过 `session_id` 参数回传，以保留当前工作目录；不回传则每次独立。"
- 这是 Claude 是否真正用上的关键变量——Arbitrium/sshmcp 能用是因为围绕"新 shell 会话"组织、客户端天然持 id；cc-bridge 的 `run_command` 是单发工具，依赖模型配合。
- 建议：实测时在前端/日志观察 Claude 是否回传 `session_id`，作为"方案是否生效"的验证信号。

---

## 4. 与现有能力兼容

- **batch 工具**：batch 内多 op 可共享同一 `session_id`，复用同一校验后 cwd，无新攻击面。
- **D2 path_locks**：session cwd 变更时的文件锁仍走现有 `path_locks` 体系，gc 机制复用。

---

## 5. 测试要点

- 新建 session → 返回 id；下次带 id且不传 cwd，应沿用上次 cwd。
- 白名单外路径：既拒 `cwd` 参数，也拒 session 内越界（`isError` + 白名单提示）。
- 只读模式下 session 内写命令仍被拦截。
- 过期清理：构造空闲超时后调用返 `isError` 提示"session 已过期，请重新创建"。
- 开关关闭时完全走旧路径（回归测试不破坏）。

---

## 6. 风险与开放问题

- **客户端回传配合度不可控**（最大不确定项）——方案价值取决于 Claude 是否按描述回传 id。
- 并发同 token：**因走显式 id，天然隔离**，比 token 隐式关联反而更安全。
- 进程重启：`cwd_sessions` 为内存态（符合 MCP 2026 无状态指引，重启即清），不影响安全。

---

## 7. 实施步骤（建议顺序）

1. 加开关 `session_cwd_enabled`（默认 false）+ `AppState.cwd_sessions` + gc 钩子（零行为变化）。
2. `run_command` schema + handler 逻辑（含每次重校验）。
3. 工具描述更新（回传引导文案）。
4. 单测 + `cargo clippy --no-default-features` 零警告 + `cargo test`。
