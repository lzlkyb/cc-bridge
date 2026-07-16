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

## 五、UI 升级改进项（设计语言统一 P1 / 视觉润色 P2）

> 来源：2026-07-16 整体 UI 升级建议的 P0–P3 分级。P0（架构卫生：拆 ConnectTab/SecurityTab + 提升 ToggleRow/InlineNum + 统一确认弹窗）已于当日执行完，见上方「四、关联上下文」。
> 本節仅记录 **P1 / P2** 两级改进项（P3 侧栏导航/全局搜索/通知中心为长远项，暂不纳入）。**状态：P1-1、P1-2、P1-3、P1-4 均已完成代码改动（未提交）；下一步 P2-1~P2-4 表层润色。**
> 实证依据（2026-07-16 全仓 Grep）：内联 `style={{` 散落 13 个文件；`shadow-*` 任意值 + 内联 `boxShadow` 并存；`rounded-*` 在 50+ 文件种类繁杂——印证下方"清内联 style / 规范阴影圆角 token"确为真实问题。

### P1 设计语言统一（结构性，先做）

| 编号 | 标题 | 范围 / 位置 | 现状 | 建议修复 | 优先级 |
|------|------|-------------|------|----------|--------|
| P1-1 | 统一「设置行」布局组件【已完成，未提交】 | `SettingsToggles`(`ToggleRow`) / `SecurityTab`(`InlineNum`+按钮行) / `SettingsTab`(端口、保留天数输入行) / `TokenManager`(自定义行) | 各 Tab 的"标签 + 说明 + 控件 + 保存指示"行布局各自为政，对齐/间距/字号不一致 | 抽象统一 `SettingsRow`（props：`label` / `sublabel` / `control` / `saved?`），替换散落写法；已有 `ui/ToggleRow.tsx` 可纳入此体系 | 高 |
| P1-2 | 清理内联 `style={{}}`【已完成，未提交】 | 13 文件：`toast.tsx`、`AboutGroup.tsx`、`LogDetailPanel.tsx`、`chip-input.tsx`、`VersionHistoryModal.tsx`、`UpdateNotesDialog.tsx`、`TokenManager.tsx`、`PerfCharts.tsx`、`LogTab.tsx`、`AuditPager.tsx`、`ui/tabs.tsx` 等 | 硬编码颜色/尺寸散落内联，暗色模式与主题切换易漏改、难统一 | 静态 inline 已全部转为 Tailwind class / CSS token（遮罩、卡片背景、渐变、阴影、旋转、maxWidth/Height 等）；仅动态/数据驱动（数据色、进度条宽度、动画指示器）保留内联；`tsc --noEmit` 零错误 | 高 |
| P1-3 | 规范阴影 token【已完成，未提交】 | 全仓 `shadow-lg/md/sm` + `shadow-[...]` 任意值 + 内联 `boxShadow` 并存 | 卡片/弹窗/悬浮态阴影层级无统一标尺，深浅主题下观感漂移 | `@theme inline` 注册 9 个 token（card/pop/hover + glow-primary/-lg/-strong + glow-warning + ring-focus + ring-inset-primary），浅/深两套值经 `--sh-*` 变量切换；约 30 处散落阴影改为 token 类；5 处重复聚焦环合并为 `shadow-ring-focus`；保留 ConnectHero 玻璃按钮与版本徽章（已 token 化） | 中 |
| P1-4 | 统一卡片/容器基底【已完成，未提交】 | 模态表面 10 处（VersionHistoryModal / UpdateNotesDialog / OnboardingGuide / CommandPalette / DirectoryBrowser / LogDetailPanel×2 / dialog / ConfirmModal / ConfirmDialog）共享 `border bg-card … shadow-pop` 但代码重复 | 同类模态容器基底写法重复、后续调整阴影/边框需逐处改 | 经调研：内容卡已统一（`<Card>`/`.card-primary`/`.card-lift`），真实价值在**去重模态表面**；沿用项目语义类约定新增 `.modal-surface`（border + bg-card + shadow-pop，深浅主题自适应），收口 10 处模态，零视觉变化、零结构风险 | 中 |

### P2 视觉润色（表层，P1 之后做）

| 编号 | 标题 | 范围 / 位置 | 现状 | 建议修复 | 优先级 |
|------|------|-------------|------|----------|--------|
| P2-1 | 微交互统一 | 全仓 hover/focus/active 过渡 | `transition-colors duration-150` 等用法散落、部分控件无按压/聚焦反馈，加载态 spinner 样式不统一 | 抽象交互基元（hover/focus/active 过渡时长与缓动统一）；loading 态统一 spinner 组件 | 中 |
| P2-2 | 空状态设计 | `LogTab`(审计无记录) / `SecurityTab`(白名单为空) / `RunningCommandsCard`(无历史) / 日志筛选无结果 | 仅朴素占位或留白，无引导文案/插画，新用户易以为"坏了" | 统一空状态组件（图标 + 一句引导 + 可选操作按钮），覆盖上述场景 | 中 |
| P2-3 | 分隔线规范 | 全仓 `border-border` / `border-white/10` / `border-black/5` 混用 | 分隔线明暗与粗细不一致，列表/卡片内割裂感 | 建立 divider token（如 `border-border` 统一），替代任意透明度分隔线 | 低 |
| P2-4 | 圆角尺度统一 | `rounded` / `rounded-lg` / `rounded-xl` / `rounded-2xl` / `rounded-full` 在 50+ 文件并存 | 同语义元素圆角跳变（如卡片有 lg 有 xl），整体精致度受损 | 映射到统一 radius token（sm=6 / md=10 / lg=14 / full=9999px），按钮/卡片/弹窗/头像各归其档 | 低 |

### P1 / P2 执行顺序建议

1. **P1-1 + P1-2**（设置行统一 + 清内联 style）先行——消除最显眼的不一致，且为后续 token 化铺路。
2. **P1-3 + P1-4**（阴影/卡片 token）紧随——建立设计系统骨架。
3. **P2-1 ~ P2-4**（微交互/空状态/分隔线/圆角）表层润色，依赖 P1 的 token 基底才稳。
4. 全部纯前端，遵循规则 7（组件 ≤300 行）、规则 12（改前读真实源码）、规则 4（视觉变更先出 HTML 设计稿）。
