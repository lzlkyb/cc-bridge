# desktop-cc-gui 源码分析

> 分析日期 2026-10-24。对象：`github.com/zhukunpenglinyutong/desktop-cc-gui`（4513 star，Tauri 2）。
> 样本：完整克隆 `af3537bee`（6203 commits，234 MB，工作树干净），落在项目外 `D:/AItool/research/desktop-cc-gui`。
> 方法：精读 `src-tauri/src/` 7 个核心文件 7566 行（engine/{claude,events,reader,registry,wsl_transport,job}.rs + web.rs）+ 前端 `features/chat` 核心组件；diff 算法做了实测比对。
> 目的：判断哪些设计可直接移植到 cc-bridge 的 SSH 远端 GUI。

## 一、先说三个与 README 不符的事实

**1. 它没有工具审批卡。** README 宣传「visual tool approval / manual 模式」，实际 `engine/claude.rs:503-543` 的注释是：

> `SDK control protocol asks. AskUserQuestion surfaces to the UI; every other ask is denied in place (this client has no approval card), preserving the old headless behavior.`

只有 `AskUserQuestion` 弹给用户，其余 `can_use_tool` 一律就地拒绝，deny 文案自我承认：

> `"This client cannot show tool-permission prompts; the {tool_name} call was denied."`

`engine/reader.rs:698-726` 的策略是「就地拒绝，避免 CLI 被 park 到超时」。所谓 `manual` 模式是**诚实降级**：映射到 CLI 的 `default`，需要审批的工具直接拒，让模型自己绕路。

**2. 它不用 `--sdk-url`。** 用的是官方文档化的 `--input-format stream-json` + `--permission-prompt-tool stdio`。这个选择更稳。

**3. 它不是长驻会话。** `claude.rs:194-196` 注释：

> `each send is a fresh process anyway` / `the CLI cannot expand its allowed-dirs mid-process`

**一轮 = 一个进程**；turn 结束就 `close_stdin` 让 CLI 退出（`reader.rs:804-806`），下一轮新进程 + `--resume <session_id>`。**这是本项目最值得抄的架构决策**，原因见下。

## 二、为什么「一轮一进程」是对 SSH 场景的最优解

| | 长驻进程（stdio 一直开着） | 一轮一进程 + `--resume` |
|---|---|---|
| SSH 断线后果 | 整场会话死，上下文靠 `--resume` 抢救 | **只死当前这一轮**，下一轮照常接上 |
| 进程泄漏 | 一个漏死就永久占用 | 天然自愈，每轮重新核对 |
| 审批窗口 | 跨轮次挂着，超时难管 | 只在 turn 内存活，60s 语义清晰 |
| 代价 | 无 | 每轮启动开销 + 依赖 `~/.claude/projects/<proj>/<id>.jsonl` |

它把「会话状态」交给 CLI 自己持久化的 JSONL，客户端保持无状态。**对跨 SSH 的 GUI 来说，这个代价远小于收益。**

## 三、可直接移植的六处设计

### 1. 引擎抽象 + 26 种事件（UI 骨架）

`engine/events.rs` 的 `EngineEvent` 枚举就是「UI 要渲染的全部东西」：

```
Delta Thinking Message SessionId Usage Generation Error Warn
AttemptEnd Retry PermissionDenied Question QuestionSettled
PlanDraft PlanReviewReady PlanReviewSettled Compaction AgentSettled
ControlPermissionDeny Done Model Effort Launch Served
McpServers BackgroundTasks
```

其中三个是设计时容易漏的：**`Compaction`**（上下文压缩事件，要提示用户「刚被压缩」）、**`BackgroundTasks`**、**`AttemptEnd`**（区分「本轮结束」与「整个 run 结束」）。

### 2. 远程 transport 包装 —— `wsl_transport.rs` 与 SSH 同构

这是最有价值的文件（627 行）。它把本机构造的命令包装成 `ssh → wsl.exe` 执行，**与「本地 App → SSH → 远端 claude」完全同构**，改造量极小。三步骤：

1. `build_script()` 生成远端脚本：`set -e` → `rm -f "$0"`（自删）→ 逐个 `export` → `cd <ws>` → `exec <cli> <args…>`
2. 用 `ssh host "tee /tmp/xxx.sh"` 把脚本经 **stdin 明文写入**（脚本内容不进命令串 ⇒ 零转义需求）
3. 真正的 run = `ssh host "bash /tmp/xxx.sh"`，命令串只含固定词（`tee`/`bash`/UUID 路径，无 `$`/`|`/引号）

脚本以 `exec` 开头 ⇒ 远端 bash 被 CLI 替换 ⇒ stdin(prompt payload) 与 stdout(NDJSON) **原样直通**，进程组 kill → ssh 断 → 远端 SIGHUP 直达 CLI，**中断语义与本地一致**。

配套：
- `ssh_options()`：`StrictHostKeyChecking=accept-new` + `ConnectTimeout=10` + `ControlPath=<master>` + `BatchMode=yes`（死 master 不会卡住 spawn）
- `base_ssh_command()`：`ssh <opts> -- <user@host>`，`--` 终结 getopt，destination 永不被当选项
- `skip_local_cwd: true`：远程路径本机不存在，绝不能设 `current_dir`
- `strip_transport_noise()`：剥掉 NUL 残迹与 `wsl:` 开头的诊断行

### 3. Windows 孤儿进程清理

`engine/job.rs`（149 行）用 Job Object 而非 `taskkill /T`。真实事故：

> `a grandchild that outlives its parent escapes that walk entirely... Turns accumulate one orphan family each until the machine crawls (thousands of pwsh.exe/conhost.exe reported in the field).`

解法：`CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，最后一个 handle 关闭时内核清扫全部成员。**cc-bridge 在 Windows 上跑 claude 会遇到同一个问题**（claude 会拉 PowerShell/Bash 工具进程）。代码可直接搬，附完整测试。

### 4. 回写 control_response 的通道

`registry.write_line(&run_id, json)` 持有 `entry.stdin` 写一行 NDJSON。审批/回答的回复都走这里。turn 结束后 `close_stdin`，写失败返回 `"the session is no longer accepting input"` —— 错误语义清晰。

### 5. 参数构造的四个必知约束（`claude.rs:77-222`）

```rust
claude -p --input-format stream-json --output-format stream-json
       --verbose --include-partial-messages
       --permission-prompt-tool stdio          // ← 关键：让 ask 走控制协议
       [--permission-mode plan|default|acceptEdits|...]
       [--allowedTools ...] [--disallowedTools ...]
       [--add-dir DIR]...                       // ← 每次启动都要重放
       [--resume <session_id>]
       [--model ...] [--effort ...] [--mcp-config <内联 JSON>]
```

- `--permission-prompt-tool stdio` 还负责**挂载 AskUserQuestion**：注释明写 `Without the flag the CLI treats every ask as terminal and never mounts AskUserQuestion at all`。
- `acceptEdits` **不含** `WebSearch`/`WebFetch`，auto 模式必须显式预批准，否则每次联网调用被拒。
- `--add-dir` 无法在进程内扩展，批准的目录下一轮才生效（因为一轮一进程，反而自然）。
- MCP 用 `--mcp-config` 传**内联 JSON 字符串**，不落临时文件。

### 6. 数据形状的两个反直觉点

- **上下文窗口**：CLI 不发 `model_context_window`，只在 `result.modelUsage[<model>].contextWindow` 里给。一个 turn 可能含多个模型（子 agent 用便宜模型），取 **token 数最多**的那个的窗口。
- **`system/api_retry` 不是错误**：CLI 会退避 10 次、每次 30s+ 后继续，应渲染成「重试中 x/y」的进度而非报错。

## 四、已踩过的七个坑（不必重踩）

| # | 坑 | 表现 |
|---|---|---|
| 1 | 非登录 shell 探不到 `~/.local/bin` | 普通 `command -v` 找不到 claude（它常装在那）；必须 `bash -lc "command -v claude"` |
| 2 | stderr piped 但不读 | 远端写满管缓冲 → 与 `wait` 互等死锁；必须 `Stdio::null()` |
| 3 | `ConnectTimeout` 只覆盖 TCP 建连 | 连上后挂起 ⇒ Tauri command future **永不 resolve**，前端全卡死到重启；必须加全局 deadline（他们用 30s） |
| 4 | 孤儿进程累积 | 见 job.rs，机器最终卡死 |
| 5 | `acceptEdits` 不含 web 工具 | auto 模式下联网调用全被拒 |
| 6 | 上下文窗口读错字段 | 读 `model_context_window` 永远拿不到，1M 变体全显示 200k |
| 7 | 脚本内容进命令行 | 引号/`$`/反引号地狱；正确做法是走 stdin 写文件 |

## 五、与 cc-bridge 的差异和机会

**它已解决**：多引擎适配、远程 spawn 包装、孤儿清理、流式渲染、会话恢复。
**它是空白**：**运行时工具审批**（自己承认无此能力）。

⇒ **审批卡是 cc-bridge 的差异化点，而不是补课。** 而且技术路径已经被它验证过一半：`AskUserQuestion` 走的就是同一套 park → 等用户 → 重建 `updatedInput` → `write_line` 回传（`reader.rs:554-568`），工具审批只需把 `ControlPermissionDeny` 分支换成 `Question` 那种 park 即可。

**它没有的**：真正的 SSH（只有 WSL）、审批规则（glob 自动批准）、把「远端」当第一等公民的 UI。

## 六、`claude.rs` 的内部矛盾 —— 已用 git 历史定案

初读时发现两段注释互相否定：

- `claude.rs:86-91`：无条件加 `--permission-prompt-tool stdio`，注释说这让 ask（含 `AskUserQuestion`）走控制协议。
- `claude.rs:92-95`：注释说 `Headless -p cannot prompt mid-turn`，所以 manual 降级成 `default`，需要审批的工具直接拒掉。

**查引入时间就散了**（`git log -S`）：

| 提交 | 日期 | 内容 |
|---|---|---|
| `4fcdc1651` | 2026-09-08 | 写下「manual 降级」注释 |
| `6c4b775ef` | **2026-09-17** | 引入 `--permission-prompt-tool stdio`，为了 `AskUserQuestion` |

**降级注释比 flag 早 9 天**，是加 flag 之前的遗留，已过期。结论：

- `can_use_tool` 通道**确实开着**，`ChatEngineEvent` 里有专门的 `ControlPermissionDeny` 变体，`claude.rs:1121` 的测试 `other_control_asks_are_denied_in_place` 用的就是 `tool_name: "Bash"`。
- 所以 bash 类审批的 `control_request` **能收到**，他们只是**主动拒掉**（`reader.rs` 的 deny 文案：`"This client cannot show tool-permission prompts"`）。
- **manual 模式下的 denial 是自愿的，不是协议限制。** 这对 cc-bridge 是决定性的：补一张审批卡就能接管，不需要改协议假设。

⚠️ 仍需实测的部分：那个 Bash 测试夹具是**手写的**，只证明解析分支存在，不证明真机 CLI 在 `--permission-mode default` 下一定发。**探针第一件事不变**：让 claude 跑一个必然触发审批的命令（如写工作区外文件），看有没有 `control_request{can_use_tool}` 回来，以及 `input` 里带不带 `requires_user_interaction`。

## 七、前端部分（克隆完成后补读）

前端 38587 行（`features/chat`），核心三块：`store/engine-events.ts`（2141）、`components/MessageTimeline.tsx`（775）、`components/ProcessDisclosure.tsx`（543）。

### 1. 最重要的架构结论：前端几乎零引擎分支

Rust 侧 `engine/events.rs`（654 行）把 11 个引擎归一成一个 `EngineEvent` 枚举，前端只有**一个** reducer。全仓搜 `engine ===` 命中 15 处，但绝大多数是**会话寻址的身份键**（`tab.engine === engine && tab.sessionId === …`），真正的行为分支只有 **2 处**：

- `agent-task-steps.ts:313` — `engine === "claude"` 决定 spawn 是否阻塞
- `engine-events.ts:1836` — `engine === "claude" || compactTurn`

⇒ **归一化必须放 Rust 层，别放前端。** 前端做分支的代价是每加一个引擎要改 N 个组件；放后端则只加一个适配器 + 一个枚举变体。这条直接对应 cc-bridge「批3 协议层」的分层决策。

### 2. 工具卡：三档分流，判据有两套且不一致

`ToolPayloadViewer.tsx` 按名称分流到 `FileDiffViewer` / `BashCommandViewer` / `GenericToolViewer`，但判据是**子串匹配**：

```ts
function isEditTool(name) {
  const lower = name.toLowerCase();
  return lower.includes("edit") || lower.includes("write")
      || lower.includes("patch") || lower.includes("diff");
}
```

问题：`TodoWrite`、`NotebookEdit`、带 `write` 的任意名字都会命中；反过来 **cc-bridge 自己的 `write_files` 会命中 edit 但 `parseEditArgs` 拿不到顶层 `path`/`content`（参数是 `files: [{path, content}]` 数组）→ 静默退化成 JSON 原文**。多文件工具完全渲染不出 diff。

而 `ProcessDisclosure.tsx:17` 另写了一套更稳的 **token 集合**判据（`toolTypeKey`，先切词再 `Set.has`），两套并存。

⇒ 要抄的话只抄 `toolTypeKey` 那套，并把工具→渲染器做成**显式注册表**（`toolName → renderer`），别用名字猜。多文件工具得单独一档。

### 3. Diff 算法有量级误差 —— 已实测

`edit-line-stats.ts::computeDiffLines` **不是 LCS**，只是裁掉公共首尾，中间**整段**当作「全删 + 全加」。逐字照搬后实测：

| 场景 | 真实 | 它算出 | 误差 |
|---|---|---|---|
| 20 行上下文里改 1 行（典型 Edit） | +1/−1 | +1/−1 | ✅ 准 |
| 24 行文件改 2 处 | +2/−2 | **+9/−9** | 4.5× |
| 60 行文件改 3 处 | +3/−3 | **+41/−41** | 13.7× |

规律：**单处连续改动准，分散多处改动退化成整段替换**。误差上界 = 首次改动到末次改动之间的跨度。

好在它另有一条 `parsePatchLines()` 能正确解析标准 unified diff（`@@` 头），所以只要引擎给 `patch` 字段就准。**但 Claude Code 的 `Edit` 给的是 `old_string`/`new_string`，正好走的是不准的那条。**

⇒ cc-bridge 别照搬。要么用 `patch`，要么上真正的 Myers/LCS（约 60 行），要么引库。diff 数字错了比没有更糟 —— 用户会拿它判断改动规模。

### 4. 一个值得抄的数据来源选择：行数统计走会话，不走 git

`createEditLineStatsBuilder` 从**会话转录**累计每个文件的行数增减，注释写明了理由：gitignored 目标（`.omp/**`）、非 git 仓库工作区、会话中途已提交的文件，`git status` 都看不见，但它们是真实编辑。

它还做了两级 memo：`WeakMap<Message>` 缓存单条计算 + 「编辑数组引用未变就返回上次结果」的短路。

⇒ 对 cc-bridge 直接可用：**变更文件面板别查 git**，查会话事件流。两者可以并存（git 给准确终态，会话给「这一轮动了什么」）。

### 5. 交互审批的 UX 先例：dock，不是弹窗

`QuestionCard.tsx`（469 行）的注释写得清楚：CLI 把问题 park 在控制协议上，**turn 在回答或忽略之前不会继续**。它的形态是**接管输入框区域**（header chip + 选项行 + 自由输入 + 忽略/提交 footer），不是模态弹窗。

⇒ 审批卡同理：**占住 composer 位置，不弹模态**。好处是上下文不丢、终端不遮、用户可以边看 diff 边决定。这跟 cc-bridge「浮层不占布局」的既有规矩也不冲突（composer 本来就是固定区）。

### 6. 过程折叠：`ProcessDisclosure` 的分组模型

连续的 tool/thinking 行被 `groupProcessSections` 归成 section（`thinking` 单条 或 `tools` 多条），配 `PROCESS_PAGE_SIZE = 40` 分页。行模型极简（`timeline-rows.ts:196` 行）：

```ts
type ProcessItem = { type: "tool" | "thinking"; text: string; live?: boolean;
                     path?: string | null; args?: unknown; result?: unknown };
```

⇒ 这是「流水账 → 可折叠区块」的最小实现，cc-bridge 若要给 CC 会话加侧栏，这个是现成骨架。若用 `path` 判断类型（`fileChipFor` 里还处理了 `file.ts:301-591:raw` 这种读选择器，以及 glob/URL 不给文件芯片），这些细节都值得直接抄。
