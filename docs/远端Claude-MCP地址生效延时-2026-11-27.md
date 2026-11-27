# 在线编辑改远端 Claude Code 的 MCP 地址「过一会才生效」

2026-11-27。用户反馈：用文件面板在线编辑远端 Claude Code 的 MCP 地址，保存后要等一会儿才生效。

## 一、结论

文件面板收到保存成功后，远端写入流程已经返回。仍需区分实际写入耗时、保存后被覆盖，以及当前 Claude Code 会话是否重新读取了配置。

| # | 机制 | 证据强度 | 表现 |
|---|---|---|---|
| C1 | MCP 配置**只在会话启动时加载**，运行中不热重载 | 强（官方文档 + 多处社区一致） | 改完当前会话仍是旧地址，重开会话才用新的 |
| C2 | `~/.claude.json` 是 **Claude Code 自己写的状态档**，运行中的会话会用内存副本整份写回，**覆盖外部修改** | 强（v2.1.318 变更日志明说「其他工作的存档仍可能取代已保存的服务器」） | 改完过一会**变回旧值**；再改一次才成功 |
| C3 | Claude Code 对不同配置文件的监视策略可能受版本和文件类型影响。原子替换会改变 inode | 待真机验证 watcher 对该事件的处理 | 记录实际文件、版本和耗时；目前没有可给出的秒数 |

编辑 `~/.claude.json` 前，先保存工作并退出会写入该文件的 Claude Code 会话。保存后重新打开会话，确认新地址已生效。

## 二、写入端事实（已逐行核对，非推测）

`ssh_file_write`（`desktop/src-tauri/src/commands/ssh_file_cmds.rs:464`）→ `russh_write_file`（`ssh_russh_file.rs:464`）：

1. 抢占式 `await`，Tauri 命令返回 = 服务端 `rename` 已完成；
2. 顺序固定：同目录 tmp → `write_all` → `shutdown()`（close）→ `set_metadata`（权限位）→ `rename` → `stat`；
3. 无 sleep、无后台提交队列、无内容缓存，`useRemoteFileEdit.ts` 也没有保存防抖；
4. 降级链：russh SFTP → helper 分块写（≤128 KB base64）→ scp（一次完整握手，注释实测约 11 s），**russh 失败是静默的**（`if let Ok(..)`，后端无一行日志）。

保存成功后读到旧内容时，应核对实际文件路径、保存返回的元数据和是否发生了并发写入。仅凭读回的内容无法判断走了哪个传输路径。

## 三、三条机制的细节与我们能做的事

### C1 只在启动时加载（不可改，只能提示）

MCP server 定义来自 `~/.claude.json` 顶层、`projects.<path>.mcpServers` 或项目 `.mcp.json`。可在新会话里验证读取结果。`/mcp` 可用来查看状态，外部修改配置后能否通过单个服务器重连加载新地址需要实测。

→ 产品能做的只有**把这件事说出来**（P0-1），以及让保存动作本身不制造额外等待。

### C2 `~/.claude.json` 会被回写覆盖（最伤，必须兜底）

它是 CC 的状态档（登录、project trust、`/config` 写入的 global keys、MCP 配置），运行中持续被改写。v2.1.318 起 `claude mcp add/remove` 会取锁，但变更日志同时承认：**其他工作的存档仍可能取代已保存的 server**。

后果：在线编辑保存成功（我们的乐观锁只在保存瞬间比对 mtime）→ 几秒后 CC 退出或状态落盘，用内存里的旧配置整份覆盖 → 用户看到「改了没生效 / 改完又变回去」。

→ P0-2：保存后守候校验，把「被覆盖」变成用户看得见的事实，而不是静默丢失。

### C3 原子替换与文件监视（待验证）

保存时用同目录临时文件加 `rename`，使读取方始终看到一份完整文件。仅凭 inode 变化无法推断 Claude Code 的监视实现或延时。保留原子替换，先记录文件变更事件和客户端读取行为。

## 四、方案

### P0-1 让「需要重启会话」成为明确提示（前端，约半天）

- 新增纯函数 `src/lib/claudeConfigPaths.ts`（`utils.ts` 已 655 行，不再塞）：
  - `isClaudeMcpConfig(path)`：`~/.claude.json`、`**/projects/*/.claude.json`、`<repo>/.mcp.json`
  - `isClaudeSettings(path)`：`**/.claude/settings.json`、`settings.local.json`、`managed-settings.json`、`%PROGRAMDATA%\ClaudeCode\managed-settings.json`
- `SshFileEditorBar` 顶部加一条**常驻**细提示（非 toast，R17）：
  - mcp 类：`保存后请重开 Claude Code 会话，并检查 MCP 连接是否使用新地址`
  - settings 类：确认实际加载行为后补充提示，先避免承诺生效时间。
- 保存成功的 toast 文案按类型分支（现在恒为「已保存」）。`useRemoteFileEdit` 已顶 8 个 state 上限，**类型判断放在渲染层用 path 推导，不要新增 state**。

### P0-2 保存后守候校验，抓「被 CC 写回」（后端 + 前端，约 1 天）

- 保存成功后延迟 2 s，再对同一路径取一次 stat（新增轻量命令 `ssh_file_stat`：russh `sftp.metadata` 一次 RTT，不读内容；前端只在 `isClaudeConfig` 命中时调用）。
- 若 `mtime/size` 与保存返回值不同 → 内联条：
  `保存后该文件被其它进程改写（很可能是正在运行的 Claude Code 写回内存状态），你的修改可能已丢失`
  给出「重新加载 / 再保存一次」两条出路（复用冲突条的交互形状，不弹窗）。
- 边界：文件确实被别人编辑也是同形，文案写"其它进程"而不是断言 CC；守候只做一次，不做轮询。

### P1 记录实际保存路径与耗时（后端）

- 记录 `russh_write_file` 降级原因和最终通道的耗时，保留原有路径及写入保护。
- 日志只记录操作阶段和经过脱敏的错误信息，避免记录配置内容和访问令牌。

### P2 引导正确路径（文档 + 连接页，约半天）

- 已有能力其实更稳：连接页「IP 变化 → sed 改地址」、Token 重生成 sed，都只改 URL 一行，不整份重写。文案补一句「执行后重启 Claude Code 会话」。
- 远端操作建议写进引导：`claude mcp list` / `claude mcp get <name>` 确认；改 `~/.claude.json` 前先退出所有 `claude` 进程。

## 五、验收（每条都要能真跑）

1. **证明写入不慢**：保存后立即 `stat -c '%i %Y %s'`，与 `ssh_file_write` 返回的 mtime/size 一致 → 写入端无延时（一次即可，作为回归基线）。
2. **观察文件监视行为**：在隔离目录监视父目录的 `modify` 和 `moved_to` 事件，同时记录 Claude Code 实际读取时间。
3. **证明 C2**：远端起一个 `claude` 会话，在线改 `~/.claude.json` 的 mcpServers → 退出会话 → `grep -A3 mcpServers ~/.claude.json`，观察是否被写回旧值；P0-2 的提示必须在这个操作序列里出现。
4. 单测：覆盖配置路径识别、各写入通道的失败以及日志脱敏。
5. 前端：保存后守候校验命中时渲染内联条（组件测试，不靠截图）。

## 六、不做什么

- 不做「保存后自动重启远端 Claude Code 会话」：会打断用户正在跑的对话，风险远大于收益。
- 不做配置文件轮询/热重载订阅：CC 的行为不由我们定义，订阅它只会制造新的不一致。
- 保留配置类文件的原子写入语义，避免网络中断时留下半个配置文件。
- 不在提示里断言"一定是 Claude Code 覆盖"：文案只陈述"被其它进程改写"。

## 七、需要真机复核的两点

1. 用户改的具体文件：`~/.claude.json`（顶层 / projects 段）还是项目 `.mcp.json`？两者都需重启会话，但只有前者有 C2 覆盖风险。
2. 当前版本对 `settings.json` 外部替换与保存的行为，以及是否需要重开会话。
