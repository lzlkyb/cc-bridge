# 工具完整性差距表（对照 litecode）

> 参照仓库：github.com/mirrorange/LiteCode（纯 Rust Coding MCP server，工具集对齐 Claude Code）
> 对照对象：cc-bridge 现有 15 个 MCP 工具
> 目的：服务"对标 native Claude Code 无差别体验"

## litecode 工具集（9 个，纯 Rust + rmcp SDK）

`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `NotebookEdit` / `TaskOutput` / `TaskStop`

## cc-bridge 现有工具（15 个）

`run_command` / `get_command_output` / `stop_command` / `read_files` / `write_files` / `edit_files`
/ `search_files` / `analyze_file` / `copy_files` / `create_directory` / `delete_files`
/ `move_files` / `remove_directory` / `list_directory` / `list_allowed_roots`

---

## 逐项差距表

| litecode 工具 | cc-bridge 对应 | 对齐度 | 关键差异 / 备注 |
|---|---|---|---|
| **Bash** | `run_command` + `get_command_output` + `stop_command`（后台三件套） | 🟡 基本对齐，2 处差距 | ① **缺 `description` 字段**（litecode 用于权限 UX / 审计）；② **cwd 不持久化**（见下方"最大语义差距"）；③ 默认超时 30s vs litecode 120s、上限 litecode 600s |
| **Read** | `read_files` | 🟢 对齐 | 双方均支持 offset/limit 行切片；我们另有 `analyze_file`（文件类型/编码分析）为加分项 |
| **Write** | `write_files` | 🟢 对齐 | — |
| **Edit** | `edit_files` | 🟢 对齐 | 均为 old_string→new_string 精确替换 |
| **Glob** | `search_files`（`name_pattern`） | 🟢 对齐 | 我们用 `globset` 做文件名匹配，**已覆盖 Glob** |
| **Grep** | `search_files`（`content_pattern`，`regex` + `ignore::Walk`） | 🟢 已覆盖（合并实现） | litecode 拆成独立 Grep 工具且选项更丰富（before/after/context、line_numbers、case_insensitive、head_limit、multiline、output_mode）；我们是**单工具合并 glob+content**，功能等价但 Grep 选项丰富度略低 |
| **NotebookEdit** | （无） | 🔴 缺失 | Jupyter 单元编辑；native Claude Code 有，影响小（非主流场景） |
| **TaskOutput** | `get_command_output` | 🟡 语义不同但等价 | litecode 返回 `status`（completed/stopped/running）+ block/timeout 轮询；我们用 **offset 流式切片**返回原始字节。两者都能取后台输出，风格不同 |
| **TaskStop** | `stop_command` | 🟢 对齐 | — |

### cc-bridge 的"额外工具"（litecode 没有，属加分项，非缺口）

- `analyze_file`（文件类型/编码探测）
- `copy_files` / `move_files` / `create_directory` / `remove_directory` / `delete_files`（细粒度文件操作，litecode 折叠进 Read/Write/Edit，我们显式拆出更利于权限收敛）
- `list_directory` / `list_allowed_roots`（MCP root 管理；litecode 是本地进程无此概念）

---

## 最大语义差距：Bash 的 cwd 持久化

- **litecode**：Bash 通过 `PWD_MARKER` 技巧（命令末尾追加 `printf '\n__LITECODE_PWD__:%s' "$PWD"`），
  在**多次调用间持久化工作目录**（shell 状态之外的 cwd 跨调用保留）。native Claude Code 同样持久化 cwd。
- **cc-bridge**：`run_command` 是**刻意无状态**的——cwd 每次必须显式传入（见代码注释：
  "无状态：不跨调用保留 shell 会话"），由白名单 + `resolve_safe_path` 强约束。
- **结论**：这是与 native Claude Code "无差别体验"最显著的语义差距，但根因是**安全 / 白名单设计取舍**，
  不是实现缺陷。若要做到无差别，需要引入"会话级 cwd"概念（用 litecode 的 PWD_MARKER 思路），
  同时保留白名单边界校验。建议作为独立议题评估，而非盲目照搬。

---

## 架构旁证：进程树治理我们反而更稳

- litecode `process.rs` 的 `wait_for_child` 在超时 / stop 时只调 `child.kill()`——
  **没有 Job Object**，孙进程（如 `cmd /C` 拉起的 `powershell` 再拉起的 `node`）会变成孤儿泄漏。
- cc-bridge 已用 `win32job` 的 KillOnJobClose 解决该问题（整树随 job drop 终止）。
- 因此：**不要抄 litecode 的 kill 方式**；进程树治理应走 `process-wrap` 迁移方案
  （见 `process_job_process_wrap_migration.md`），在保持正确性的同时消除自写 Win32。

---

## 行动建议（按性价比）

1. **补 `description` 字段到 `run_command`**：低成本，提升权限 UX / 审计（对应 D 组安全债）。
2. **危险命令拦截**：见 `run_command_security_patch.md`（D 组最高优先级安全缺口）。
3. **进程树治理迁移到 process-wrap**：见 `process_job_process_wrap_migration.md`（稳健性 + 跨平台）。
4. **（可选）引入会话级 cwd 持久化**：消除最大语义差距，但需与安全模型权衡，单独评估。
5. **（低优先）NotebookEdit / 更丰富的 Grep 选项**：补齐"无差别"完整度，影响面小。
