# RFC: cc-bridge 面板内 SSH 终端集成

- **状态**：设计稿已出，方案待实现
- **范围**：人在面板里手动操作终端 + 远程 Linux 密码登录（首版）
- **作者**：lzlkyb
- **日期**：2026-08-24
- **关联设计稿**：`design/ssh-terminal-design.html`

---

## 1. 背景与目标

cc-bridge 当前架构是：本地 Windows/macOS 运行 cc-bridge，远程 Linux 上的 Claude Code 经 HTTP 连过来读写本地文件。用户希望在 cc-bridge 面板里**直接连接远程 Linux 主机并操作终端**，免去切到外部终端的麻烦。

**首版目标（已与用户锁定）**：

1. 人在面板里**手动操作交互终端**（xterm.js 渲染，非 MCP 工具）
2. 远程 Linux 采用**密码登录**（密钥登录本轮不做）
3. 其余能力（MCP 工具、SFTP 文件传输、多标签分屏）留待后续扩展

**非目标（本轮不做）**：

- 让远程 Claude Code 经 cc-bridge 使用 SSH（MCP 工具）
- 文件传输（SFTP/SCP）
- 密钥登录（弹框预留灰显占位）
- 多标签 / 分屏终端

---

## 2. 技术选型

### 2.1 结论：方案 B —— 系统自带 OpenSSH + 本地 ConPTY + xterm.js

| 维度 | 系统 ssh + ConPTY（选定） | 内嵌 Rust 库 russh | MCP 工具 ssh |
| --- | --- | --- | --- |
| 安装包体积 | ✅ 零代价（不进包） | ⚠️ +2~4MB，冲击 4.5MB 卖点 | ✅ 零增长 |
| 功能完整度 | ✅ PTY/256色/agent/后续 SFTP·SCP 现成 | 需自己补 | ❌ 无交互终端 |
| 密码登录 | ✅ ssh 自动关本地 PTY 的 ECHO，密码不回显，提示出现在终端流 | ❌ 提示/回显/遮蔽需自己实现 | 需 sshpass/密钥 |
| 交互程序 | ✅ vi/htop/tmux 原生支持 | ✅ 但 PTY 也要自己做 | ❌ |
| 工作量 | 中（PTY 管道 + 前端集成 + Win 降级） | 高 | 低 |

### 2.2 为什么系统 ssh 够好用

- **零体积代价**：Windows 10 1809+/Win11、macOS 全自带 OpenSSH 客户端，无需打进安装包。
- **功能最全**：PTY 分配、256 色、SSH agent、后续 SFTP/SCP 都现成。
- **密码登录最省心**：在 PTY 里跑 `ssh user@host`，密码提示自然出现在终端、用户直接敲；ssh 自己关掉本地 PTY 的 ECHO，密码**不回显为明文**。换成内嵌库（russh），这套提示/遮蔽逻辑得自己写，更易出 bug。
- **唯一真实风险**：部分 Windows 环境（旧 Win10、Windows Server、企业精简镜像）可能没装 OpenSSH。应对见 §6.4。

---

## 3. 架构

```text
┌─────────────────────────────────────────────────────────────┐
│  前端 (React + Tauri WebView)                                 │
│  TerminalTab ── ConnectionList ── NewConnectionDialog         │
│       │ xterm.js (onData→ssh_input, listen ssh_output→write)  │
│       ▼ Tauri IPC (invoke / listen)                           │
├─────────────────────────────────────────────────────────────┤
│  后端 (Rust + Tauri2)                                         │
│  commands/ssh_cmds.rs:                                         │
│    ssh_check    探测 ssh 是否可用                              │
│    ssh_connect  portable_pty 开 PTY spawn `ssh ...`            │
│    ssh_input / ssh_resize / ssh_disconnect                   │
│       │ emit("ssh_output",{session_id,data}) / emit("ssh_closed")│
│  AppState.ssh_sessions: DashMap<String, SshSession>          │
│  SshSession { pty master, child, dims, last_active }          │
│  GC: 复用 60s 后台任务（同 cwd_sessions）                      │
└─────────────────────────────────────────────────────────────┘
        │ 本地 PTY (Windows=ConPTY / Unix=pty)
        ▼
   系统 ssh.exe / /usr/bin/ssh  ──▶ 远程 Linux
```

### 现有集成点（已读真实源码确认）

- 后端 Tauri 命令集中在 `desktop/src-tauri/src/commands/`，经 `main.rs` 的 `generate_handler!` 注册。
- 增量输出模型参考 `mcp/tools/run_command.rs` 的 `get_command_output`（按 offset 拉取）。
- 前端调用模式：`invoke()` + `listen("update:*")` 事件流；配置写 `save_config({patch})`；数据读 `useQuery`。
- 连接池复用 `AppState`，现有 `cwd_sessions: DashMap` + 60s GC 后台任务模式可直接套用。
- 工具注册为一行宏，新增命令零样板。
- 安全先例：`external_mcp_servers` 注释明确——外部写入的敏感配置不能经 MCP 暴露；SSH 凭据同理，只经 Tauri IPC 写入。

---

## 4. 前端设计

> 视觉稿见 `design/ssh-terminal-design.html`，以下为要点。

### 4.1 新增第 5 个 Tab「终端」
- 沿用现有 `TabsList` 样式；`terminal` 图标已存在于图标集，无需新增图标依赖。
- 标签栏：`连接 / 安全 / 设置 / 日志 / 终端`，快捷键顺延 Ctrl+5。

### 4.2 终端页两栏布局
- **左栏 连接列表**：名称 + `user@host:port` + 在线/离线圆点（按 `ssh_sessions` 是否含该连接判定）。操作：新建 / 编辑 / 删除 / 连接 / 断开。
- **右栏 xterm.js 终端**：深色 `#1e1e1e` + 等宽中文字体 + 闪烁光标。标题栏含连接名、绿色「已连接」徽章、复制 / 清屏 / 断开按钮。vi/htop/top/tmux 等交互程序可用。

### 4.3 新建 / 编辑连接弹框
- 字段：名称 / 主机 / 端口 / 用户名 / 认证方式 / 密码。
- 认证方式默认「密码」（已选中）；「密钥」灰显「后续」占位。
- 密码框带眼睛图标切换显隐；「记住密码」勾选后加密存本机。
- 底部复用项目 `warn-box` 样式，写明安全边界。

### 4.4 安全闸门（遵循"默认关 + 多层闸"）
- 新增 `ssh_enabled` 总开关，默认关。
- 首次点「终端」Tab 显示启用闸（锁图标 + 风险说明），点「启用」才展示主界面。

---

## 5. 后端设计

### 5.1 命令清单（commands/ssh_cmds.rs）

| 命令 | 说明 |
| --- | --- |
| `ssh_check()` | 探测 ssh 路径，返回 `{available, path, install_hint}` |
| `ssh_connect(args)` | 校验 `ssh_enabled`；portable_pty 开 PTY → spawn `ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -p <port> <user>@<host>`；注册 `ssh_sessions`；起读线程 emit `ssh_output`；返回 `session_id` |
| `ssh_input(session_id, data)` | 写 PTY stdin |
| `ssh_resize(session_id, rows, cols)` | 调 `portable_pty set_size` |
| `ssh_disconnect(session_id)` | kill child + 从 map 移除 + emit `ssh_closed` |

### 5.2 SshSession 结构（state.rs）
```rust
pub struct SshSession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    dimensions: (u16, u16),    // rows, cols
    last_active: std::time::SystemTime,
}
```
- `AppState` 新增 `pub ssh_sessions: DashMap<String, SshSession>`。
- GC：复用 60s 后台任务，断开空闲/僵尸会话。

### 5.3 配置（config.rs / BridgeConfig）
```rust
pub ssh_enabled: bool,                  // 默认 false
pub ssh_connections: Vec<SshConnection>,
// SshConnection { id, name, host, port, user, auth_type("password"), remember_password, encrypted_password }
```
- `load_config` match 加分支；`save_full_config` 加 `save_config_field` 写入。
- 仅经 Tauri IPC 改（前端 `save_config({patch})`），**绝不走 MCP**。

### 5.4 密码加密存储（记住密码）
- 用 `aes-gcm`（体积小）加密落盘。
- 密钥经 OS 密钥库（Win DPAPI / mac Keychain）或每安装随机生成后存 keychain。
- 明文只经 Tauri IPC，绝不进 MCP。
- 提供 encrypt/decrypt 工具 + 单测往返。
- **首版密码登录走「人交互输入」**：ssh 在 PTY 里自动关 ECHO，密码不回显。自动填充（检测 `password:` 提示后写密码）作为后续增强，且需兼容中英文提示词。

---

## 6. 实现任务清单（16 项 · 5 阶段）

### 阶段 0 — 依赖与体积风险（最关键，先做）
- **T1 审计 portable-pty 依赖**：当前 `windows` crate 锁 `0.56`。portable-pty 若引不同版本会拉入第二份 windows 绑定 → 膨胀二进制、冲击 20MB 红线。先确认版本兼容，必要时在 `[target.windows]` 段补它需要的 windows features（如 `Win32_System_Console`）。评估前端 xterm 包对 asar 的影响。
- **T2 引入依赖**：Cargo.toml 加 `portable-pty`（与 windows 0.56 兼容版本）；前端 package.json 加 `xterm` + `xterm-addon-fit` + `@types`。release profile 维持 `opt-level=s` + `lto=thin` + `strip`。

### 阶段 1 — 后端连接核心
- **T3 AppState 连接池**：新增 `ssh_sessions: DashMap<String, SshSession>` + `SshSession` 结构（含 portable_pty 句柄）。复用 cwd_sessions 的 DashMap + GC 模式。
- **T4 ssh_check**：探测 `C:\Windows\System32\OpenSSH\ssh.exe`（含 SysWOW64 回退）/ macOS `/usr/bin/ssh`，返回 `{available, path, install_hint}`。Win 缺失时 install_hint 给管理员 PowerShell：`Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`。
- **T5 ssh_connect**：portable_pty 开 PTY 初始 80×24 spawn ssh；注册会话；起读线程 emit `ssh_output`；返回 `session_id`。保活参数 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`。
- **T6 ssh_input / ssh_resize / ssh_disconnect**：写 PTY、调 `set_size`、kill + 清理。三者做 session 存在性校验。

### 阶段 2 — 配置与安全
- **T7 BridgeConfig**：加 `ssh_enabled`(默认关) + `ssh_connections`。仅经 Tauri IPC 改。
- **T8 密码加密**：`aes-gcm` 加密落盘 + OS keychain 存密钥。

### 阶段 3 — 前端终端 UI
- **T9 TerminalTab**：第 5 个 Tab（Ctrl+5）+ 启用闸（关时锁屏，风险说明后才开）。
- **T10 连接列表**：左栏，名称 + `user@host:port` + 在线/离线圆点 + 增删改连。
- **T11 新建/编辑弹框**：复用设计稿字段与 `warn-box`。
- **T12 xterm.js 集成（好用核心）**：`onData→ssh_input`、`listen("ssh_output")→write`、缩放跟手、`TERM=xterm-256color`+中文字体防乱码、复制粘贴、WebView2 键盘捕获（Ctrl+C/功能键/方向键）。
- **T13 Windows ssh 缺失降级**：显示安装指引卡片 + 重新检测按钮。

### 阶段 4 — 接线
- **T14 main.rs**：注册 5 个命令 + GC 清理 + 断线自动 emit `ssh_closed` 并从 map 移除。

### 阶段 5 — 测试与红线
- **T15 后端单测**：`cargo test --no-default-features` 通过。用本地 shell 代替 ssh 验 PTY 生命周期（spawn+输出流+resize+disconnect）。
- **T16 体积校验 + 端到端**：`cargo build --release` 确认 exe ≤ 20MB（盯 windows crate 无重复）；连真实 Linux 密码登录，验证 vi/htop/top/tmux、中文 UTF-8、缩放跟手、复制粘贴、保活不闪断。

---

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| **体积红线**（portable-pty 拉入第二份 windows 绑定） | T1 先行审计，版本对齐 0.56；失败则 `[target.windows]` 补 features。前端 xterm 走 asar，不计入 Rust exe。 |
| **Windows 未装 OpenSSH** | T4 检测 + T13 优雅降级卡片（含管理员安装命令 + 重新检测）。macOS 永远有。 |
| **中文 / UTF-8 乱码** | `TERM=xterm-256color` + 设 locale + xterm.js 配等宽中文字体。 |
| **窗口缩放不跟手** | xterm.js `onResize` → 后端 `set_size(rows, cols)`（T6/T12）。 |
| **idle 断线** | `ServerAliveInterval=30 -o ServerAliveCountMax=3`（T5）。 |
| **WebView2 键盘捕获** | Ctrl+C / 功能键 / 方向键透传处理（T12）。 |
| **凭据泄露** | 仅经 Tauri IPC 写入本机，明文不出本地进程，绝不走 MCP；记住密码加密 + OS keychain。 |

---

## 8. 后续扩展（本轮不做，预留）

1. **MCP 工具 ssh**：把 SSH 暴露成 `ssh_exec`/`ssh_upload` 等 MCP 工具，让远程 Claude Code 经 cc-bridge 操作第三台 Linux。复用首版连接池，工作量主要是工具封装。
2. **SFTP / SCP 文件传输**：系统 ssh 已带 ssh/scp，加 SFTP 子会话即可。
3. **密钥登录**：弹框预留占位，实现时复用 T8 加密存储。
4. **多标签 / 分屏终端**：xterm.js 多实例 + 会话路由。
