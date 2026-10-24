# Claude Code 图形客户端：开源项目调研

> 调研日期 2026-10-24。目的：为「SSH 远端 Claude Code 的 GUI 化」寻找可借鉴的实现。
> 结论：**有人在多个路线上做过**，技术栈与 cc-bridge 重合度很高，`--sdk-url` 的发现改变了架构选型。

## 一、结论摘要

1. **`--sdk-url`（隐藏旗标）让远端 CLI 主动连回本地**，跳过 SSH 管道，且协议层自带重连/缓冲/重放/会话恢复 —— 这是 SSH 场景下断线韧性的正解，不用自己写。
2. **`zhukunpenglinyutong/desktop-cc-gui` 与 cc-bridge 技术栈几乎完全一致**（Tauri 2 + React 18 + Rust + portable-pty + axum），其「每引擎一个 Rust 协议适配器」的架构可直接借鉴。
3. **Rust 侧有现成 typed SDK**：`claude-codes` crate，serde 模型 + tokio 客户端，版本跟随 CLI。
4. **不要用 PTY 抓语义**：desktop-cc-gui 明确写着「handled natively, not scraped off a terminal screen」，这是与 cc-bridge 现状最大的理念差。

## 二、项目清单

### 第一梯队：直接可借鉴

| 项目 | 栈 | 与本项目的关系 |
|---|---|---|
| `zhukunpenglinyutong/desktop-cc-gui` | Tauri 2 + React 18 + TS + Rust（git2 / rusqlite / portable-pty / axum） | **重合度最高**。11 引擎适配、MCP/skills 管理、LAN Web 访问、功能兼容矩阵 |
| `etailup/companion`（The Vibe Companion） | Bun + Hono + React 19 + Zustand | 最权威的 `--sdk-url` 协议逆向文档 `WEBSOCKET_PROTOCOL_REVERSED.md` |

### 第二梯队：特定场景参考

| 项目 | 栈 | 值得学的点 |
|---|---|---|
| `emptywill/claude-terminal` | Docker + Node + WebSocket + tmux | **多服务器 SSH + tmux 保活**，手机访问，架构图清晰（Browser → Docker → SSH → 远端 tmux → CC） |
| `danilotorrisi/claude-session-manager` | Bun + React + tmux + `--sdk-url` | **toolApprovalRules**：glob 匹配的自动批准规则；审批弹窗带「Always Allow/Deny」 |
| `siteboon/claudecodeui`（CloudCLI） | Node + React + Electron | 同机部署 + 浏览器远程；多 provider adapter；最成熟的功能面 |
| `5Gears0Chill/claude-code-gui` | Tauri 2 + Next.js + xterm.js + portable-pty | 与 cc-bridge **现状**最像（PTY + xterm），可对照看差距 |
| `MagnusPladsen/OpenClaudgents` | Tauri v2 + React | agent 团队图（react-flow）、Monaco diff、context budget 进度条 |

### Rust 生态

| 目标 | 名称 |
|---|---|
| typed SDK（serde 模型 + sync/async 客户端，支持 WASM） | `claude-codes` crate（repo `meawoppl/rust-code-agent-sdks`，Apache-2.0，版本跟随 CLI） |

⚠️ `claude-codes` 月下载量很低（数百级），踩坑无人兜底。但它是薄封装（serde 模型 + 传输），协议有公开逆向文档可自行校验，风险可控。

## 三、`desktop-cc-gui` 的架构要点

**目录分层**（值得抄）：

```
src/features/          # 前端按功能域切：chat / files / git / terminal / settings / plugins
src-tauri/src/engine/  # ★ 每个 CLI 一个模块，各自实现协议适配
src-tauri/src/history/ # 扫各 CLI 原生会话文件
src-tauri/src/web.rs   # LAN Web 桥
packages/plugin-sdk/   # 插件作者工具包
```

**三条可直接采纳的原则**：

1. **协议适配器在 Rust 侧**，每个引擎一个模块，事件/历史/凭据通道原生处理，不从终端画面刮语义。
2. **Provider 凭据写回各 CLI 自己的原生配置文件**，不建平行凭据库（"no parallel credential store"）。
3. **维护一张功能兼容矩阵**（本项目 11 引擎 × 25 项），把「哪个引擎支持什么」显式化 —— 这正是 cc-bridge「批3 协议层」缺少的东西。

## 四、`--sdk-url`：改变选型的关键

### 4.1 连接方向

CLI 是 **client**，主动连接你控制的服务器。隐藏旗标（Commander 的 `.hideHelp()`）。

```bash
claude --sdk-url ws://localhost:8765 \
       --print --output-format stream-json --input-format stream-json --verbose \
       -p "placeholder"
```

- `-p` 的 prompt 参数被忽略，CLI 连上后等服务端先发 `user` 消息。
- `--input-format` / `--output-format` **必须**都是 `stream-json`，否则 CLI 直接退出。
- 认证：升级握手带 `Authorization: Bearer <token>`（token 来自 `CLAUDE_CODE_SESSION_ACCESS_TOKEN` 或 fd 注入）。

### 4.2 SSH 场景下的两种接法

**路 A · 正向 SSH 管道**

```
本地 App --(ssh -T, exec claude --input-format stream-json)--> 远端 claude
```

零安装、实现简单。**致命缺陷**：SSH 断 → 远端进程收 SIGHUP 死亡，进程级流不可恢复（只能 `--resume` 救上下文）。

**路 B · 反向 WebSocket + SSH 端口转发**

```
远端 claude --sdk-url ws://localhost:8765  →  ssh -N -L 8765:localhost:8765  →  本地 App 的 WS server
```

远端跑 `ssh -N -L 8765:localhost:8765 user@host`（生产配 `autossh -M 0`），本地 App 只需一个 WebSocket server（axum 已有依赖）。

**路 B 的优势全部来自协议层**：

| 能力 | 参数 |
|---|---|
| 重连 | 最多 3 次，指数退避 `min(1000 * 2^(n-1), 30000)` ms |
| 消息缓冲 | 环形缓冲 1000 条 |
| 重放 | 重连带 `X-Last-Request-Id`，服务端补发；缓冲消息回放，`isReplay: true` 去重 |
| 保活 | `keep_alive` + 每 10s ping/pong；未收到 pong 即判死（Bun 环境跳过） |
| 会话恢复 | `--resume <id>` 读 `~/.claude/projects/<proj>/<id>.jsonl` 回放；`--fork-session` 分叉；`--resume-session-at <uuid>` 截断 |

### 4.3 控制协议（13 个子类型）

`initialize`（**必须早于首条 user 消息**，重复调用报 `Already initialized`）、`can_use_tool`、`interrupt`、`set_permission_mode`、`set_model`、`set_max_thinking_tokens`、`mcp_status`、`mcp_message`、`mcp_reconnect`、`mcp_toggle`、`mcp_set_servers`、`rewind_files`、`hook_callback`。

`can_use_tool` 请求带：`tool_name` / `input` / `permission_suggestions?` / `blocked_path?` / `decision_reason?` / `tool_use_id` / `agent_id?` / `description?`。

响应：
- allow **必须**带 `updatedInput`（可净化命令、改路径），可选 `updatedPermissions` 写规则（`destination` 支持 `session` / `userSettings` / `projectSettings` / `localSettings` / `cliArg`）。
- deny **必须**带 `message`，可选 `interrupt: true` 中止整个会话。

⚠️ 服务端不响应则 CLI **无限阻塞**；传输断开时未决请求被拒为 `Tool permission stream closed before response received`。

### 4.4 权限三层管线（做审批 UI 必须理解）

```
Tool Use Request
 ├─ Layer 1  PreToolUse Hooks（本地 shell 脚本）：allow / deny / ask
 ├─ Layer 2  本地规则求值：deny 规则 → DENIED；bypassPermissions → ALLOWED（永不上线）
 │           dontAsk → DENIED（永不上线）；allow 规则 → ALLOWED；默认 → ask
 └─ Layer 3  远程提示（WebSocket）：control_request { can_use_tool }
```

**关键推论**：`bypassPermissions` 与 `dontAsk` 模式下 `can_use_tool` **永不上线** —— GUI 在这两种模式下会失去最终把关权。设计权限模式切换时必须把这一点对用户讲明。

## 五、稳隐性评估

| 方案 | 稳定性 | 依据 |
|---|---|---|
| `--input-format stream-json` | **高**（官方文档化） | `code.claude.com/docs/headless` 有正式文档 |
| `--permission-prompt-tool stdio` | 高 | 官方文档 + 4 套独立 SDK 实现 |
| `--sdk-url` | **低（隐藏旗标）** | `.hideHelp()`，无官方文档，仅靠逆向；随时可能变 |

建议：核心链路走官方 stream-json；`--sdk-url` 作为**可选增强**（断了自动降级到 SSH 管道），并在启动时探测旗标是否存在。

## 六、对 cc-bridge 的取舍建议

1. **新增非 PTY 通道**。现有 `ssh_cmds.rs` 全是 `PtyPair`/`PtySize`，需要一条 `Command::new(ssh).stdin(piped).stdout(piped)` 路径，复用现有连接配置（`ssh_proxy.rs::proxy_command_value` 已支持跳板机）。
2. **stderr 必须与 stdout 分离**，一行诊断混进 NDJSON 解析就崩。
3. **删不掉的终端**：vi/htop/tmux/构建日志只能进终端，GUI 只能是并列视图。
4. **先探针后界面**：验 `can_use_tool` 往返（allow 的 `updatedInput` / deny 的 `message`）、`--resume` 跨进程续接、本机 CLI 版本的实际字段形状。

## 七、参考链接

- `github.com/zhukunpenglinyutong/desktop-cc-gui`
- `github.com/etailup/companion` → `WEBSOCKET_PROTOCOL_REVERSED.md`
- `github.com/meawoppl/rust-code-agent-sdks` → `claude-codes` crate
- `github.com/emptywill/claude-terminal`
- `github.com/danilotorrisi/claude-session-manager`
- `github.com/siteboon/claudecodeui`
- `github.com/5Gears0Chill/claude-code-gui`
- `github.com/MagnusPladsen/OpenClaudgents`
- `roasbeef/claude-agent-sdk-go` → `docs/cli-protocol.md`
- `code.claude.com/docs/zh-CN/headless`（官方）
