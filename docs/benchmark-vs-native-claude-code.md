# cc-bridge 对标 native Claude Code：差距与机会分析

> 评估日期：2026-07-11
> 依据：README.md / CLAUDE.md / 功能优化清单.md / CHANGELOG.md / proposals/*（含 7-11 最新提案）
> 目标：判断"对标 native Claude Code 无差别体验"走到哪了、还差哪、还能在哪做得更好

---

## 一句话结论

文件 / 命令 / 工程化三层能力**已经基本追平 native 的无差别体验**（工具面全覆盖、内容搜索对齐 ripgrep、进程树治理甚至比开源 litecode 更稳）。

**剩下的差距不是"能不能干"，而是三件结构性事情：**

1. **跨网络的固有成本** —— MCP over HTTP 比本机直调多一跳网络 + JSON-RPC 序列化，这是架构本质，不是实现偷懒。
2. **Bash 的语义取舍** —— `run_command` 刻意无状态（cwd 每次必传），这是安全/白名单设计的选择，不是 bug。
3. **协议层手写** —— 手动 JSON-RPC dispatch，不支持 SSE 流式传输和协议协商，长期维护成本高于官方 SDK。

而 cc-bridge 在 **安全护栏、可观测性、中文编码保真、体积** 四个维度上**已经反超 native**——因为 native 是"本机信任你"，cc-bridge 是"远程不可信 + 可审计 + 可回滚"。

---

## 一、能力对齐度（已追平的部分）

| native Claude Code | cc-bridge 对应 | 状态 | 说明 |
|---|---|---|---|
| Read | `read_files` | ✅ 对齐 | 含 offset/limit 行切片；`analyze_file` 编码/语言探测为**加分项** |
| Write | `write_files` | ✅ 对齐 | 全量覆盖 + 写前备份 |
| Edit | `edit_files` | ✅ 对齐 | 精准串替换 + 唯一匹配校验 + `diff` 回传 |
| Glob | `search_files(name_pattern)` | ✅ 对齐 | `globset` 完整 glob 语义（`**`/`[abc]`/`{a,b}`） |
| Grep | `search_files(content_pattern)` | ✅ 对齐 | 已换 **grep-searcher 引擎**（mmap+SIMD+字面量预筛）+ 富 Grep 选项（case_insensitive/context/output_mode/head_limit/multiline） |
| Bash | `run_command` + `get_command_output` + `stop_command` | 🟡 基本对齐 | 见下方"最大语义差距" |
| NotebookEdit | `notebook_edit` | ✅ 对齐（v2.2.17） | 影响小，但已补齐 |
| TaskOutput / TaskStop | `get_command_output` / `stop_command` | ✅ 对齐 | 风格不同（offset 流式切片 vs status 轮询），等价 |
| CLAUDE.md 自动加载 | `list_allowed_roots` 内嵌 `projectInstructions` | ✅ 甚至更显式 | 连接后第一步即拿到项目规则，跨会话不漏读 |
| 审计 / 备份 / 限流 | 无对应（native 本机信任） | ✅ cc-bridge 独有加分 | 操作可追溯、误改可回滚、防刷 |

**结论**：工具面（约 16–17 个 MCP 工具）与 native 的工具体积已无功能性缺口。

---

## 二、真实差距（按严重度排序）

### 🔴 1. 网络往返是体验天花板（固有，不可消除）
- 无论服务端多快，跨局域网/公网一跳 + JSON-RPC 序列化是固定开销。
- `search_files` 服务端耗时已从 74.6% 降到小头（P6-1/2/3 三连击），**剩下瓶颈是"往返数 × 延迟"**。
- 这是 cc-bridge 作为"远程桥"的**本质代价**，native 跑在本机无此环节。只能通过"减少往返数 / 压缩响应体"缓解，无法归零。

### 🟡 2. Bash cwd 不持久化（最大语义差距，但根因是安全取舍）
- native / litecode 的 Bash 跨调用保留 cwd（litecode 用 `PWD_MARKER` 技巧）。
- cc-bridge `run_command` **刻意无状态**：cwd 每次必须显式传入（白名单 `resolve_safe_path` 强约束）。
- 不是缺陷，是"远程不可信"设计哲学的体现。**消除它需要引入"会话级 cwd"概念 + 白名单校验**（提案里 P1，建议单独 RFC，做成可开关、默认关）。
- 另外默认值差异：timeout 默认 30s vs native 120s，可调。

### 🟡 3. MCP 协议手写 dispatch（无 SSE / 协议协商）
- README 已知限制已点名：`dispatch_tool` 是手写 JSON-RPC，不支持 SSE 流式传输和协议版本协商。
- 重大重构方向是迁移到官方 `rmcp` SDK（P5-1），但**安全链路（Bearer 中间件/限流/审计/只读拦截）如何挂到宏体系上必须先出专项方案**，不能直接动。

### 🟢 4. 自定义工具结果无原生彩色 diff 渲染（协议限制，诚实接受）
- native 的 Edit 彩色高亮是**内置工具的 UI 特例**，自定义 MCP 工具结果大概率不会被渲染成彩色。
- cc-bridge 的 `diff` 字段价值已校正为"供远程 LLM 自我核对改动"，不是保证人眼看到高亮。

### 🟢 5. 其余小项（基本已补或影响小）
- 富 Grep 选项 ✅（v2.2.17）、NotebookEdit ✅（v2.2.17）。
- SSE 实时进度流仍空白（后台命令需轮询 `get_command_output`，但对 agent 离散调用范式是可接受的）。

---

## 三、已经比 native 做得更好的地方（这是亮点）

1. **安全护栏更硬**：路径白名单（`canonicalize` + 祖先遍历）＋ Bearer token 常量时间比较 ＋ 限流 ＋ 写前自动备份 ＋ 审计日志 ＋ 危险命令拦截（rm -rf / 等启发式兜底）。native 在本机是"信任用户"，cc-bridge 是"远程不可信默认拒绝"。
2. **可观测性碾压**：结构化审计日志 ＋ 前端 `PerfCharts`（零依赖手绘 SVG）＋ O1 五维耗时拆解（serverMs/ioMs/netMs/auditMs/overheadMs）。native 没有"看清自己慢在哪一层"的能力——这正是 cc-bridge 上次排查"比 CC 慢"的教训沉淀。
3. **中文编码保真更鲁棒**：GBK/GB18030 自适应读取 ＋ CRLF/BOM 保留。native 默认按 UTF-8，面对中文 Windows 老工程（如 NC65）反而读不了。
4. **进程树治理比 litecode 更稳**：用 `process-wrap`（Job Object）整树终止，孙进程不孤儿泄漏；litecode 的 `child.kill()` 无 Job Object，会漏杀。
5. **体积极轻**：exe 14MB / 安装包 3.4MB（纯 Rust 重写去掉 Node sidecar），对比 Node 方案 88MB→14MB。

---

## 四、可以做得更好的方向（按性价比排序）

### A. 确定性收益（无需客户端配合，立刻见效）

| 项 | 来源 | 收益 | 工作量 | 风险 |
|---|---|---|---|---|
| **响应 gzip 压缩** | perf_compression 提案 ① | 源码文本压缩 5–10×，砍掉线缆时间；客户端 undici 自动解压，**零客户端改动** | 极小（1 层 + Cargo feature） | 低（仅待实测确认 Claude Code 发 `Accept-Encoding`） |
| **O1 结构化耗时落地** | 功能优化清单 O1 | 让所有性能优化"数据驱动"，避免再靠猜误判 | 中 | 低（纯观测） |
| **D 组代码债清零** | 功能优化清单 D 组 🔴 | D2 `path_locks` 永不清理（远程可触发内存累积）、D3 `move_files` 源路径未加锁（并发竞态）、D5 默认值两处漂移、D6 启动期 `expect` panic、D7 审计同步写丢 | 中~大 | 低（多为正确性修复） |

### B. 语义追平（需权衡安全模型）

| 项 | 来源 | 收益 | 说明 |
|---|---|---|---|
| **会话级 cwd 持久化** | litecode 差距 P1 | 消除最大语义差距 | 需 RFC：sentinel 回显 + 白名单校验 + 可开关默认关 |
| **rmcp SDK 迁移** | P5-1 | 补齐 SSE + 协议协商 + 减维护负担 | 重大重构，安全链路迁移需先出方案 |

### C. 体验增强（依赖客户端是否采用）

| 项 | 来源 | 收益 | 说明 |
|---|---|---|---|
| **跨类型 batch 工具** | perf_compression 提案 ② | N 次往返 → 1 次 | 复用现有 dispatch 护栏，零新攻击面；**收益取决于 Claude 是否真的用 batch** |
| **A/B/C 组 UI 优化** | 功能优化清单 | toast 统一 / Token 眼睛切换 / 端口占用提示 / 首次引导空态 / 图标线性化 | 不改后端安全约束 |

### D. 已设计待落地（闭环价值高）
- **O3 导出诊断报告**：把 PerfCharts 结论一键拼成 Markdown 交给 agent 出方案，是"排查→定位→修复"闭环的最后一块。

---

## 五、建议的下一步（如果要我开干）

**推荐节奏**：先做 A 组"确定性三连"（gzip + O1 + D 组 🔴 债），这是投入最小、风险最低、立刻可感知的；再视真实 audit.log 决定是否上 batch；cwd 持久化与 rmcp 迁移作为独立 RFC 评估，不阻塞主线。

具体到下一步，可以问我做其中任意一项，例如：
- "把 gzip 压缩上了"（最小确定性收益）
- "把 D2/D3 两个并发隐患修了"
- "出一份会话级 cwd 持久化的 RFC 方案"

---

## 附：与开源 litecode 的对照小结
litecode（纯 Rust Coding MCP server，工具集对齐 Claude Code）是更直接的竞品参照：
- 工具面 cc-bridge 已覆盖其全部 9 个工具（Bash/Read/Write/Edit/Glob/Grep/NotebookEdit/TaskOutput/TaskStop）。
- cc-bridge **进程树治理更稳**（litecode 无 Job Object，孙进程孤儿泄漏）。
- cc-bridge **多一层安全护栏**（白名单/canonicalize/危险命令拦截），litecode 是本地进程无此概念。
- 唯一明显落后：litecode 用官方 `rmcp` SDK（自动 SSE/协商），cc-bridge 手写 dispatch——这是 P5-1 的长期债。
