# 一键回滚 & 变更 Diff 视图 · 规划 RFC

> 状态：规划阶段（待确认后实施）
> 关联：体验优化方向「你能看清、也能撤销 Claude 的每一次改动」核心卖点
> 约束：CLAUDE.md 规则 7（安全模块不得放松、守二进制体积、组件 ≤300 行、公共函数入 `lib/`）

---

## 0. 一句话结论

两个功能**共享同一个先决条件**：把「审计条目 ↔ 备份文件」关联起来（给 `AuditEntry` 加 `backup_path` 字段）。
关联打通后——
- **一键回滚**：审计页每条写操作挂「还原」按钮，点一下用对应 `.bak` 覆盖回原文件（删文件 = 恢复被删文件）。
- **变更 diff 视图**：同一条目挂「查看变更」，实时用 `.bak`（前）vs 当前文件（后）做行级 diff 高亮，不占存储。

两者都**不引入新重依赖**（diff 复用现有 `diff_utils::unified_diff`，前端行级渲染自写轻量逻辑），守住 3.4MB / 14MB 体积卖点。

---

## 1. 现状与缺口（已读真实代码确认）

### 已有的（利好）
- **备份机制完整**（`backup.rs`）：`backup_before_overwrite(file, backup_dir, data_dir)` 在覆盖/删除**已存在**文件前生成
  `data_dir/{backup_dir}/{filename}.{YYYYMMDD_HHMMSS_mmm}.bak`，`prune_backups` 按文件名排序保留最近 `backup_retention`（默认 10）个。
- **5 处写操作已调用备份**并返回 `Option<PathBuf>`：
  `write_files.rs:88` · `edit_files.rs:122` · `copy_files.rs:73` · `move_files.rs:105` · `delete_files.rs:60`。
- **diff 工具已存在**：`diff_utils::unified_diff(path_label, old, new) -> String`（unified diff，空 old = 全新增，相同 = 空串）。
- **命令注册模式清晰**：`#[tauri::command] pub async fn xxx(state, ...) -> Result<_, String>`，在 `main.rs` 的 `generate_handler![]` 注册；前端 `invoke("name", {args})`。

### 缺口（必须补）
1. **审计 ↔ 备份脱钩**：`AuditEntry`（`audit.rs`）**没有任何字段记录本次操作对应哪个 `.bak`**，且审计**不存储前后文件内容**。→ 无法从审计条目精确反查备份、也无法直接取出 before 内容。
2. **前端类型无 backupPath**：`lib/types.ts` 的 `AuditEntry` 缺该字段。
3. **无回滚 / diff 命令**：`restore_file`、`get_file_diff` 均不存在。

> 注：`.bak` 命名含毫秒时间戳，但格式（`20260714_123456_789`）与审计 `timestamp`（RFC3339）不一致，且 retention 会删旧备份——**靠时间戳反推匹配不可靠**，必须显式关联。

---

## 2. 先决条件（P0，两功能共享）· 关联 backup_path

| 文件 | 改动 |
|---|---|
| `audit.rs` | `AuditEntry` 增 `pub backup_path: Option<String>`（`#[serde(rename="backupPath", skip_serializing_if="Option::is_none")]`）；`new_entry` 增 `backup_path: Option<String>` 入参；`write_audit_log` 序列化自动带出 |
| `lib/types.ts` | `AuditEntry` 增 `backupPath?: string` |
| `mcp/tools/{write_files,edit_files,copy_files,move_files,delete_files}.rs` | 把 `backup_before_overwrite(...)?` 的返回值 `let bp = ...` 传入各自 `audit::new_entry(...)` 的 `backup_path` 参数 |
| 向后兼容 | 旧审计日志无此字段 → 解析为 `None` → UI 不显示按钮（`skip_serializing_if` 已保证旧行干净） |

**成本**：纯字段透传，约 6 文件、零新逻辑、零风险。这是整个功能的地基，先落地。

---

## 3. 一键回滚（P1）

### 后端 · 新增 `restore_file` 命令
```rust
#[tauri::command]
pub async fn restore_file(
    state: State<'_, Arc<AppState>>,
    target_path: String,
    backup_path: String,
) -> Result<(), String>
```
执行顺序（**安全模块不得放松**）：
1. `security::path::validate(&target, &state, enforce_whitelist)` —— target 必须在白名单内（防路径穿越）。
2. **备份路径约束**：`backup_path` 必须 `starts_with(data_dir/backup_dir)` 且以 `.bak` 结尾 —— 防止用此命令读取任意文件。
3. 还原前先对 `target` 调一次 `backup_before_overwrite`（保留「可再撤销」能力，形成安全链）。
4. 读 `backup_path` 内容 → 按原文件编码/换行/BOM round-trip 守卫写回（参考 `edit_files` 的 `encoding::encode_text` 无损写回）。
5. `audit::new_entry("restore_file", ...)` 写审计。
6. `main.rs` `generate_handler![]` 注册。

**删除文件还原**：`delete_files` 删前已备 `.bak`，还原 = 用 `.bak` 把文件写回原路径（等价撤销删除）。UI 文案差异化提示。

### 前端 · 日志页挂点
- `LogTab.tsx` 的 `DetailPanel(entry)`：当 `entry.backupPath` 存在 **且** `entry.tool ∈ {write_files, edit_files, copy_files, move_files, delete_files}` 时，显示 **「↩ 还原」** 按钮。
- 点击 → **确认弹窗**（`createPortal`，复用 `confirmClear` 现有模式）：
  > 确定将 `{文件名}` 还原到该次操作**之前**的状态？此操作会再次生成备份，可继续撤销。
- 确认 → `invoke("restore_file", {targetPath, backupPath})` → toast 成功 → `refetch()`。

### 边界
- 备份被 `prune`（超 retention）后 `.bak` 已删 → 命令报错「备份已过期清理」，UI 友好提示「该还原点已超出保留上限」。
- 还原本身也会产生新 `.bak`，不破坏链。

---

## 4. 变更 Diff 视图（P1）

### 思路：实时 diff（不存内容，复用 backup_path）
审计**不记录前后内容**（避免大文件内容撑爆审计日志）——diff 在用户**打开时**按需计算：
`backup_path`（前）vs `当前文件`（后）。完美复用 P0 的关联字段。

### 后端 · 新增 `get_file_diff` 命令
```rust
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
    current_path: String,
) -> Result<DiffResult, String>
```
- `backup_path` 约束同上（备份目录内 + `.bak` 后缀）；`current_path` 走白名单校验。
- 读 `backup`（before）与 `current`（after，**不存在则 after=""** → 展示「整文件被删除」）。
- **大小护栏**：行数 > 2000 或字节 > 1MB → 返回 `too_large: true`，前端仅允许还原、不渲染 diff。
- **二进制护栏**：内容含 NUL 或不可解码 → `is_binary: true`，仅允许还原。
- 复用 `diff_utils::unified_diff` 生成，并解析为结构化 `DiffLine[]`（`{op:"eq"|"add"|"del", text}`）供前端精确高亮；或返回 unified diff 字符串由前端轻量解析（二选一，倾向结构化以省前端解析）。

### 前端 · DiffModal
- `DetailPanel` 加 **「查看变更」** 按钮（仅当 `backupPath` 存在）。
- 点击 → `createPortal` 弹 modal → `invoke("get_file_diff")` → 行级渲染：
  - `-` 删除行：红底；`+` 新增行：绿底；`=` 不变：灰。
  - 顶部显示 `before: {bak 时间}` → `after: 当前`，文件名校验。
- `too_large` / `is_binary` → 提示「文件过大 / 二进制，仅可还原」。

### 新增文件（规则 11：公共组件独立）
- `components/modals/DiffModal.tsx`（独立 modal，行级渲染纯函数可放 `lib/utils.ts` 或组件内）。

---

## 5. 风险评估

| 风险 | 缓解 |
|---|---|
| 备份被 prune 后还原点消失 | UI 提示保留上限；命令侧明确报错 |
| 大文件 diff 卡 UI | 行数/体积护栏，超限仅还原 |
| 二进制/编码损坏 | 二进制护栏 + 编码 round-trip 守卫（同 edit_files） |
| 路径穿越攻击面 | restore/get_file_diff 严格走白名单 + 备份目录后缀约束（不放松安全模块） |
| 二进制体积 | 无新重依赖（diff 复用、前端自写行渲染） |
| 组件行数 | DiffModal 独立文件，LogTab 仅加按钮，均 <300 行 |

---

## 6. 文件级改动清单

**后端（Rust）**
- `audit.rs`：`AuditEntry` + `backup_path` 字段；`new_entry` 入参
- `commands.rs`：`restore_file` + `get_file_diff` 命令
- `main.rs`：`generate_handler![]` 注册两命令
- `mcp/tools/{write_files,edit_files,copy_files,move_files,delete_files}.rs`：透传 `backup_path` 给 `new_entry`
- `diff_utils.rs`（可选）：加 `diff_paths` 读两文件辅助

**前端（TSX）**
- `lib/types.ts`：`AuditEntry.backupPath`
- `components/tabs/LogTab.tsx`：`DetailPanel` 加「还原」「查看变更」按钮 + 还原确认弹窗
- `components/modals/DiffModal.tsx`（新增）：行级 diff 渲染

**文档**
- 本 RFC；README 能力说明（restore 是 command 非 MCP 工具，按现有表结构决定是否入列）

---

## 7. 验证计划
- `cargo test --no-default-features`：新增单测（白名单拒绝、备份过期、大文件截断、二进制检测、删除文件还原）。
- `cargo clippy --no-default-features` → 0 warning（规则 7 必须 `--no-default-features`）。
- `npx tsc --noEmit` → 0 error。
- 手动：`tauri dev` 触发一次 `edit_files` → 日志页展开 → 点「还原」文件回到前状态；点「查看变更」diff 高亮正确。

---

## 8. 实施顺序（建议）
1. **P0** 关联 `backup_path`（后端 + 前端，零 UI，先打通数据链）
2. **P1** 一键回滚（restore_file + 还原按钮 + 确认）
3. **P1** 变更 diff 视图（get_file_diff + DiffModal）
4. 回归测试 + 手动验证

> 注：P0 落地后即使暂不实现 P1，也已为未来所有「基于备份的可观测/可撤销」能力铺好地基，且对现有行为零影响（旧字段 `skip_serializing_if`）。
