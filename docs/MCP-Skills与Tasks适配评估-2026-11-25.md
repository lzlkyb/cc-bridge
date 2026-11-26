# MCP Skills / Tasks 适配评估（2026-11-25）

> 触发：MCP 两周年发布 Skills over MCP（public beta）、Tasks / Elicitation（GA）、File Uploads（rolling out）。
> 本文只做评估与方案，不含实现。改动需按 `MEMORY.md` 红线走（R1 先方案、R3 构建前先问、R10 改 Rust 必重编译）。

## 一、这次发布到底是什么

| 特性 | 扩展 ID | 形态 | 对我们的意义 |
|---|---|---|---|
| Skills over MCP | `io.modelcontextprotocol/skills` | 服务器把「办事手册」当资源发出去：`skills/list` + `skills/get`，文件走标准 `resources/read`（`skill://<name>/SKILL.md`）。**客户端只在需要时加载**，内容随 server 更新 | 正面命中我们最大的痛点：instructions 4096 截断线 |
| Tasks | `io.modelcontextprotocol/tasks` | `tools/call` 可立即返回 `resultType:"task"` + `taskId`，客户端自己 `tasks/get` 轮询，`tasks/cancel` 取消。与 2025-11-25 的实验版**不兼容**（删了 `tasks/result` / `tasks/list`） | 我们已有一套手搓等价物（handle + wait_command） |
| Elicitation | 已 GA | 工具执行中途暂停，经客户端表单/链接向真人要签字，然后继续 | 与我们 R17「不做弹窗确认」有张力，见 §六 |
| File Uploads | 未正式 | 客户端把 PDF/图片/表格**不经上下文**直接交给 server | 与我们 `/transfer` 直传重叠，见 §七 |

## 一之二、版本门槛（能不能跑起来，全看这三张票）

三张票必须同时到手，缺一张就是「代码写了但没人调」。

### 协议侧：官方协议已经更新，但方式是「开槽」不是「加方法」

- 基础协议修订版 **`2026-07-28`** 正式引入扩展机制：能力声明走 `server/discover` 的 `capabilities.extensions`，客户端能力走每个请求 `params._meta.io.modelcontextprotocol/clientCapabilities.extensions`。
- 因此 Skills / Tasks **不是**核心协议里的新方法，而是挂在槽位上的官方扩展。实现时**不能**像 `tools/list` 那样往 `match` 里塞一个分支就完事，必须做能力协商——没声明就不该被调用，被调用了也得能优雅拒绝。
- 扩展生命周期：Skills（SEP-2640）SEP 已 Final，但**扩展规范本身是 Beta**；Tasks（SEP-2663）**Beta，目的地是核心协议**（先在扩展里稳定，之后再进核心）；Elicitation 已 GA。
- Skills 的硬上限（宿主保证支持，服务器 SHOULD NOT 超）：每技能 **512 个资源条目**、单技能合计 **16 MiB**。Claude Code 另有 **512 KiB 的列表上限**，超了直接拉不到。

### 客户端侧：Claude Code 的门槛比想象中晚

| 能力 | 最低版本 | 备注 |
|---|---|---|
| Skills over MCP | **2.1.330**（2026-11-21 引入加载） | 实测 2.1.331 正常，`/skills` 显示 `Skills from MCP servers are in beta` |
| Tasks | **2.1.304**（终端） | **VS Code 扩展 / 桌面 app 会话需 2.1.331+** |
| Tasks 的排除项 | — | `claude -p` 一次性运行**没有** tasks；`MCP_PROTOCOL_NEGOTIATION=legacy` 会关掉；子 agent 里发起的不算 |

🔴 **2.1.330 起 `skills/get` 的发送条件变了**：不再无条件发，改成「连接已知使用 `2026-07-28`+ **且**服务器声明了 skills 扩展」才发。这条对我们影响很大——`http.rs:624` 的 `initialize` 是**回显客户端版本**的，走 legacy 握手报 `2025-06-18` 的客户端（例如 Codex 0.165）永远拿不到 skills。这是**符合规范的正常行为**，不是 bug，别上线后当故障排查。

🔴 还有一条容易踩的：`extensions` 字段**只该出在 `server/discover` 里**。`initialize` 属于 legacy 语义，其 capabilities 没有 `extensions` 定义，两处都加会让老客户端收到非规范字段。`initialize` 里最多补 `resources: {}`。

### 我们侧：协议层已就位，能力层全空

- 已有：`http.rs:593` 的 `server/discover`、`http.rs:575` 的 modern/legacy 判定、`SUPPORTED_VERSIONS` 首位 `2026-07-28`。
- 缺：`capabilities` 里没有 `resources`、没有 `extensions`；没有 `skills/list` / `skills/get` / `resources/read` 任何实现。**所以以今天的代码接上去，客户端什么也看不到——零变化，零风险。**
- 未知：WorkBuddy 桌面宿主是否实现该扩展。它不发 `_meta` 走 legacy，就永远走不到 skills 分支；这一点反而让改造天然安全。

## 二、现状差距（对着代码核过）

| 项 | 现在 | 缺口 |
|---|---|---|
| capabilities | `http.rs:599`、`http.rs:634` 只有 `tools:{listChanged:false}` | Skills **MUST** 同时声明 `resources:{}` 与 `extensions[".../skills"]` |
| 资源层 | 全仓无 `resources/list` / `resources/read` / `prompts/*`（已 grep 确认） | 需要从零加，且**只能**加受控的一小块 |
| instructions | `http.rs:1105 build_instructions`，第 1–5 条硬规则挤在最前，测试 `instructions_under_client_limit` 死守 4096 | 已经贴着截断线，再多一条就掉字 |
| 长任务 | `run_command` 超 50s 自动转后台（`HANDOFF_MS`）→ 返回 `handle` → `wait_command` 轮询；`CLIENT_SAFE_WAIT_SECS=50`（`tools/mod.rs:106`）是为「客户端约 60s 断开」打的补丁 | 语义上就是 task：有 handle、有状态查询、有 cancel，**缺的只是协议皮** |
| 长任务存活 | `state.running_commands` 在内存 | 进程重启即丢；Tasks 的 `tasks/get` 语义要求「返回 taskId 时已持久创建」 |
| SSE transport | `sse.rs:214` 是**独立**的方法 match（只有 initialize / tools/list），且缺 `resultType` / `isError` | 新方法要两处都加，否则远程 SSE 客户端看不到 skills |

## 三、结论：做两件，观察一件，搁置一件

| 候选 | 收益 | 成本 | 风险 | 判断 |
|---|---|---|---|---|
| **Skills** | 高：把手册从每轮上下文的 4096 里搬出来，按需加载 | 低：2 个方法 + 1 段只读资源 + 内置文本，零新增依赖（`sha2` / `uuid` 已在 Cargo.toml） | 中：服务器写的文本会被模型信任 | **先做** |
| **Tasks** | 中高：客户端原生后台，省掉模型自己 wait 的往返；跨连接可取结果 | 中：协议皮薄，但持久化是真成本 | 中：不兼容旧实验版；客户端支持面窄 | **第二步**，复用现有 handle |
| Elicitation | 中 | 低 | 高：与 R17 直接冲突 | **待你决策** |
| File Uploads | 中 | — | — | **观察**，等 spec 定稿 |

顺序理由：Skills 是纯增量（客户端没声明就完全不发），能立刻解决我们已经顶到墙的 instructions 问题；Tasks 的价值要等「模型真的在后台跑几分钟」才体现，而我们现在用 50s 转后台 + wait_command 已经能干活，属于优化而非救火。

## 四、Skills 落地方案

### 4.1 协议契约（照规范逐条，不能省）

- `server/discover` 的 capabilities 加 `resources: {}` 与 `extensions: { "io.modelcontextprotocol/skills": {} }`（**不**声明 `directoryRead`，我们不实现 `resources/directory/read`）。
- `initialize`（legacy 语义）**只**补 `resources: {}`，**不加** `extensions`——见 §一之二的红线。
- `skills/list`：返回 `resultType:"complete"` + `skills[]` + `ttlMs` + `cacheScope`。每项含 `uri`（`skill://<name>/SKILL.md`）、`frontmatter`（name / description **必填**）、`resources[]`（每个文件 `uri` + `digest:"sha256:..."` + `size`）。
- `skills/get`：按 SKILL.md 的 uri 查单条。**必须对每个 serve 的 skill 都答得出**，即使 list 里没列。
- `resources/read`：真正的内容出口，按 uri 返回 `contents[{uri, mimeType:"text/markdown", text}]`。
- `cacheScope` 用 `private`：我们的 skill 文本里会带本机平台与路径约定（同 `http.rs:614` 的理由）。
- `ttlMs` 给 1 小时，与 `tools/list` 的 `3600000` 一致，避免两套缓存策略打架。
- 条目数与体积守住 512 / 16 MiB（我们是内置两三个 skill，天然远低于线）。

**上线后「看不到 skill」的四个已知原因**（写给运维自己，省得反复怀疑实现）：客户端版本低于 2.1.330；连接走了 legacy 握手（Codex 一类只发 `initialize` 的宿主）；Claude Code 的安全 scan 尚未完成或拒绝（提示 `scan ... has no result yet` / `cannot take it`）；组织策略把它标成 `turned off by your organization` 或 `ask-only`。这四种都发生在客户端侧，服务器日志里看起来一切正常。

### 4.2 🔴 安全红线：`resources/read` 只服务内建 skill

这是本次改动**唯一**能掀翻安全模型的地方，必须写死：

- 只应答 `skill://` 前缀、且 uri 精确命中内建 manifest 的请求 —— 等价于一张**编译期固定的白名单表**。
- 其余一切 uri 一律 `-32602`，**绝不**回落到「读磁盘某个路径」。
  我们有 `security::path` 白名单、扩展名白名单、只读模式，全部挂在 **tools** 层。一旦 `resources/read` 能读任意文件，就等于开了一条绕开全部闸门的旁路（只读模式形同虚设）。
- 不做 `resources/list`（规范不要求，声明了反而要维护全集）；skill 的发现只走 `skills/list`。

另一条：**不外挂 server 的 skill**。`mcp_proxy` 会把第三方 server 的工具转发进来；如果顺手把它们的 skills 也透传，等于让第三方文本直接指挥本机 shell —— 这正是 tool poisoning 的升级版。第一版只发 cc-bridge 自己的、编译进二进制的文本。

### 4.3 第一份技能写什么

我的建议：`local-edit-verify`（本机改代码 → 验证闭环），而不是写一份「cc-bridge 使用总纲」。

理由来自我们自己的数据（`http.rs:1123` 注释）：`run_command` 占 46% 调用次数、avg 仅 5.2KB；19% 的调用吃掉 81% 墙钟。也就是说模型最常干的事是「拿 shell 干文件活」，最容易犯的错是：

1. 改完不验证，或验证方式错（全量跑测试而不是先跑单文件）；
2. 该并行/该 batch 的串着做，每趟重发整段上下文；
3. 长命令把会话挂死，或者该等的时候反复 `get_command_output` 轮询。

这三条正好是 instructions 里**只剩一行位置**、说不透的部分。手册可以写：

```
1. 定位：search_files 拿行号 → read_files startLine/endLine 读段（>500 行禁整读）
2. 改：edit_files；同一文件多处改动串行
3. 验证：改完立刻 batch{ run_command 编译/测试 }，不要先回一句「我改好了」
4. 判读：run_command 默认不回 JSON，stdout/stderr 是不转义的独立文本块；
   看 exitCode 与 stderr 尾部，别把 [stderr] 当正文
5. 长命令：>50s 会自动转后台返回 handle；等到期用 wait_command(untilPattern)，
   禁轮询；真跑十几分钟才 background:true
6. 收尾：预计 >1min 的任务完成后 push_notification
```

同样值得排进第二批的：(a) `large-file-transfer`（`prepare_upload`/`prepare_download` + `/transfer` 一次性票据，禁 base64）；(b) `ssh-remote-edit`（`ssh_file_cmds` + 编码陷阱，逻辑最复杂，`docs/远程文件编辑-2026-11-17.md` 已写好现成素材）。

### 4.4 instructions 与 skill 的分工：按客户端能力分支，不能一刀切

有 Skills 之后最容易犯的错是「反正有手册了，把 instructions 删一删」。**不行**：Team 要管理员开、Enterprise 没上、WorkBuddy 桌面宿主未知。老客户端只会永远拿不到手册。

正确做法是复用现成的 `ClientKind` 机制（`client_kind.rs`，已经在按 clientInfo 分支措辞）：

- 客户端**声明了** skills 扩展 → instructions 精简成「是什么 + 三条最硬禁令 + 一句『详细工作流见 skills/list』」，把省出来的几百字符留给安全约束；
- 未声明 → **逐字保持现状**，一行不改。

这样是纯增益，没有任何客户端回退。

### 4.5 代码落点

| 位置 | 改动 |
|---|---|
| `mcp/skills.rs`（新） | 内置 skill 文本（`include_str!` 或 const）、manifest 装配、sha256 摘要缓存（`OnceLock`）、`skill_uri` 白名单查表 |
| `http.rs:593` / `http.rs:618` | `server/discover` 加 `resources` + `extensions`；`initialize` 只加 `resources`；instructions 按能力分支 |
| `http.rs::mcp_handler` match | 加 `skills/list`、`skills/get`、`resources/read` 三个分支 |
| `sse.rs:214` | 同三个分支；**顺手补齐缺失的 `resultType` / `isError`**（MCP.md §五 已登记的技术债，同一处改动别拆两个 commit） |
| `Cargo.toml` | 无需新增：`sha2 0.10`、`uuid`、`rusqlite` 都已在 |

skill 文本放 `desktop/src-tauri/skills/<name>/SKILL.md`（随二进制 include），另外在 `docs/` 留一份可读副本——两处必须同源，用测试守住（读 `include_str!` 的结果与 docs 副本比对）。

## 五、Tasks 落地方案（复用现有机制，不新建状态机）

关键洞察：`running_commands` 里的每一条**已经是一个 task**——有 id（handle）、有状态（running/finished/timeout）、有取消入口（`stop_command`）、有结果查询（`get_command_output`）。所以 Tasks 适配是加协议皮，不是重写执行层。

要做的事：

1. `server/discover` 的 capabilities 加 `extensions: { "io.modelcontextprotocol/tasks": {} }`（`initialize` 不加，同 §一之二）。
2. `tools/call` 时读 `params._meta` 里的 `io.modelcontextprotocol/clientCapabilities.extensions` 是否含 tasks。**含**才可能返回 `resultType:"task"`；不含则走现有路径（`backgrounded:true` + `handle`）——这条保证了零回归。
3. 新方法 `tasks/get`（→ 查 `running_commands`，映射 working/completed/failed/cancelled）、`tasks/cancel`（→ 等价 `stop_command`）。
4. `pollIntervalMs` 给 1000–2000：我们的进度粒度是「读管道缓冲」，比外部服务细，不需要 5s。
5. `ttlMs` 必须**诚实**：内存表在进程退出后即失效。第一版把 `ttlMs` 设成「进程存活期内有效 + 明确文档化」，不做持久化；等有人真抱怨「重启后任务丢了」再落 SQLite（`db.rs` 现成）。

不建议现在就做的部分：规范要求「返回 taskId 时任务已耐久创建」，我们满足不了跨重启；不要为了凑语义去承诺做不到的 ttl。宁可限制能力，不可撒谎。

另一个真实收益值得单独说：`CLIENT_SAFE_WAIT_SECS = 50` 是为「客户端 60s 断开」写的补丁，`wait_command` 的 `MAX_TIMEOUT_SEC = 55` 也是（`wait_command.rs:39`）。Tasks 生效后，客户端自己轮询，**这条 50s 线在支持 tasks 的客户端上可以不再约束业务**——但要等真机验证，别提前删。

## 六、Elicitation 与 R17 的张力（需要你拍板）

R17 写的是「不做弹窗确认，安全靠白名单 + 备份 + 审计 + 熔断，高危工具留总开关」。

Elicitation 和它有本质区别：**弹窗是客户端画的，不是我们画的**。我们只在 `delete_files` / `remove_directory` 这类真·不可逆操作里返回「需要确认」，用户在 Claude Code / 桌面宿主里看到它自己的表单——这不违反「我们不做确认弹窗」的原意，反而补上了现在最薄的一环：AI 一次调用删掉整个目录时，用户完全不知道。

但它引入一个新失败模式：客户端不支持或用户关了，调用就卡在 `input_required`。所以要么做成**默认关的开关**，要么只对「回收站之外的真删除」启用。我的建议是做成开关 + 默认关，先不动 R17 的默认行为。这条不先做，等你定。

## 七、File Uploads：与 `/transfer` 重叠，先观察

我们的 `/transfer` 已经是「字节不经上下文」的直传，且票据机制是内存一次性（安全防线在那）。File Uploads 的真增量只有一处：**AI 侧不用自己跑 curl**。目前 `prepare_upload` 返回 URL 后要靠模型执行 `curl -T`，个别宿主禁 shell 就会断。

但 spec 还在 rolling out、SDK 支持面窄，且它和 `/transfer` 的票据模型如何合并（客户端上传也要一次性票据吗？）没定。**先观察，不动**。真要做，入口是 `prepare_upload`：客户端声明该扩展时，改为直接接受文件流。

## 八、建议顺序与验收

1. **Skills（本批）**：`skills/list` + `skills/get` + 受控 `resources/read`；第一份 skill = `local-edit-verify`。
2. **Tasks（下一批）**：能力协商 + `tasks/get` + `tasks/cancel`，复用 `running_commands`。
3. **Elicitation**：等你决策（建议开关 + 默认关）。
4. File Uploads：观察。

验收必须包含真机（本项目惯例：单测覆盖形状，客户端行为只能真机看）：

- [ ] `server/discover` 的 capabilities 与规范逐字对齐（单测）
- [ ] `skills/list` 的每项都能被 `skills/get` 命中；manifest 的 sha256 与 `resources/read` 实际返回字节一致（单测，变异验证必须看到 FAILED）
- [ ] `resources/read` 对 `file://`、绝对路径、`skill://xxx/../../etc/passwd` 一类输入全部 `-32602`（单测，这是安全回归闸）
- [ ] SSE transport 三条新方法可用（`sse.rs` 缺 `resultType` 的历史债同批补）
- [ ] 真机：Claude Code（**≥ 2.1.330**，桌面/VS Code 会话 ≥ 2.1.331）连上后 `skills/list` 被调用、skill 按需加载、instructions 走了精简分支；`/mcp` 的 Protocol 行应显示 `2026-07-28`
- [ ] 真机：**不声明** skills 的客户端（老版本 / WorkBuddy）instructions 与改动前逐字相同（`instructions_under_client_limit` 现有测试即守这条）

## 八之二、token 消耗视角（2026-11-25 补充）

结论：**若目标是压 token，Tasks 的收益比 Skills 更确定**，两个都值得做。数据来自 `docs/远端MCP-token消耗归因与优化-2026-11-25.md` §2.4 / §2.6.3。

| 特性 | 对 token 的影响 | 依据 |
|---|---|---|
| Tasks | **有可测的直接收益，约 2.6%** | `wait_command` 单独占一趟往返 1,813 次，占全部输入 token 2.63%。客户端自己轮询不进模型上下文，这些往返直接消失 |
| Skills | **直接省的很少，价值在引导行为** | instructions + 工具定义命中缓存后只占约 0.25%，搬走也省不了多少。真正的价值是让手册不再受 4096 字符限制，把「怎么用才省 token」说透 |
| Elicitation | 无 | 安全/体验特性 |
| File Uploads | 很小 | 只省一次 `curl -T` 往返，传大文件的场景本来少 |

**Skills 的 token 向用法**：把以下规则写进手册（现在只能在 instructions 里用一两句话带过）：同一文件改完立刻用 batch 跑验证、禁止轮询、按行范围读文件、搜索用纯文本、改文件不要要求回显 diff。§4.3 的 `local-edit-verify` 草稿与 2026-11-25 已改的默认值一致（命令输出默认纯文本、改文件不回显 diff、超过 1 分钟的任务才通知）。

**Tasks 的 token 向注意点**：收益取决于用户的客户端版本分布（`claude -p` 一次性运行、旧版本、部分宿主没有 Tasks），实施前先查实际分布；返回的任务结果仍会进一次上下文，省的只是轮询那几趟。

**本文里这些引用的版本号和规范编号（如 2.1.330、2.1.304、SEP-2640、SEP-2663）尚未用官方资料核实**，实施前先核对，并用真机验证 `/mcp` 的 Protocol 行是否为 `2026-07-28`。

**建议顺序（token 目标下）**：先提交并发布已改的 7 项 → Tasks → Skills（第一份 `local-edit-verify`，instructions 按客户端能力精简）→ Elicitation 等决策、File Uploads 观察。上下文占用提示（G）与这两项互不依赖，可并行。

## 八之三、已确认的实施规划（2026-11-26）

### 对本文前文的修正（已按规范原文核对）

核对来源：[SEP-2663 Tasks](https://modelcontextprotocol.io/seps/2663-tasks-extension)、[SEP-2640 Skills](https://modelcontextprotocol.io/seps/2640-skills-extension)。

- Tasks 有**三个**方法：`tasks/get`、`tasks/update`、`tasks/cancel`（前文 §五 漏了 `tasks/update`）。
- **服务端是「是否创建任务」的唯一决定者**，客户端不能在请求里指定；客户端没声明扩展时服务端 MUST NOT 返回任务。
- 没声明扩展的客户端调 `tasks/*` 要回 `-32021`（带 `requiredCapabilities`）。
- HTTP 上 `tasks/*` 请求的 `Mcp-Name` 头必须等于 `params.taskId`（我们原来只校验 tools/call，已补）。
- 命令退出码非 0 仍算 `completed`，`failed` 只用于 JSON-RPC 错误。
- Skills 的 512 条目 / 16 MiB 限制、`skills/list` 每项必带 `digest` 与 `size`、能力声明在 `server/discover` 的 `extensions` 里，均已核实。
- **未核实**：Claude Code 对这两个特性的最低版本（前文写的 2.1.330 / 2.1.304 规范里没有）。本机近 3 天会话日志版本分布：2.1.316（最多）/ 2.1.304 / 2.1.332 / 2.1.296。
- **最关键的未证实点**：Claude Code 收到任务后是自己轮询、只把最终结果给模型，还是把轮询暴露给模型。「Tasks 省约 2.6%」完全取决于前者。

### 五点决策（已确认）

1. 先做阶段 0 探针，探针通过再做完整 Tasks。
2. Tasks 只覆盖 `run_command` 的后台转交（显式 `background:true` 和 50 秒自动转后台），不扩到所有工具。
3. `tasks/update` 只回空确认（我们永远不会进入 `input_required`）。
4. SSE 传输与 `initialize`（老协议）不支持这两个扩展，文档里写明。
5. 技能文本只留一份，放 `desktop/src-tauri/skills/<name>/SKILL.md`，不再在 `docs/` 留副本（前文 §4.5 的「两份 + 比对测试」作废）。

### 阶段 0：探针（不改变任何默认行为）

**状态：代码已写，门禁通过后填结果；未提交。**

- 新模块 `mcp/tasks.rs`：开关是环境变量 `CC_BRIDGE_TASKS=1`（默认关，免得为可能被放弃的实验动配置结构和界面）。
- 开关打开时：`server/discover` 声明 tasks 扩展；顶层 `tools/call` 的 `run_command` 转后台且客户端已声明扩展时，把原来的 `backgrounded + handle` 包成任务结果（`taskId` = 现有 handle）；实现 `tasks/get`（复用 wait_command 的“只看一眼”）、`tasks/cancel`（复用 stop_command 的 terminate）、`tasks/update`（空确认）。`run_command` 与 `batch` 本身不改，batch 子操作永远不会变成任务。
- **不受开关控制的探针日志**：每种“方法 + 协议版本 + 客户端声明的扩展 + clientInfo”组合只记一条，日志目标 `mcp::probe`，内容形如 `客户端能力 method=... protocol=... extensions=[...] client=...`。这条要先跑一段时间，回答“真实 Claude Code 声明 tasks / skills 了吗”。

**真机验证清单（需用独立端口的开发构建，不碰已安装的 cc-bridge-desktop.exe；构建前先问用户）**：

- [ ] 用 `CC_BRIDGE_TASKS=1` 启动开发构建，让一台真实的 Claude Code 连上来，查 `mcp::probe` 日志：它声明了 `io.modelcontextprotocol/tasks` 吗？协议版本是什么？
- [ ] 让它跑一个超过 50 秒的命令：模型看到的是“最终结果”还是“任务句柄 + 自己去轮询”？会话里有没有出现 `wait_command`？
- [ ] 超过 60 秒的命令还会不会触发客户端断线。
- **通过标准**：模型只看到最终结果、不再出现 `wait_command` 轮询往返。不通过则 Tasks 不值得做完整版，直接转阶段 2。

### 阶段 1：Tasks 完整版（探针通过后）

把开关从环境变量改成正式配置项并默认开启；`ttlMs` 如实取结果保留时长（进程存活期内有效，不承诺跨重启）；补 `tasks/get` 走审计（现在直接调 wait_command::handle，绕过了审计，审计里 wait_command 条数会减少）；补 CHANGELOG。

### 阶段 2：Skills

- 新建 `mcp/skills.rs`，技能文本 `include_str!` 编进二进制，sha256 摘要与大小启动时算一次。
- `server/discover` 加 `resources:{}` 与 skills 扩展声明；**`initialize` 完全不动**（老协议客户端用不上，不动最安全）。
- 三个方法：`skills/list`、`skills/get`、`resources/read`。**`resources/read` 只认编译期写死的 `skill://` 白名单，其余一律 `-32602`，绝不读磁盘**；不做 `resources/list`，不转发第三方 server 的技能。
- 第一份技能 `local-edit-verify`，内容按 2026-11-25 已改的默认值写：改文件只回行数、搜索纯文本、命令输出默认不转义、50 秒内前台跑、顺序步骤用 batch、超过 1 分钟才通知。
- instructions 只加一行指向 `skill://local-edit-verify/SKILL.md`；**是否精简原说明文字，等阶段 0 的探针日志确认客户端确实声明了 skills 再定**，没声明就逐字保持现状。
- 测试：list 与 get 一致、摘要等于实际字节的 sha256、大小不超限、`resources/read` 拒绝 `file://`、绝对路径、`..` 和未知技能、4096 字符的现有测试不破。

### 阶段 3：收尾

每阶段独立提交、每次都过 fmt / clippy / 单测门禁；真机验收由用户配合；CHANGELOG 写面向用户的说明。

## 九、一句话总结

这次发布真正给我们的不是「又一个新特性」，而是**把踩坑经验变成可分发资产**的通道。`wrap(JobObject)` 与 `CreationFlags` 的顺序、`format:"raw"` 的消费点、50s 线、`start_paused` 禁用——这些现在散在 `MEMORY.md` 和无数注释里，只有我们自己看得见。Skill 让它们随服务器一起发给任何接上来的模型。模型会换，手册不会。
