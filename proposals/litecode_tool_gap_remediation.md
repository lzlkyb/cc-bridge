# litecode 工具差距补齐方案（P 组收尾）

> 前置已完成：危险命令拦截（v2.2.15）、进程树治理 process-wrap 迁移（v2.2.16）。
> 本方案覆盖差距表 `litecode_tool_gap_analysis.md` 中的**剩余项**。
> 目标：对标 native Claude Code「无差别体验」。

## 剩余差距清单（剔除已完成项）

| # | 项 | 现状 | 目标 | 优先级 | 工作量 |
|---|----|------|------|--------|--------|
| 1 | `description` 字段 | `run_command` `RunCommandArgs` 无此字段（仅 command/cwd/background/timeout_ms/max_output_bytes） | 支持 `description`，用于权限 UX / 审计 | **P0** | S（半天内） |
| 2 | 会话级 cwd 持久化 | `run_command` 刻意无状态，cwd 每次必传 | 跨调用保留 cwd（PWD_MARKER 思路）+ 白名单校验 | **P1** | M（需权衡安全模型） |
| 3 | NotebookEdit | 无对应工具 | 新增 `notebook_edit` 工具，编辑 `.ipynb` cell | **P2** | M |
| 4 | 富 Grep 选项 | `search_files` 已返回 `path`/`lineNumber`，但 `case_insensitive` 仅对 glob 名硬编码为 true、上下文固定 2 行、无 `outputMode`/`headLimit`/`multiline`/`lineNumbers` 开关 | 参数化 Grep 选项 | **P2** | M |

> Read/Write/Edit/Glob/Grep(基础)/TaskOutput/TaskStop 均已对齐，无需补。

## 逐项方案

### 1. `description` 字段（P0）
- `run_command.rs` `RunCommandArgs` 增加 `pub description: Option<String>`（`#[serde(default)]`）。
- 语义（不强制权限流，因 cc-bridge 当前无基于 description 的权限弹窗）：
  - 记入 `RunningCommand` state 与运行日志，供审计；
  - 多命令并发时便于区分输出归属。
- 风险：极低，纯增量字段，不影响既有调用（缺省 `None`）。
- 验证：单测 `description` 被记录；`cargo test --lib` / `clippy` / `fmt` 全绿。

### 2. 会话级 cwd 持久化（P1，建议单独 RFC）
- `state.rs` 引入 `session_cwd: Arc<Mutex<Option<String>>>`（先确认会话模型：全局单一 or per-conversation）。
- `run_command` 解析：若 `args.cwd` 为空，回退 `session_cwd`。
- 命令包裹：执行后回显 cwd 以更新。
  - Unix：`; printf '\n__CC_PWD__:%s' "$PWD"`
  - Windows(cmd)：` & cd & echo __CC_PWD__:%CD%`
  - 从 stdout 提取 sentinel 行，更新 `session_cwd`。
- **安全约束**：提取到的 cwd 必过 `resolve_safe_path` 白名单校验，越界则忽略/报错，绝不跳出允许根。
- 边界/风险：
  - 命令输出含 `__CC_PWD__:` 误解析 → 用不易冲突 sentinel + 行首锚定。
  - background 模式不回写（异步无同步点）。
  - 前台超时/失败时 cwd 不更新。
  - 与「无状态」安全设计哲学冲突 → **建议做成可开关，默认关闭**。
- 结论：作为独立议题先出 RFC 再实现，不强行并入本次。

### 3. NotebookEdit 工具（P2）
- 新建 `notebook_edit.rs`，并在 `mod.rs` / `lib.rs` 工具表登记。
- 入参：`path`、`cell` 定位（index 或 id）、`new_source`、`mode`（replace / insert / delete）。
- 实现：`serde_json` 读 `.ipynb` → 定位 `cells` 数组 → 改 `source`（String 或 String[]）→ 写回，保留其余 metadata。
- 复用：白名单路径校验（同 `write_files`）+ JSON 解析错误处理。
- 验证：单测改/插/删 cell、非 ipynb 报错、越界 index 报错。

### 4. 富 Grep 选项（P2）
- `search_files.rs` `SearchFilesArgs` 增加（仅 `content_pattern` 存在时生效）：
  - `case_insensitive: Option<bool>` —— 控制内容匹配大小写（当前 glob 名已忽略大小写，内容匹配尚不可配）。
  - `before_context` / `after_context` / `context` —— 替代硬编码 2 行上下文。
  - `line_numbers: Option<bool>` —— 默认 true（已有 `lineNumber` 字段，可关闭）。
  - `head_limit: Option<usize>` —— 替代/约束 `max_results` 语义。
  - `output_mode: enum(content | files_with_matches | count)`。
  - `multiline: Option<bool>`。
- 注意：`name_pattern`（Glob）分支不受影响，仅对 content 匹配分支应用这些参数。
- 验证：各 `output_mode` + `before/after` 可变 + 大小写开关单测。

## 推荐实施节奏

- **本次（若同意）**：做 **P0（description）** + **P2（NotebookEdit）** + **P2（富 Grep 选项）**，合为 **v2.2.17**，每项独立 commit。
- **P1（cwd 持久化）**：单独评估，先 RFC，不强行并入。
- 门禁：`cargo test --lib` 全绿、`cargo clippy` 零警告、`cargo fmt`；新工具需在工具注册表登记。
- 沿用 CLAUDE.md 规则：版本号（Cargo.toml + tauri.conf.json + Cargo.lock）同步递增；**不自动 push**，等你明确说「提交」。
