# 外部 MCP 客户端上下文共享：GitHub 实现调研

调研日期：2026-11-18。范围仅为外部工具原生聊天，不涉及 cc-bridge 对话功能。

## 1. 结论

最贴近需求的是 **deja-vu**，自动采集/注入最值得研究的是 **claude-mem**，已有 Codex Hook 适配且部署形态便于桥接的是 **mcp-memory-service**，长期结构化知识可参考 **Basic Memory**。

这些项目让方案可以更具体：

> 外部客户端本机的只读转录采集器 / 官方 Hooks → 归一化事件和共享存储 → 小型当前工作交接包 + 历史检索 → B 的启动 Hook 注入或 MCP handoff 工具恢复。

MCP 是共享存取渠道。自动化来自宿主侧采集和注入，不能只配置 MCP 就假定所有对话已被拿到。与上一版方案相比，应把“自动只读采集 + 持续补齐”作为主要研发路线，把“让 AI 主动 save”保留为通用兜底。

本次实际查阅了六个项目的 README、仓库信息，并对前五个进一步检查架构、Hook 配置、解析或恢复源码。未安装运行，未复现其公开基准。Star、许可证和功能描述是本次访问快照，不构成质量认证；链接指向会变化的 main/HEAD。

## 2. 项目对比

| 项目 | 本次 Star 快照 | 核心方法 | 与需求的关系 | 许可快照 |
|---|---:|---|---|---|
| [deja-vu](https://github.com/vshulcz/deja-vu) | 1,612 | 多客户端历史转录索引、Hooks、MCP handoff | 最直接覆盖外部工具跨客户端接续 | MIT |
| [claude-mem](https://github.com/thedotmack/claude-mem) | 118,066 | Hooks → worker/observer → SQLite → 开场注入与按需检索 | 自动采集/恢复实现较完整，但知识压缩不等于完整原文迁移 | Apache-2.0，已查看 LICENSE |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 2,136 | 共享记忆 API/MCP + 客户端 Hooks + 选择性捕获 | 可作为外挂服务做最小跨工具验证 | Apache-2.0，已查看 LICENSE |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 4,616 | Markdown 知识源 + 索引 + MCP + 会话插件 | 适合长期事实、任务和决策；不等于全量聊天备份 | AGPL-3.0 |
| [session-handoff](https://github.com/yuzushi-dev/session-handoff) | 67 | 不可变交接记录、MCP、插件、CLI 启动器/迁移器 | 适合研究交接包与失败恢复，不能当成通用成熟兼容层 | MIT |
| [project-butler](https://github.com/JamesShi96/project-butler) | 377 | 项目日志、wiki、TODO、handoff Markdown 与规则 | 简单可审阅的兜底方案，主要依赖技能和规则配合 | MIT |

## 3. deja-vu：最贴近跨外部工具上下文的参考

### 采集

它没有要求每个模型先学会保存记忆，而是读取各工具已落盘的数据。架构文档列出 Claude 的 `~/.claude/projects` JSONL、Codex rollout JSONL/压缩文件、Cursor 状态库和 agent transcripts 等来源，并将它们归一成共同的 session/message 模型。

索引使用自定义追加记录与倒排结构，不是 SQLite；manifest 保存源文件状态、游标和去重信息。可以增量读取，也能从旧记录补建。这说明 cc-bridge 不应把“启用以后模型主动提交的摘要”当成唯一来源。

来源：[架构及源格式](https://github.com/vshulcz/deja-vu/blob/main/docs/ARCHITECTURE.md)、[Codex 解析器](https://github.com/vshulcz/deja-vu/blob/main/internal/sources/codex.go)。

### 恢复与跨工具交接

CLI 有 `deja handoff --to codex`，MCP 同样暴露 handoff。`mcp_handoff.go` 明确为无法运行 shell 的宿主提供同样的交接内容，选定来源 session 后调用 `digest.Handoff`，返回有预算限制的文本。

`digest.Handoff` 从真实 session 组织问题、已得结论和停止位置，处理压缩摘要与 Hook 自身产生的噪声；不是把 A 的原生 ID 交给 B resume。其 README 把原生 resume 和跨工具 handoff 分为两个功能。

来源：[MCP handoff](https://github.com/vshulcz/deja-vu/blob/main/cmd/deja/mcp_handoff.go)、[交接包构建](https://github.com/vshulcz/deja-vu/blob/main/internal/digest/handoff.go)。

### 自动触发

Codex 插件配置实际注册 SessionStart、UserPromptSubmit、PreCompact 等 Hook，分别进行开场回忆、提示相关查询和压缩前保存。MCP 安装与自动回忆安装可以分开：能被查询不等于每次自动注入。

来源：[Codex Hook 配置](https://github.com/vshulcz/deja-vu/blob/main/codex-plugin/hooks/hooks.json)。

### 借鉴与限制

- 优先借鉴只读 source adapter、增量索引、跨工具通用事件、handoff MCP 工具和来源标记。
- 不必移植其完整自定义索引；cc-bridge 初期可用现有 Rust + SQLite/FTS5。
- 支持的工具数量、检索速度和基准成绩均是项目自述，本次未复测。
- 源数据在客户端本机。远程 AI 主机需要采集端；仅在文件主机安装桥无法直接获得远端 home 中的转录。
- 私有日志格式会演进，需要固定版本 fixture；不能把“能解析”当成官方稳定 API。

## 4. claude-mem：采集与注入的完整链路

### 工作机制

Hooks 将工具活动交给本地 worker，旁路 observer 将活动转成 observations 和 summaries，SQLite 保存会话、观察和摘要；项目还使用语义检索组件。下次会话先拿简短索引，需要时再查询细节。

MCP 源码明确采用三步检索：`search → timeline → get_observations`。这比每次把全部历史塞给 B 更节省窗口，也保留了回到原始依据的能力。

来源：[README 架构说明](https://github.com/thedotmack/claude-mem#how-it-works)、[MCP 检索实现](https://github.com/thedotmack/claude-mem/blob/main/src/servers/mcp-server.ts)。

### Codex 已存在适配实现

本次看到的 Codex adapter 解析 `transcript_path`、`last_assistant_message`、`turn_id` 等字段，输出通过 `hookSpecificOutput.additionalContext` 传入模型。context handler 把给模型的 additionalContext 与用户可见 systemMessage 分开。Codex Hook 配置还提供 Windows 命令路径。

来源：[Codex adapter](https://github.com/thedotmack/claude-mem/blob/main/src/cli/adapters/codex.ts)、[context handler](https://github.com/thedotmack/claude-mem/blob/main/src/cli/handlers/context.ts)、[Codex Hook 配置](https://github.com/thedotmack/claude-mem/blob/main/plugin/hooks/codex-hooks.json)。

这修正了上一版“Codex 只能先按手动模式研究”的保守程度：现在有可阅读、可试验的第三方实现，应把外部 Codex 自动模式纳入首批验证，但仍不能直接宣称 cc-bridge 的具体版本已通过。

### 借鉴与限制

- 借鉴宿主适配器 → 标准事件 → 共享服务的分层，以及索引先行、细节后取。
- 对“当前任务继续”另外保留结构化 checkpoint；通用相关性检索未必能找齐最新约束和 pending 工作。
- observer 引入模型调用成本、延迟、外部披露与摘要误差；不能把模型摘要当作原始事实。
- README 明确部分客户端只能搜索既有记忆、不记录自己的会话，应学习这种按功能拆开的兼容矩阵。
- 依赖和旁路 worker 较多；cc-bridge 不宜为了共享上下文整体移植其完整产品。

## 5. mcp-memory-service：更便于独立服务试验

### 工作机制

共享后端提供 MCP 与 HTTP API，客户端 Hooks 负责采集/检索。Codex 文档描述 SessionStart 取项目记忆并返回 additionalContext，Stop 选择性捕获决策、错误、经验并保存增量结果，PreCompact/SessionEnd 尝试检查点。

源码中的 `parseTranscript` 处理 Codex rollout，跳过合成的 AGENTS/environment 消息，并只接受适合保存的助手最终响应。默认配置有记忆数量、字符预算和每次捕获上限；可见它保存的是选择后的知识，不是保证完整聊天镜像。写入按内容 hash 去重，检索失败可使用缓存并区分提示。

来源：[Codex 配置与事件表](https://github.com/doobidoo/mcp-memory-service/blob/main/codex/README.md)、[采集/注入源码](https://github.com/doobidoo/mcp-memory-service/blob/main/codex/memory-hook.js)。

### 借鉴与限制

- 借鉴薄 Hook + 远端共享 API：客户端采集与桥的数据服务可以分开部署。
- 借鉴显式“加载了几条、保存了几条、缓存降级”的用户反馈。
- 若通过已有 MCP 外挂能力临时验证记忆共享，必须另配宿主 Hooks 和 HTTP 接口；只转发 MCP server 不会自动完成采集。
- 不能把它的选择性记忆捕获当作完整对话保存；cc-bridge 仍需明确覆盖范围。

## 6. Basic Memory：长期知识与当前状态分离

Markdown 是可读知识源，索引负责搜索，MCP 支持多个客户端读写同一知识集；另有 Claude/Codex 插件连接工作上下文与持久知识。

Codex 插件明确将开场定位、决策、任务和 checkpoint 分开。部分 checkpoint 是 Hook 提示模型执行技能后，由模型根据当前上下文编写；不能仅因有 Hook 就视为确定性全量转录。它还把恢复笔记视为上下文，要求当前用户请求、仓库规则和实时状态保持权威。

来源：[知识存储机制](https://github.com/basicmachines-co/basic-memory#how-it-works)、[Codex 插件](https://github.com/basicmachines-co/basic-memory/blob/main/plugins/codex/README.md)、[SessionStart 入口](https://github.com/basicmachines-co/basic-memory/blob/main/plugins/codex/hooks/session_start.py)。

适合借鉴可导出 Markdown、任务/决策/会话 schema、不可变 checkpoint 及来源链。直接复用其代码需按 AGPL-3.0 评估分发/服务方式；独立研究其数据分层思路不意味着引入同一依赖。

## 7. 两个补充参考及其成熟度边界

### session-handoff

采用 MCP `handoff_create/read/list/search`，交接记录集中保存、不可变并返回 `handoff://...` 引用；源码有独立 handoff store。PreCompact 的恢复证据与语义交接包分开，失败启动保留阶段信息。

不过其 README 的自动切换依赖包装 CLI 启动器，明确不覆盖桌面/IDE 会话；环境要求主要面向 Linux/macOS。本次看到兼容矩阵中多组当前客户端组合仍为 `not-run`，不能用 README 小样本成功率推定所有版本可用。

来源：[交接存储](https://github.com/yuzushi-dev/session-handoff/blob/main/server/handoff_store.py)、[兼容矩阵](https://github.com/yuzushi-dev/session-handoff/blob/main/docs/compatibility.md)。

借鉴不可变交接引用、恢复证据/语义摘要分离、失败阶段日志；不把写入另一客户端私有原生会话格式作为 cc-bridge 首选路线。

### project-butler

把项目 wiki、session logs、TODO 和 `session-handoff.md` 分开；Claude 使用技能，Cursor/Codex 通过项目规则和 AGENTS.md 引导。文档明确后两者为 best-effort。

来源：[README](https://github.com/JamesShi96/project-butler)、[工具兼容性](https://github.com/JamesShi96/project-butler/blob/main/docs/compatibility.md)。

适合作为不支持 Hook 的工具的可审阅兜底；不足以承担可靠自动采集和多客户端并发同步。

## 8. 对 cc-bridge 的具体调整建议

### 三层数据，而不是只建一个 memory 表

1. **可见历史层**：授权采集的用户消息、最终回复、必要工具结果，保留原始来源和游标，允许回补与重建。
2. **当前工作层**：目标、硬约束、最新决策、完成证据、pending 工作与下一步；跨工具时先恢复这一层。
3. **长期记忆层**：经确认的项目知识与个人偏好；相关检索补充，不覆盖当前请求。

### 首批实现顺序

1. 为外部 Claude Code/Codex 实现只读转录 source adapter，按客户端实际主机部署；先补齐已有对话，再按游标增量同步。
2. 参考已查阅的三套 Codex Hook 实现，用固定版本验证 SessionStart 注入、Stop/工具事件保存和 PreCompact 边界；Cursor 随后验证。
3. cc-bridge 用统一 MCP 工具提供 `list_contexts / handoff / search_history / read_history / save_checkpoint`；B 无 Hook 时显式调用 handoff，仍能获取索引中的 A 会话。
4. 开场注入有预算的当前工作包；相关历史用检索/读取补充，避免全量灌入。
5. 显示“原文覆盖到哪、摘要覆盖到哪、最后同步、是否缓存降级、目标工具是否已注入”，不使用单一已连接标记表示成功。

### 最值得先做的验证

在两端原生客户端中完成：A 讨论目标与修改方案 → 不手工编写摘要，采集器读到转录 → B 通过同一桥调用 handoff/Hook 读取 → B 正确回答硬约束、最后决策、待办和失败记录 → B 更新后切回 A。

分别测试同机、远端 Linux 客户端→Windows 桥、断网回补和压缩后日志。用这个验证结果决定接入自建 Rust 数据层，还是短期外挂现有服务。不要先移植 48 个客户端，也不要先做大量 UI。

### 不应照搬

- 不默认全盘扫描所有 AI 聊天，不回写用户原生会话库。
- 不引入当前工作所不需要的全部向量/云服务/observer 链路。
- 不把历史摘要的“完成”当作外部操作确已完成。
- 不将项目自述的支持数量、基准成绩和 Star 数等同于本机兼容性或生产可靠性。

建议：以 deja-vu 的“多源只读索引 + handoff”作为功能骨架，借鉴 claude-mem/mcp-memory-service 的宿主 Hook 与渐进恢复，保留 cc-bridge 自己的 Rust 存储、安全和远程链路。
