# cc-bridge 对标 native Claude Code：差距与机会分析

> 评估日期：2026-07-11
> 更新记录：
> - 初版（2026-07-11 上午）：能力对齐 + 差距 + 机会清单。
> - **本轮更新（2026-07-11 下午）**：把"确定性三连"（gzip + O1 + D 组 5 项债）全部闭环后刷新状态；并**实证纠正**——`batch` 工具此前已落地（非"仍待做"），D-group 5 项代码修复后 `cargo clippy --no-default-features` 零警告、`cargo test` 71 项全绿。
> 依据：README.md / CLAUDE.md / 功能优化清单.md / CHANGELOG.md / proposals/* / 代码实证（grep + 编译验证）

---

## 一句话结论（现在的状态）

**工具能力层已经追平 native 的"无差别体验"，且性能/正确性债务已被本轮清零。**

- 工具面（17–18 个 MCP 工具，含 `batch`）与 native 的工具体积已无功能性缺口。
- **确定性三连已闭环**：① gzip 响应压缩（早已落地）② O1 五维耗时（早已落地，原提案滞后误标"未动手"）③ D 组 5 项代码债（D2/D3/D5/D6/D7，**本轮刚修复**，clippy 零警告）。
- 剩下的**真实差距收敛为三件结构性事情**：跨网络固有成本、Bash cwd 不持久化、MCP 协议手写 dispatch。这三者都不是"偷懒没做"，而是架构/安全取舍。
- 四个维度**依旧反超 native**：安全护栏、可观测性、中文编码保真、体积。

---

## 一、能力对齐度（已追平）

| native Claude Code | cc-bridge 对应 | 状态 | 说明 |
|---|---|---|---|
| Read | `read_files` | ✅ 对齐 | 含 offset/limit 行切片；`analyze_file` 编码/语言探测为**加分项** |
| Write | `write_files` | ✅ 对齐 | 全量覆盖 + 写前备份 |
| Edit | `edit_files` | ✅ 对齐 | 精准串替换 + 唯一匹配校验 + `diff` 回传 |
| Glob | `search_files(name_pattern)` | ✅ 对齐 | `globset` 完整 glob 语义 |
| Grep | `search_files(content_pattern)` | ✅ 对齐 | grep-searcher 引擎（mmap+SIMD）+ 富 Grep 选项 |
| Bash | `run_command` + `get_command_output` + `stop_command` | 🟡 基本对齐 | 见"差距 ②" |
| NotebookEdit | `notebook_edit` | ✅ 对齐（v2.2.17） | |
| TaskOutput / TaskStop | `get_command_output` / `stop_command` | ✅ 对齐 | 等价 |
| CLAUDE.md 自动加载 | `list_allowed_roots` 内嵌 `projectInstructions` | ✅ 更显式 | 连接即拿到项目规则 |
| 审计 / 备份 / 限流 | 无对应（native 本机信任） | ✅ cc-bridge 独有加分 | 可追溯 / 可回滚 / 防刷 |

**结论**：工具面无功能性缺口。

---

## 二、真实差距（现在只剩这三件结构性的）

### 🔴 1. 跨网络的固有成本（不可消除）
- MCP over HTTP 比本机直调多一跳网络 + JSON-RPC 序列化，是架构本质。
- `search_files` 服务端耗时已被 P6 三连击压下去，**剩下瓶颈是"往返数 × 延迟"**。
- 已做的缓解：gzip 压缩线缆（源码文本 5–10×）、O1 五维耗时把"慢在哪一层"看清、**`batch` 工具把 N 次往返合并为 1 次**（已落地，4 条测试守住：合并往返 / 只读拦截 / 审计留痕 / 拒嵌套）。
- **归零不可能**，但 batch 已把"往返数 × 延迟"这个仅存瓶颈基本打掉——前提是 Claude 侧真的采用 batch 而非逐条调用。

### 🟡 2. Bash cwd 不持久化（最大语义差距，根因是安全取舍）
- native / litecode 的 Bash 跨调用保留 cwd（litecode 用 `PWD_MARKER` 技巧）。
- cc-bridge `run_command` **刻意无状态**：cwd 每次必传（`resolve_safe_path` 强约束）。
- 不是缺陷，是"远程不可信"设计哲学。消除需引入**会话级 cwd**（提案 P1，建议独立 RFC，可开关、默认关）。
- 附带差异：timeout 默认 30s vs native 120s，可调。

### 🟡 3. MCP 协议手写 dispatch（无 SSE / 协议协商）
- `dispatch_tool` 手写 JSON-RPC，不支持 SSE 流式与协议协商。
- 长期方向是迁移官方 `rmcp` SDK（P5-1），但**安全链路（Bearer/限流/审计/只读拦截）如何挂到宏体系需先出专项方案**，不能直接动。
- 这是与开源 litecode（用 rmcp）唯一的明显落后点。

---

## 三、已经比 native 做得更好的地方（亮点，未变）

1. **安全护栏更硬**：路径白名单（canonicalize + 祖先遍历）＋ Bearer 常量时间比较 ＋ 限流 ＋ 写前自动备份 ＋ 审计日志 ＋ 危险命令拦截。native 本机是"信任你"，cc-bridge 是"远程不可信默认拒绝"。
2. **可观测性碾压**：结构化审计日志 ＋ 前端 `PerfCharts`（零依赖手绘 SVG）＋ O1 五维耗时（serverMs/ioMs/netMs/auditMs/overheadMs，已落地并实测）。native 没有"看清自己慢在哪一层"的能力。
3. **中文编码保真更鲁棒**：GBK/GB18030 自适应读取 ＋ CRLF/BOM 保留。native 默认 UTF-8，面对中文 Windows 老工程反而读不了。
4. **进程树治理比 litecode 更稳**：`process-wrap`（Job Object）整树终止，孙进程不孤儿泄漏；litecode 的 `child.kill()` 会漏杀。
5. **体积极轻**：exe 14MB / 安装包 3.4MB（纯 Rust 重写去掉 Node sidecar）。

---

## 四、机会清单与当前状态

### A. 确定性收益（无需客户端配合）—— ✅ 已全部闭环

| 项 | 状态 | 实证 |
|---|---|---|
| **gzip 响应压缩** | ✅ 已完成 | `http.rs` `CompressionLayer::new().gzip(true)`；`tests/perf_real.rs` 实测 ~120KB 压到一半以下；客户端 undici 自动解压，零客户端改动 |
| **O1 结构化耗时** | ✅ 已完成（原提案误标"未动手"） | `timing.rs` 已建、全工具埋 `record_io`；`write_audit_for_call` 算出 server_ms/audit_ms/io_ms 进 `new_entry`；前端 PerfCharts 渲染 |
| **D2 path_locks 泄漏** | ✅ 本轮修复 | `state.rs` 新增 `gc_path_locks()`（retain 清 `strong_count==1` 空闲锁）；`main.rs` 挂 60s 后台回收；调用点零改动 |
| **D3 move_files 源锁竞态** | ✅ 本轮修复 | `move_files.rs` 改为源+目标双锁，按路径字典序加锁防死锁、源==目标去重 |
| **D5 默认值两处漂移** | ✅ 本轮修复 | `db.rs::ensure_defaults` 16 项默认值改从 `BridgeConfig::default()` 取，仅 token 随机生成，行为不变 |
| **D6 启动 panic** | ✅ 本轮修复（干净失败） | `main.rs` 5 处 `.expect()` 改 `?` 传播 + 中文错误，`main()` 返回 `Result`，构建失败干净退出 |
| **D7 审计静默丢失** | ✅ 本轮修复 | `audit.rs` `AuditEntry` 加 `Clone`；`http.rs` 改 `spawn_blocking` 异步落盘 + `log::error!` 上报，不再 `.ok()` 吞错 / 阻塞请求线程 |

> 旁注：D1（x-forwarded-for 限流键，仅用 `addr.ip()`）与 D4（ratelimit.rs 死代码）此前已修，本轮前即不在债清单。

### B. 语义追平（需权衡安全模型）—— 仍待做

| 项 | 价值 | 说明 |
|---|---|---|
| **会话级 cwd 持久化** | 消除最大语义差距 | 需 RFC：sentinel 回显 + 白名单校验 + 可开关默认关。建议独立评估，不阻塞主线 |
| **rmcp SDK 迁移** | 补齐 SSE + 协议协商 + 减维护负担 | 重大重构；安全链路迁移需先出专项方案 |

### C. 体验增强（依赖客户端是否采用）—— 仍待做

| 项 | 价值 | 说明 |
|---|---|---|
| **跨类型 batch 工具** | ✅ 已完成 | `tools/batch.rs` 已落地：N 次往返 → 1 次，复用现有 dispatch 护栏（零新攻击面），4 条测试守住合并/只读/审计/拒嵌套 |
| **A/B/C 组 UI 优化** | toast 统一 / Token 眼睛切换 / 端口占用提示 / 首次引导空态 | 不改后端安全约束 |
| **O3 导出诊断报告** | 把 PerfCharts 结论一键拼 Markdown 交 agent 出方案 | "排查→定位→修复"闭环最后一块 |

---

## 五、建议的下一步（现在该做什么）

**确定性三连已清零，batch 已落地，主线债务见底。** 接下来分两档：

- **想继续收窄体验差距（推荐）**：
  - 出 **会话级 cwd 持久化 RFC**（B 组，消除最大语义差距）。
  - 推动 **Claude 侧真正采用 batch**（工具已就绪，收益取决于客户端是否合并调用）。
- **想补齐协议层长期债**：
  - 出 **rmcp SDK 迁移专项方案**（B 组），先解决安全链路挂接，再动 dispatch。
- **想打磨前端体验**：
  - A/B/C 组 UI 优化 + O3 诊断报告导出。

> 一句话：**能力已平、债已清、batch 已上，剩下的全是"结构性取舍"而非"没做"。下一步要么在安全模型上做 cwd/协议层的进阶，要么打磨前端体验，没有"补窟窿"性质的急活了。**

---

## 附：与开源 litecode 的对照小结
- 工具面 cc-bridge 已覆盖 litecode 全部 9 个工具。
- cc-bridge **进程树治理更稳**（Job Object 整树终止 vs `child.kill()` 漏杀）。
- cc-bridge **多一层安全护栏**（白名单/canonicalize/危险命令拦截）。
- 唯一明显落后：litecode 用官方 `rmcp` SDK（自动 SSE/协商），cc-bridge 手写 dispatch——这是 P5-1 的长期债，已列入上方 B 组。
