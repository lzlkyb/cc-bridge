# UI 功能优化清单

> 生成日期：2026-07-14
> 最近更新：2026-08-02（核实 + 补充：U7-U9 新增、逻辑漏洞段加入、B3/B6 状态更新）
> 范围：对当前 `desktop/src` 全部页面与全局组件（Connect / Header / ConnectHero / TokenManager / Security / Settings / Log / Onboarding / CommandPalette / icon / toast / types）逐文件通读后的审查结果。
> 状态说明：本清单仅记录问题，**尚未改代码、未提交**（遵循项目规则 5）。

## 一、隐藏 Bug（功能缺陷，建议优先修）

| 编号 | 标题 | 位置 | 影响 | 建议修复 | 优先级 |
|------|------|------|------|----------|--------|
| B1 | 图标 `chevronUp` 缺失，展开时空白 | `SecurityTab.tsx:332` 动态引用；`ui/icon.tsx` 的 `paths` 字典无此键 | 展开"运行中的后台命令"输出时图标渲染成空 `<path>`，只剩文字 | 在 `icon.tsx` 补 `chevronUp` 路径（或复用 `chevronDown` 旋转 180°） | 高 |
| B2 | `ConnectHero` `running ?? true` 运行中幻觉 | `ConnectHero.tsx:30`（**2026-08-02 核实仍存在**，注释里写"?? false"但代码是 `?? true`；`CommandPalette.tsx:122` 已修但 Hero 漏改） | 首帧/轮询间隙误显示"服务运行中"、绿点脉冲、canvas 动画，与 Header 已修的 `?? false` 不一致 | `ConnectHero.tsx:30` 改为 `?? false`，与 Header / CommandPalette 对齐 | 中 |
| B3 | 端口输入框被 5s 轮询覆盖【部分已修，未提交】 | `SettingsTab.tsx:56-79` `NetworkGroup` | 用户正在编辑端口（如 7823→7824）时，一次状态刷新即把输入打回旧值 | ✅ 2026-08-02 核实：`NetworkGroup` 已改为「偏离检测」(`syncedRef`) 兼顾"外部改端口后跟随"+ "编辑时不冲掉"；`AuditGroup`(`:436-456`) 仍用旧 `initialized.current` 一次性回填，需同步改造 | 高 |
| B4 | 日志展开行 rowKey 不稳定，轮询后串记录 | `LogTab.tsx:391` `rowKey = ${timestamp}-${tool}-${sourceIp}-${durationMs}` | 审计页每 10s 刷新，新日志插入导致整页下移，展开详情会指向另一条记录 | 改用稳定唯一 id（后端 `AuditEntry` 加 id 字段，或前端用 hash(content)） | 中 |
| B5 | 日志"导出"只导当前页 | `LogTab.tsx:122-156` | 分页每页 50 条，但 `handleExport` 导出 `filtered`（当前页），非全量；用户以为是全量 | 标明"导出当前页 X 条"，或后端支持按条件全量导出 | 中 |
| B6 | 白名单目录不查重【删除已修，添加未修，未提交】 | `SecurityTab.tsx:33-44` `addRoot`；`:46-58` `removeRoot` | 重复添加同路径产生两条；删除现在已按值过滤，OK；**添加前没判重**仍会插入重复条目 | 添加前用 `status.allowedRoots.includes(rootToAdd)` 拦截 | 中 |
| B7 | 引导向导遮罩点击 = 永久跳过 | `OnboardingGuide.tsx:112` 遮罩 `onClick={handleOverlayClick}`（**2026-08-02 核实仍存在**） | 点卡片外任意位置即写 `localStorage` done 并永久关闭首启向导，且再也不出现，极易误触 | 去掉遮罩 onClick，只允许点"跳过引导"按钮才关 | 高 |

## 二、交互 / 体验问题

| 编号 | 标题 | 位置 | 影响 | 建议修复 | 优先级 |
|------|------|------|------|----------|--------|
| U1 | 命令面板危险操作无确认 | `CommandPalette.tsx:60-71`（regenerate_token）、`:98`（clear_audit_log） | "清空审计日志""重新生成访问令牌"一键 Enter 直接执行，而专属 UI 均有确认弹窗，安全不一致 | 面板内这两个命令加二次确认，或先从面板移除 | 高 |
| U2 | Token 重生成后折叠区收不回【2026-08-02 核实仍存在】 | `TokenManager.tsx:32` `regenDone` 永不复位；`:57` `showBody = expanded \|\| confirmingRegen \|\| regenDone` | 重生成后折叠区永远展开，点标题栏收不回 | 复位 `regenDone`（如 5s 自动归零） 或将其移出 `showBody` 条件 | 中 |
| U3 | `InlineNum` 初始值=0 时失效 | `SecurityTab.tsx:549-551` | `initialized.current = initial !== 0`：字段值恰好为 0 时不置位，后续 prop 变化覆盖本地输入 | 改为用独立 `useState(false)` 跟踪是否初始化，而非依赖值是否为 0 | 低 |
| U4 | 审计保留天数清空 → 失焦存成 0【2026-08-02 核实仍存在】 | `SettingsTab.tsx:468` `normalize = (raw) => (NaN \|\| raw < 0 ? 0 : Math.floor(raw))` | 清空输入框再点别处，normalize 把空→0 保存进后端 = "永久保留"，用户可能无意中把保留期改成永久 | 空值阻止保存（toast 提示"保留天数必填"）或给 0 加红字警告 | 中 |
| U5 | 工具筛选下拉只含当前页工具 | `LogTab.tsx:102-105` | `toolNames` 仅来自本页 entries，翻页后才出现的工具无法筛选 | 后端返回全量去重工具列表供筛选 | 低 |
| U6 | 停止态 canvas 静态残留 | `ConnectHero.tsx:109` | 停止服务时 canvas 定格，背景留下静止数据雨/星座，与"已停止"语义略冲突 | 停止态清空 canvas 或降透明度 | 低 |
| U7 | 4 套弹窗壳并存，行为不一致【2026-08-02 新增】 | `ui/Modal.tsx` + `dialog.tsx` + `ConfirmDialog.tsx` + `ConfirmModal.tsx`（4 个文件并存于 `ui/`） | 弹窗的 Esc 关闭 / 遮罩关闭 / 焦点陷阱 / z-index 行为各异；调用方容易选错导致体验割裂 | 收口到 `Modal` 原语 + 单一 `ConfirmDialog`；删除 `dialog.tsx` / `ConfirmModal.tsx` 两个未在用的旧壳 | 中 |
| U8 | Modal 原语无焦点陷阱【2026-08-02 新增】 | `Modal.tsx:67-75` 只实现 Esc 关闭，无 Tab 循环 / 焦点归还 | 打开任何非 `ConfirmDialog` 的弹框（DirectoryBrowser / AboutGroup 自建遮罩等），键盘 Tab 会跑到背后的卡片/页面，违反 WAI-ARIA dialog 规范 | 把 `ConfirmDialog.tsx:40-65` 的 focus trap 提升到 `Modal` 原语，关闭时归还焦点 | 中 |
| U9 | 命令白名单开关关闭无二次确认【2026-08-02 新增】 | `CommandAllowlistCard.tsx:55` `setAllow = (next) => save({...}, "allowlist")` 直接落盘 | 与 `SettingsToggles.tsx` 的 `handleWhitelist`（白名单关闭走 ConfirmDialog）行为不一致；命令白名单关闭是高风险操作（远程 Claude 可执行任意命令） | 改为走 `ConfirmDialog`，文案强调"关闭后远程 Claude 可执行任意命令" | 高 |

## 三、建议修复顺序

1. B7（误触永久关闭引导）—— 最高风险，不可逆数据（引导消失）
2. B1（图标空白）—— 一眼可见的视觉缺陷
3. B3（端口被覆盖 — 仅剩 AuditGroup 同步）—— 编辑易丢失，高频操作
4. B2（Hero 运行中幻觉）—— 状态显示一致性
5. B4 / B5（日志串记录、导出不全）—— 审计功能可信度
6. U1（命令面板危险操作）—— 安全一致性
7. U9（命令白名单关闭确认）—— 安全一致性
8. U8（Modal 焦点陷阱）—— 无障碍合规
9. 其余（U2/U3/U4/U5/U6/U7）按需排期

## 四、关联上下文

- B2 与 `App.tsx` 的 S5 修复（Header `running ?? true` → `?? false`，2026-07-13 落地）同源，应一并统一到 `?? false`。
- 本轮与 2026-07-13「整体 UI 审查」互补；此前已落地：IP 选择 B 方案、S3 横幅方案 A、运行卡背景 ①+②。
- 所有改动未提交，待用户明确「提交」后按规则 5 走 git commit。

## 五、逻辑漏洞（2026-08-02 补充）

> 范围：`desktop/src-tauri/src/` Rust 后端。配合 UI 端清单一起看；MCP 工具与 HTTP 入口的逻辑漏洞与上面 UI/交互问题互补。

| 编号 | 标题 | 位置 | 影响 | 建议修复 | 优先级 |
|------|------|------|------|----------|--------|
| L1 | 白名单根不存在时全部请求被静默拒绝 | `security/path.rs:13-18` `canonicalize_roots` fallback 路径无 `\\?\` 前缀；`:86, :110-112` `is_within = path.starts_with(root)` 按字符串前缀比较 | 用户配置的 root 路径不存在（如卸载外挂盘）→ canonicalize 失败 fallback 到原路径（无 `\\?\`），实际请求被 canonicalize 加 `\\?\`，`starts_with` 永远 false → 所有写工具报"不在白名单"。远程 LLM 会误判环境无写权限、去尝试 `..` 绕过 | `is_within` 改用 PathBuf 路径分量比较；或 `canonicalize_roots` 失败时也加 `\\?\` 前缀归一化；或不可用 root 主动清理缓存 | 高 |
| L2 | 后台命令并发上限 check-evict-check 非原子 | `mcp/tools/run_command.rs:197-206` 两段 `if (background && state.running_commands.len() >= 5)` 中间夹 `evict_finished_commands().await` | 两个并发 background 请求都看到 len=4、都跳过拒绝、都 insert → 实际 6 个，超过 `MAX_CONCURRENT_BACKGROUND=5`，进程累积资源耗尽 | 把 check + insert 包进互斥区（用 `running_commands` entry 的锁或独立 `AtomicUsize`） | 高 |
| L3 | `copy_files` / `move_files` 跳过文件大小限制，可绕过 `max_file_size_bytes` | `mcp/tools/copy_files.rs` / `move_files.rs`（grep 无 `assert_file_size`） | 用户配置 20MB 限额，`read_files` / `edit_files` 走 `assert_file_size_ok` 校验，但 `copy_files` / `move_files` 直接 `tokio::fs::copy`，可"先 copy 再 read"绕过配额 | 在 `copy_files` / `move_files` 入口加 `assert_file_size_ok(&from_resolved, ...)`（读源 metadata 时已有，可直接复用） | 高 |
| L4 | `copy_files` 只锁目标路径，源路径无锁保护 | `mcp/tools/copy_files.rs:64-70` 只对 `to_resolved` 加锁，`from_meta` 在锁前读 | 期间另一并发工具可删 / 改源，导致 copy 失败或复制不一致内容 | 与 `move_files.rs:66-83` 一致，源 + 目标双重锁；按字典序避免死锁；from==to 时只锁一次 | 中 |
| L5 | `get_status` 5s 轮询中 `firewall_cache` 锁内同步调 `query_firewall_state` | `commands.rs:197-211` 持 `firewall_cache` 锁 → 调 `query_firewall_state(config.port)`（netsh 阻塞调用） | 冷启动首帧 `cache.checked_at.is_none()` 时，5s 轮询首帧同步等 netsh 返回（100ms+），期间其它读 `firewall_cache` 的请求阻塞 | 把 `query_firewall_state` 调出锁，结果拿到后再上锁写回 | 中 |
| L6 | `latency_samples` 上限 500，P95 失真 | `state.rs:311-319` `const CAP: usize = 500` | 高频调用下，样本环形队列只反映最近 500 次的"最后一小段"，UI 展示的 P95 误导 | 改用 reservoir sampling 或加大 CAP（如 5000）；文档说明"近 N 次窗口"语义 | 低 |

> 注：以下疑似问题**实际是设计意图 / 已修复**，本轮核实确认不是 bug：
> - **L-A** `/mcp/messages` 与 `/mcp` 共享同一对端 IP 限流键（`http.rs:200-201` 注释明确「同一客户端的工具调用总量限流」）
> - **L-B** `move_files` 双锁死锁风险（`move_files.rs:66-83` 已按字典序双重锁 + from==to 自死锁防护）

## 六、测试覆盖盲区（2026-08-02 补充）

| 编号 | 标题 | 位置 | 现状 | 建议修复 | 优先级 |
|------|------|------|------|----------|--------|
| T1 | 大量 over-the-wire 集成测试被 `#[ignore]` 跳过 | `mcp/http.rs` 共 **18 个 `#[ignore]`**（实测，agent 报告 22 个略偏） | CI 默认 `cargo test` 不跑这些；只能靠手动 `--ignored` 触发；鉴权 / SSE / 限流 / dispatch 等回归靠人肉 | 把不依赖真实网络 / 端口的测试（`initialize_*` / `tools_list_*` / `auth_*`）取消 `#[ignore]`，让 CI 默认跑；性能基准保留 ignore | 中 |
| T2 | 后台命令并发上限 race 无集成测试 | L2 描述场景 | `running_commands` 并发上限 race 没有任何集成测试覆盖 | 加并发 background 调用测试，断言实际并发 ≤ MAX | 中 |
| T3 | `resolve_safe_path` symlink 攻击场景无测试 | L1 描述场景 | 现有测试只覆盖字符串前缀，`\\?\` 绕过 / Junction 重定向无显式测试 | 加 symlink 链、Junction、`\\?\` 前缀差异等单元测试 | 低 |

## 七、UI 升级改进项（设计语言统一 P1 / 视觉润色 P2）

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
