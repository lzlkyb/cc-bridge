# UI 功能优化清单

> 生成日期：2026-07-14
> 范围：对当前 `desktop/src` 全部页面与全局组件（Connect / Header / ConnectHero / TokenManager / Security / Settings / Log / Onboarding / CommandPalette / icon / toast / types）逐文件通读后的审查结果。
> 状态说明：本清单仅记录问题，**尚未改代码、未提交**（遵循项目规则 5）。

## 一、隐藏 Bug（功能缺陷，建议优先修）

| 编号 | 标题 | 位置 | 影响 | 建议修复 | 优先级 |
|------|------|------|------|----------|--------|
| B1 | 图标 `chevronUp` 缺失，展开时空白 | `SecurityTab.tsx:332` 动态引用；`ui/icon.tsx` 的 `paths` 字典无此键 | 展开"运行中的后台命令"输出时图标渲染成空 `<path>`，只剩文字 | 在 `icon.tsx` 补 `chevronUp` 路径（或复用 `chevronDown` 旋转 180°） | 高 |
| B2 | `running ?? true` 运行中幻觉 | `ConnectHero.tsx:23`；`CommandPalette.tsx:58、105` | 首帧/轮询间隙误显示"服务运行中"、绿点脉冲、canvas 动画，与 Header 已修的 `?? false` 同源不一致 | 统一改为 `?? false`，状态未拿到时默认"未运行" | 中 |
| B3 | 端口输入框被 5s 轮询覆盖 | `SettingsTab.tsx:51-53` 的 `useEffect` | 用户正在编辑端口（如 7823→7824）时，一次状态刷新即把输入打回旧值，编辑易丢失 | 仅在挂载/未手动编辑时同步；用 `editing` 标志位或 `defaultValue + onBlur` 提交 | 高 |
| B4 | 日志展开行按 index，轮询后串记录 | `LogTab.tsx:86、299、325` | 审计页每 10s 刷新，新日志插入导致整页下移，展开详情会指向另一条记录 | 改用稳定 key（如 `timestamp+tool+sourceIp`，或后端给 entry 加 id） | 中 |
| B5 | 日志"导出"只导当前页 | `LogTab.tsx:122-156` | 分页每页 50 条，但 `handleExport` 导出 `filtered`（当前页），非全量；用户以为是全量 | 标明"导出当前页 X 条"，或后端支持按条件全量导出 | 中 |
| B6 | 白名单目录不查重 | `SecurityTab.tsx:39-46` | 重复添加同路径产生两条；`removeRoot` 用 `indexOf` 删第一个，有重复时删不干净 | 添加前判重（`includes` 拦截）；删除用全量过滤 | 中 |
| B7 | 引导向导遮罩点击 = 永久跳过 | `OnboardingGuide.tsx:70` 遮罩 `onClick={handleSkip}` | 点卡片外任意位置即写 `localStorage` done 并永久关闭首启向导，且再也不出现，极易误触 | 去掉遮罩 onClick，只允许点"跳过引导"按钮才关 | 高 |

## 二、交互 / 体验问题

| 编号 | 标题 | 位置 | 影响 | 建议修复 | 优先级 |
|------|------|------|------|----------|--------|
| U1 | 命令面板危险操作无确认 | `CommandPalette.tsx:113、116` | "清空审计日志""重新生成访问令牌"一键 Enter 直接执行，而专属 UI 均有确认弹窗，安全不一致，误触即销毁数据/断开远程 | 面板内这两个命令加二次确认，或先从面板移除 | 高 |
| U2 | Token 重生成后折叠区收不回 | `TokenManager.tsx:27、50、57` | `regenDone` 永不复位，`expanded = tokenOpen \|\| confirmingRegen \|\| regenDone` 导致重生成后折叠区永远展开，点标题栏收不回 | 复位 `regenDone` 或将其移出 `expanded` 条件 | 中 |
| U3 | `InlineNum` 初始值=0 时失效 | `SecurityTab.tsx:549-551` | `initialized.current = initial !== 0`：字段值恰好为 0 时不置位，后续 prop 变化覆盖本地输入 | 改为用独立 `useState(false)` 跟踪是否初始化，而非依赖值是否为 0 | 低 |
| U4 | 审计保留天数清空 → 失焦存成 0 | `SettingsTab.tsx:288-308` | 清空输入框再点别处，`normalize` 把空→0 保存进后端 = "永久保留"，用户可能无意中把保留期改成永久 | 空值阻止保存或提示"保留期不能为空/0" | 中 |
| U5 | 工具筛选下拉只含当前页工具 | `LogTab.tsx:102-105` | `toolNames` 仅来自本页 entries，翻页后才出现的工具无法筛选 | 后端返回全量去重工具列表供筛选 | 低 |
| U6 | 停止态 canvas 静态残留 | `ConnectHero.tsx:109` | 停止服务时 canvas 定格，背景留下静止数据雨/星座，与"已停止"语义略冲突 | 停止态清空 canvas 或降透明度 | 低 |

## 三、建议修复顺序

1. B7（误触永久关闭引导）—— 最高风险，不可逆数据（引导消失）
2. B1（图标空白）—— 一眼可见的视觉缺陷
3. B3（端口被覆盖）—— 编辑易丢失，高频操作
4. B2（运行中幻觉）—— 状态显示一致性
5. B4 / B5（日志串记录、导出不全）—— 审计功能可信度
6. U1（命令面板危险操作）—— 安全一致性
7. 其余（U2/U3/U4/U5/U6）按需排期

## 四、关联上下文

- B2 与 `App.tsx` 的 S5 修复（Header `running ?? true` → `?? false`，2026-07-13 落地）同源，应一并统一到 `?? false`。
- 本轮与 2026-07-13「整体 UI 审查」互补；此前已落地：IP 选择 B 方案、S3 横幅方案 A、运行卡背景 ①+②。
- 所有改动未提交，待用户明确「提交」后按规则 5 走 git commit。
