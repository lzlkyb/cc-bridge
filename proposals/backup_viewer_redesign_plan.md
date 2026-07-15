# 备份浏览器重设计（全功能：版本历史 + 变更预览 + 相邻版本对比）

> 背景：当前「查看备份文件」只列 原文件名 / 时间 / 大小，用户无法判断「那次改了什么」，
> 也看不出「上一个版本和下一个版本差在哪」。本方案把它重做成**版本历史浏览器**，
> 直接回答这两个问题。用户已确认做到「全功能」档（含相邻版本对比）。

## 一、核心思路

把「平铺的 .bak 列表」改为**按原文件名分组的版本时间线**：

- **当前文件** = 时间线终点（最新状态）。
- 每个 `.bak` = 一次改写**前**的快照，作为时间线上的一个节点。
- 每个节点直接告诉你「这次改了什么」：
  - **看改了什么** → `get_file_diff(bak, 当前文件)`：该 .bak 与最新文件的行级增删。
  - **与上一版比** → `diff_backups(上一个.bak, 这个.bak)`：两个快照互比（纯备份目录内，不需白名单）。
- **还原** → 复用已有 `restore_file`（白名单关闭时仍禁用，安全不削弱）。

## 二、后端改动（轻量，零新依赖）

### 新增命令 `diff_backups(backup_path_a, backup_path_b)`

```rust
#[tauri::command]
pub async fn diff_backups(
    state: State<'_, Arc<AppState>>,
    backup_path_a: String,   // 较旧版本（旧）
    backup_path_b: String,   // 较新版本（新）
) -> Result<FileDiffResult, String> {
    // 1) 两个路径都必须限在备份目录内的 .bak（双重 assert_backup_path_in_scope）
    // 2) 读取 a / b 字节
    // 3) 复用 get_file_diff 的 guard 逻辑（二进制 / >1MB / >2000行 → 仅返回行数统计）
    // 4) TextDiff::from_lines(&a, &b) → DiffLine[]（added/removed/context）
    // 返回 FileDiffResult（前端已有类型，直接复用）
}
```

- 不引入新 crate（`similar` 已在依赖中）。
- 安全不削弱：两路径均经 `assert_backup_path_in_scope` 校验，不暴露白名单外路径；不做写操作。
- 在 `main.rs` 的 `generate_handler!` 注册。

### 现有可复用（不重造）

- `get_file_diff`（bak vs 当前文件）—— 前端「看改了什么」复用。
- `restore_file` + `RestoreBackupDialog` —— 还原复用。
- `assert_backup_path_in_scope` / `TextDiff` / `FileDiffResult` —— 直接复用。

## 三、前端改动

### 1. `lib/utils.ts`（规则11 公共函数）

新增 `formatRelativeTime(ts: string): string` —— 把 `created_at`（"2026-07-15 14:32:00"）转成
「刚刚 / 3分钟前 / 7分钟前 / 2小时前 / 昨天 / 3天前」等相对时间，tooltip 显示绝对时间。

### 2. `lib/types.ts`

无需新类型：`BackupListResult` / `BackupFileInfo` / `FileDiffResult` 均已存在。

### 3. `components/tabs/SecurityTab.tsx`

把 `BackupListPanel` 从「分组 + 平铺行」重做为 **`VersionTimeline`**：

- 仍按 `result.groups`（原文件名）分组。
- 每组渲染一条竖向时间线（新→老）：
  - 终点节点：**当前文件**（显示「当前 · X KB · 最新」）。
  - 各 `.bak` 节点：文件名（粗）+ 相对时间 + 大小 + 三操作按钮：
    - **看改了什么** → 调 `get_file_diff(bak, target)`，`target` 取 `entry.targets[0]`；
      原位展开红绿 diff 预览；展开后从 `lines` 数出 `+N -M` 徽章。**懒加载**（点开才调，避免默认卡）。
    - **与上一版比** → 调 `diff_backups(prevBak, thisBak)` 展开两版本互比 diff。
    - **还原** → 复用 `RestoreBackupDialog`。
- **护栏（guard）**：二进制 / 超大 / 超 2000 行时，不显示 diff，提示「无法预览，仅可还原」+ 还原按钮（与 LogTab 一致）。
- **白名单关闭**：`entry.targets` 为空 → 「看改了什么」禁用（无当前文件可对比）；
  「与上一版比」是纯 .bak 互比，**不受影响仍可工作**；还原仍禁用（与现状一致）。

### 4. 折叠入口改名

「查看备份文件（N）」→ **「版本历史（N）」**，更贴合新形态。

## 四、安全与红线

- 不碰 `backup.rs` 核心逻辑；不削弱白名单 / 路径校验 / 护栏。
- 体积红线：零新依赖（`similar` 已有），不引入 Markdown 库（diff 用原生行渲染）。
- `cargo clippy --no-default-features` 零警告；`tsc --noEmit` 零错误。

## 五、验证

1. `tsc --noEmit` 零错；`cargo fmt` + `cargo clippy --no-default-features` 零警告。
2. `tauri dev` 启动，进入 设置 → 安全 → 版本历史：
   - 展开某文件分组，看时间线（当前 + 各 .bak）。
   - 点「看改了什么」→ 出现红绿 diff + `+N -M` 徽章。
   - 点「与上一版比」→ 出现两快照互比 diff。
   - 「还原」走确认弹窗，成功 toast。
   - 白名单关闭时验证按钮禁用逻辑。

## 六、提交规划（规则5，待用户「提交」指令）

建议作为独立 commit：`feat: 备份浏览器升级为版本历史（变更预览+相邻对比）`。
与之前的 防火墙 / 端口修复 / 备份P0P1 / 图标统一 等改动分开。
