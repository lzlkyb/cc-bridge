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
| Skills over MCP | **2.1.331**（官方文档；更新日志的 Added 条目在 2.1.332，2026-11-27 核实） | 还要求：直连 Anthropic（自定义 `ANTHROPIC_BASE_URL`、`apiKeyHelper`、`ANTHROPIC_AUTH_TOKEN`、云厂商、`claude -p`、Agent SDK 均不支持）、较新模型、开启 feature-flag 拉取；API key 与 Console 登录目前未放量 |
| Tasks | **2.1.304**（终端 / Agent SDK / GitHub Actions，需拉取 feature flag；不拉取时需交互终端 ≥ 2.1.317），更新日志「Added support for MCP tasks in the terminal」在 2.1.319 | **VS Code 扩展 / 桌面 app 本地会话需 2.1.331+**；子代理发起的调用需 2.1.331+；2026-11-27 实测 2.1.332 正常 |
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

**版本号已于 2026-11-27 用官方文档和更新日志核实，结果见「阶段 0 真机记录」后的「遗留核实项结论」。注意：本文前面有关「2.1.330 起 `skills/get` 发送条件变了」「2026-11-21 引入加载」的说法，在更新日志和官方文档里都找不到依据，按未核实处理。**

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

### 阶段 0 真机记录（2026-11-27，第一轮）

探针日志落在 `%TEMP%\cc-bridge-mcp-probe.log`（每种「方法+协议+扩展+客户端」组合一行）。

**已确认（来自真实 Claude Code 会话，非 curl）**

| 事实 | 证据 |
|---|---|
| 协议版本是 `2026-07-28`（现代协议），不是 legacy `initialize` | 08:54 `server/discover`、`tools/list`、08:55 `tools/call` 三条记录 protocol 均为 2026-07-28 |
| **声明了 tasks 扩展** `io.modelcontextprotocol/tasks`，且每个请求都带 | 三条记录 extensions 均为 `[io.modelcontextprotocol/tasks]` |
| **没有声明 skills 扩展** | extensions 里只有 tasks 一项 |
| ~~`clientInfo` 在现代协议的每请求里取不到~~ **作废（探针 bug）** | `client=` 为空是因为探针只读了 `params.clientInfo`，现代协议的在 `_meta["io.modelcontextprotocol/clientInfo"]` 里，客户端名与版本其实都在。已修探针，下次真机就能直接看到 |
| 70 秒命令 `background:true` 需要 2 次 `wait_command`（0 秒探一眼 + 35 秒等完）才拿到结果 | 本轮调用实测 |

**对决策的影响**
- 阶段 2（Skills）：客户端没声明 skills，**instructions 保持逐字不变**，只能走「加一行指向」的保守方案，且收益要等客户端版本升级后再看；不要精简原说明。
- 阶段 1（Tasks）：客户端确实会声明 tasks，前提成立。

**未验证（本轮没测成，别当结论）**
1. **模型是否只看到最终结果、不再出现 `wait_command` 往返**——本轮 `background:true` 返回的是普通 handle，没有任务形态。原因不明确：08:51 我起的独立实例（7830，带 `CC_BRIDGE_TASKS=1`）被关掉，真实客户端 08:54 起连的是你自己起的 dev（pid 28444，默认标识、端口 7823、与正式版共用数据目录），**不确定它是否设了 `CC_BRIDGE_TASKS=1`**，所以这条 `background:true` 不能证明「客户端不处理任务」。
2. 超过 60 秒的前台命令是否仍断连、是否被自动转成任务。
3. ~~Claude Code 的最低版本号依然未核实~~ 已核实，见「遗留核实项结论」。

**下一轮要做的最小验证**：保证服务端确实带 `CC_BRIDGE_TASKS=1`（用 7830 独立实例最干净），客户端指到它，再发一条 `background:true` 的 `sleep 70`，看返回是不是任务形态、之后是否还要我手动 `wait_command`。

### 阶段 0 真机记录（2026-11-27，第二轮：服务端确认带 `CC_BRIDGE_TASKS=1`）

服务端是用户自己起的 dev（pid 26940，08:58:45 启动，带 `CC_BRIDGE_TASKS=1`）。

| 验证项 | 结果 | 证据 |
|---|---|---|
| 显式 `background:true` 的 `sleep 70` 是否被客户端当任务接管 | **是** | 返回文本变成「started server-side task … moved to the background as task …，you'll receive a notification」，不再是普通 handle |
| 模型是否还要手动 `wait_command` | **不要了** | 全程 0 次 `wait_command`；70 秒后由客户端收到完成通知，结果里带 stdout `task-done-09:01:18`、exitCode 0 |
| 客户端是否自己轮询 | 是 | 探针里 09:00:08 紧跟 `tools/call` 就有 `tasks/get` |
| 前台超 60 秒命令（不带 `background`，`sleep 75`） | **通过** | 服务端 50 秒自动转后台，客户端当任务接管，没有断连；75 秒后收到完成通知，stdout `fg-done-09:04:07`、exitCode 0，全程 0 次 `wait_command` |
| 取消 | **通过** | 再起 `sleep 120`，用 TaskStop 取消（探针记到 `tasks/cancel`），随后查进程：`sleep 120` 已消失，仅剩未取消的 `sleep 70` |

**结论**：阶段 0 通过标准（模型只看到最终结果、不再出现 `wait_command` 往返）**满足**，阶段 1（完整 Tasks）值得做。

**这次实测暴露的两点，阶段 1 一并处理**
1. 任务完成通知里的 result 是 `wait_command` 风格的元数据 JSON（`timeoutSec:0, finished:true, terminated:false, running:false, outputComplete:true, timedOut:false, matchedPattern:false…`）+ 输出，约 150 字符是纯噪声；可在 `tasks/get` 里改成精简形态（只留 `exitCode`、必要的异常标志、输出）。
2. 仍未验证：客户端的最低版本号；`tasks/get` 目前绕过审计，审计里 wait_command 条数会偏少。

**更正**：第一版记录里「`clientInfo` 取不到」是探针 bug，不是客户端没带（见上）。

### 阶段 1 完成记录（2026-11-27）

门禁：fmt、clippy `-D warnings`、1426 个单测全过。

| 项 | 做法 |
|---|---|
| 开关 | **默认开启**；环境变量 `CC_BRIDGE_TASKS=0/false/off` 应急关闭。**没有做成配置项和界面**：只有「声明了扩展却处理不好」的客户端才需要回退，不值得动配置结构、数据库、前端三处；若以后确实有用户要关，再补配置字段 |
| 通知精简 | `tasks/get` 终态结果的状态块去掉等于默认值的字段（`handle`、`timeoutSec`、`finished:true`、`terminated:false`、`running:false`、`outputComplete:true`、`timedOut:false`、`matchedPattern:false`），保留 `exitCode`、`elapsedSecs`、`stdoutTotalBytes` 与所有异常值；每次约省 150 字符 |
| 审计 | 只记 `tasks/get` 的**终态**（completed / cancelled）与 `tasks/cancel`，工具名就是方法名；运行中的轮询不记（客户端约每 1.5s 一次，全记会刷满日志），`tasks/update` 不记 |
| 探针 | 去掉写临时文件；`mcp::probe` 日志保留，默认日志级别改成 `error,mcp::probe=info` 使其可见 |
| CHANGELOG | 「变更」新增「长命令由客户端自动等待」 |

**已知取舍 / 待观察**
- 审计里会出现新的工具名 `tasks/get`、`tasks/cancel`，面板的工具分布里会多这两行；终态 `tasks/get` 的字节数计入工具账，替代原来 `wait_command` 的那一趟。
- 任务仍只在进程存活期内有效（内存表）：dev 实例重启后，客户端手里的旧 taskId 会得到 -32602。

### 阶段 2 完成记录（2026-11-27）

| 项 | 做法 |
|---|---|
| 技能文本 | `desktop/src-tauri/skills/local-edit-verify/`（唯一来源，没有 docs 副本），编译期 `include_str!`。**两个文件**：`SKILL.md`（1480 字节，只写省往返的核心用法，并指向参考文件）与 `references/pitfalls.md`（踩坑清单，遇到相关问题才读）。**踩坑每一条都先在当前版本实测再写**：`edit_files` 的 LF 与 CRLF 还原、新文本带 `\r` 被拒、GBK 保留编码与 CRLF、`search_files` 搜 GBK 中文需要 encoding、Git Bash 没有 iconv、重定向到输入文件本身会先清空、Python 文本模式写文件变 CRLF、文件工具只认白名单。**实测未复现、因此没写的**：「命令文本里的 `\r\n` 被桥提前转成真实字符」「`taskkill` 参数要关路径转换」；「旧文本带 `\r\n` 必然匹配失败」也已不成立（带 `\r\n` 的旧文本现在能匹配） |
| 模块 | `mcp/skills.rs`：目录首次使用时构建（sha256 摘要、字节数、frontmatter）；三个方法 `skills/list`、`skills/get`、`resources/read` |
| 安全边界 | `resources/read` 与 `skills/get` 对编译期目录**整串精确匹配**，没有路径解析、不碰磁盘；file://、绝对路径、`..`、末尾斜杠、大小写变体、未知技能全部 -32602（单测逐一覆盖）。`resources/list` 与 `resources/templates/list` 只回**空列表**（提交前自查时补的：声明 `resources` 能力后客户端可能调它们，回 -32601 会被当成服务器异常；技能靠 URI 直读）、不声明 `directoryRead`、不转发第三方技能 |
| 能力声明 | 只在 `server/discover` 里加 `resources:{}` + skills 扩展；`initialize` 与 SSE 完全不动（单测确认 initialize 没有 resources 与 extensions） |
| instructions | 按「是否声明 skills 扩展」分流：**没声明的客户端（目前的 Claude Code）拿到的文案与改动前逐字相同**，声明了的才多一行指向 `skill://local-edit-verify/SKILL.md`，加后仍不超 4096 字符 |
| 应急开关 | 环境变量 `CC_BRIDGE_SKILLS=0/false/off`（与 tasks 同款，默认开） |
| 头校验 | `resources/read` 与 `skills/get` 的 `Mcp-Name` 头按 `params.uri` 校验（其它方法维持原样） |

**诚实的现状**：真实 Claude Code 目前不声明 skills 扩展，所以这一阶段在现在的客户端上**不产生任何可见效果也不省 token**——它是为「客户端升级后自动生效」预先铺好的通道。等客户端声明了再做两件事：真机验证「模型按需加载技能」，以及再决定要不要精简 instructions 里已被技能覆盖的文字（现在不该精简，没声明的客户端靠它）。

### 遗留核实项结论（2026-11-27）

来源：anthropics/claude-code 官方 CHANGELOG.md 全文（下载后本地检索）与 code.claude.com 的 `mcp.md`、`skills.md`。

**① Claude Code 的最低版本**

| 能力 | 结论 | 依据 |
|---|---|---|
| Tasks（终端） | **2.1.304 起**。更新日志「Added support for MCP tasks in the terminal」在 2.1.319，那一版起不再依赖 feature flag；关闭 flag 拉取时需交互终端 ≥ 2.1.317 | 文档 “Terminal CLI sessions, Agent SDK sessions, and GitHub Actions runs have them on v2.1.304 or later” |
| Tasks（VS Code / 桌面 app 本地会话） | **2.1.331 起**，且会话要拉取 feature flag | 文档 “MCP tasks in VS Code and the desktop app” |
| Skills | **2.1.331 起**（文档）；更新日志 “Added skills from MCP servers (beta)” 在 2.1.332 | 文档 “MCP skills are in public beta and require Claude Code v2.1.331 or later” |
| 协议 2026-07-28 | HTTP 服务器默认协商自 2.1.274 起（云厠商与遥测关闭的安装），其它安装更早 | CHANGELOG 2.1.274 / 2.1.292 / 2.1.295 / 2.1.299 |

**① 的附带发现（对我们有用）**
- `CLAUDE_CODE_DISABLE_MCP_TASKS=1` 可关掉 Tasks；`CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1` 让客户端在调用内等任务，而不是立即转后台。用户遇到「命令不再返回」类反馈时可以先让他试第二个。
- 2.1.332 修复了「task ID 超过 128 字符报 malformed task handle」，现在上限 1,024。我们的 taskId 是命令 handle，约 20 字符，不受影响。
- 2.1.330：会话移到后台后“the background session can now follow the task, but **not if its server uses stdio or sets headers**”。cc-bridge 是带 `Authorization` 头的 HTTP 服务器，所以**会话被移到后台后，那个后台会话跟不上我们的任务**（前台不受影响）。这是客户端的限制，我们无法绕开。
- 退出 Claude Code 不会取消远端任务（即命令继续跑），`--resume` 同一会话才能再跟踪；这与我们「任务只在进程存活期内有效」一致。

**① 的对止结论：为什么真机里 Skills 没被声明？目前不能下结论**
- 本会话版本是 2.1.332（会话日志核实，2026-11-25 起），满足版本要求，所以不是版本问题。
- 已排除：会话 shell 里 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 均未设置（但这是工具 shell 的环境，不必然等于 CLI 进程的环境，**不能当作定论**）。
- 更可能的原因是：当时连的服务器在 `server/discover` 里没有宣称 skills 扩展（阶段 2 还没做），客户端可能只对宣称了的服务器声明。**这条没有测过**：需要用已包含阶段 2 的新构建再真机验证一次，看探针里 skills 是否出现在 extensions 里，以及 `/skills` 是否列出 `<server>:local-edit-verify`。
- 注意使用条件：即使声明了，走自定义 `ANTHROPIC_BASE_URL`、中转网关、`apiKeyHelper`、`claude -p`、Agent SDK 的用户也拿不到 MCP skills（官方明确列为不支持）。所以 skills 的受益面比 Tasks 窄得多。

**② 远端 MCP 会话 id 是否稳定（G 项「服务端按会话累计」的前提）—— 结论：前提不成立**
- 现代协议（2026-07-28）**没有协议级会话**，不存在 `Mcp-Session-Id` 可供服务端按会话归类。这也是 http.rs 里早就写明的：“新协议反而移除了协议级 session”。
- Claude Code 对 HTTP 服务器默认就协商 2026-07-28（2.1.274 起），真机探针也确认连接走的是这个版本。更新日志里唯一谈到 MCP session ID 的是「本地（stdio）MCP 服务器在 Remote Control 进程重启后看到新 session ID」，与我们无关。
- 能拿到的只有「来源 IP + clientInfo（名称、版本）」，这是**客户端级**而不是**对话级**标识：同一台机器上并行的多个终端会话无法区分，按字节累计会把它们混在一起，误报超阈值。
- 因此「远端会话累计 + 超阈值提醒」的方案在现有协议下**不可行**，建议从 G 项里删掉这一条，只保留 cc-bridge 自己内嵌 CC 会话的 ContextMeter 提示（那里会话已知）。
- 尚未实证的一点：客户端是否在 HTTP 请求头里带了别的会话标识。探针已加上「请求头名称」记录（只记名称不记值），下次真机即可直接看到。若出现类似 session id 的头，上面的「不可行」结论需要重新评估。

## 九、一句话总结

这次发布真正给我们的不是「又一个新特性」，而是**把踩坑经验变成可分发资产**的通道。`wrap(JobObject)` 与 `CreationFlags` 的顺序、`format:"raw"` 的消费点、50s 线、`start_paused` 禁用——这些现在散在 `MEMORY.md` 和无数注释里，只有我们自己看得见。Skill 让它们随服务器一起发给任何接上来的模型。模型会换，手册不会。
