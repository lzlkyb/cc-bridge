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
> 本節仅记录 **P1 / P2** 两级改进项（P3 侧栏导航/全局搜索/通知中心为长远项，暂不纳入）。**状态：P1 / P2 全部完成（未提交）。**
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
| P2-1 | 微交互统一【已完成，未提交】 | 全仓 hover/focus/active 过渡 | transition 时长 150/200/250/300 并存；图标按钮无按压反馈；加载态 spinner 不统一（UpdateBadge 内联 spinner / VersionHistoryModal 纯文本"加载中…"） | ① @theme 集中默认过渡(150ms+cubic-bezier) ② 新增 .interactive 语义类(统一过渡+active:scale 按压反馈)给 3 个图标关闭按钮 ③ ui/Spinner.tsx 统一加载态替换 UpdateBadge 内联 spinner 与 VersionHistoryModal 文本占位 ④ button 系统 base 补 active:scale-[0.98]；tsc 零错误、HMR 已热更 | 中 |
| P2-2 | 空状态设计【部分回退·未提交】 | `LogTab`(审计无记录/筛选无果) / `SecurityTab`(白名单为空/筛选无匹配) / `RunningCommandsCard`(无运行记录) / `CommandPalette`(无匹配结果) | 仅朴素占位或整卡消失，无引导文案/插画，新用户易以为"坏了" | 新建 `ui/EmptyState.tsx`（背景大图标 opacity-0.06 + 小图标 text-muted-foreground/40 + 引导文案 + 可选 action）；设计稿 `design/empty-state.html` 先确认。**2026-07-16 用户回退两处**：① `SecurityTab` 白名单为空块 + 筛选无匹配，恢复 P2-2 之前的原始写法（带"添加第一个目录"按钮的居中引导 / 朴素"没有匹配的目录"文案，去掉 EmptyState）；② `RunningCommandsCard` 恢复 `if (!commands || commands.length === 0) return null`——无命令时整卡不显示。现 EmptyState 仅保留于 `LogTab`(审计无记录/筛选无果) 与 `CommandPalette`(无匹配结果)；`tsc --noEmit` 零错误、dev HMR 已热更 | 中 |
| P2-3 | 分隔线规范【已完成，未提交】 | 重复出现的 `border-b/t border-border` / `border-r border-border`（SettingsRow / AuditPager / OnboardingGuide / VersionHistoryModal×3 / AboutGroup×3） | 分隔线写法散落重复，后续调整需逐处改；原笔记担心的 `border-white/10`/`border-black/5` 半透明分隔线经核查已 0 匹配 | `index.css` 新增 `.divider-x`(border-bottom)/`.divider-x-top`(border-top)/`.divider-y`(border-right) 语义类（值指向 `hsl(var(--border))` 随主题切换，`:last-child` 自动去末条边框）；9 处分隔线收口为语义类（零视觉变化）；有意例外（玻璃 chip 白边/虚线/时间线 2px/状态 pill 盒子边框）保留不动；`tsc --noEmit` 零错误、dev HMR 已热更 | 低 |
| P2-4 | 圆角尺度统一【已核查·无需改动】 | `rounded-md`(≈55) / `rounded-lg`(≈37) / `rounded-full`(≈27) / `rounded-xl`(≈13) / `rounded-2xl`(≈4) / `rounded-sm·3xl·none`(≈6) 跨 55 文件 | 原笔记担心"同语义元素圆角跳变"，实证核查后并未出现 | 全仓 Grep 统计显示圆角已按语义分层：`rounded-md`=按钮/输入/芯片/徽章等小控件，`rounded-lg`=卡片/面板/容器，`rounded-xl`·`rounded-2xl`=模态表面（按尺寸递进），`rounded-full`=胶囊/头像/圆点/开关；尺度连贯、无同语义跳变。全量 token 化需改 55+ 文件、视觉收益低、回归风险高，故标记已达标、不改动 | 低 |

### P1 / P2 执行顺序建议

1. **P1-1 + P1-2**（设置行统一 + 清内联 style）先行——消除最显眼的不一致，且为后续 token 化铺路。
2. **P1-3 + P1-4**（阴影/卡片 token）紧随——建立设计系统骨架。
3. **P2-1 ~ P2-4**（微交互/空状态/分隔线/圆角）表层润色，依赖 P1 的 token 基底才稳。
4. 全部纯前端，遵循规则 7（组件 ≤300 行）、规则 12（改前读真实源码）、规则 4（视觉变更先出 HTML 设计稿）。
