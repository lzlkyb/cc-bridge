# Changelog

本项目所有重要变更记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 连接页新增“权限自动授权”区块（`ConnectTab.tsx`，紧跟在 `TokenManager` 之后）：一键复制命令往 Claude Code 的 `permissions.allow` 追加 cc-bridge 工具规则 + 信任该 MCP 服务器，免去每次调用都弹窗确认（无需重启会话，改完立即生效）。
- 新增 `buildPermissionGrantCommand`（`lib/utils.ts`）：默认逐个列出 14 个文件/列表类工具规则，`run_command`/`get_command_output`/`stop_command` 三个命令执行工具需手动打开开关才会带上（改成单条 `mcp__cc-bridge__*` 通配符，同时自动覆盖未来新增工具），开关打开时显示红色警示条。
- 权限命令用 `python3` 读-改-写，幂等去重，不依赖 `jq`（不保证所有用户环境已安装）；目标文件固定落 `settings.local.json`（项目级，不进 git）/`settings.json`（全局），与连接命令用的 `.mcp.json` 区分开——权限规则属个人本地免打扰设置，不适合和团队共享的 MCP 服务器配置混在一起。
- 项目级且路径未填写时显示警告：命令不带 `cd` 前缀会直接用执行时终端所在目录拼相对路径，若不在目标目录下执行会悄悄写到错误位置且不报错，故加了明显警示文案。
- `formatDurationMs`（`lib/utils.ts`）：毫秒耗时自动换算中文单位（微秒/毫秒/秒/分），避免用户看到 10000ms 这类大数字还要心算，应用到 `LogTab.tsx`/`PerfCharts.tsx` 全部耗时展示点，删除 `PerfCharts.tsx` 重复的局部 `fmt()`。
- 安全页“运行中的后台命令”卡片新增状态徽章（`CommandStatusBadge`：运行中/已结束/失败 + 退出码），避免处于 5 分钟清理宽限期内的已结束命令被误以为还在跑，卡片标题下加一行说明文字。
- 后台命令定时自动清理（`commands::cleanup_finished_commands`，`main.rs` 每 60s 调一次）：已结束满 5 分钟宽限期（供查看最终输出）后自动从 `running_commands` 注册表移除。
- 后台命令数命中 5 个并发上限时优先腾位（`commands::evict_finished_commands`）：不等 5 分钟宽限期，先尝试把已结束的命令立即移除为新命令腾空位，真正 5 个都还在跑时才拒绝，不再需要用户手动 `stop_command` 才能重试。

### 修复
- **执行命令时一闪而过的空白 cmd 黑窗**：`spawn_shell` 之前只设置了 stdout/stderr 为 `Stdio::piped()`，没显式设置 stdin。cc-bridge 本身是 GUI 子系统程序没有控制台，子进程默认继承到的 stdin 句柄无效，`cmd.exe` 拿到无效句柄后会尝试自己申请控制台兼底，瞬时击穿 `CREATE_NO_WINDOW` 的抑制效果。现显式 `c.stdin(Stdio::null())`，不再给 cmd.exe 理由自己申请控制台。
- 安全页“运行中的后台命令”卡片“已运行”一直增长：`elapsed_seconds` 之前恒用 `started_at.elapsed()` 实时计算，即使进程早已退出（v1 不自动回收注册表条目）仍会随面板轮询一直长。`RunningCommand` 新增 `finished_elapsed_secs` 字段，由 wait 线程与 `exit_code` 同时定格，面板优先用定格值。
- **O1 耗时拆解面板长期缺失两项维度**：`auditMs`/`overheadMs` 之前用整数毫秒存储，实测典型值在微秒级（~6.8µs）会恒截断为 0，被前端 `filter(s.ms > 0)` 过滤隐藏。后端 `audit.rs`/`http.rs` 改用 `f64` 保留小数精度，两项现在能正常显示。
- `batch` 子操作审计记录之前全部传 `None`，导致日志列表里 `batch` 相关行的耗时列一律显示“—”。`batch.rs` 现在为每个子操作单独计时。
- 安全页“运行中的后台命令”卡片：操作列固定宽度 `w-[160px]` 小于两个按钮（查看输出/收起 + 终止）实际宽度，导致换行。加宽到 `w-[210px]`，并加 `whitespace-nowrap` 防止文字换行。
- `buildConnectCommand`（连接页“项目级”接入命令）缺失 `--scope project` 参数：之前项目级分支不加任何 `--scope`，而 Claude Code CLI 不带 `--scope` 时默认是 `local` scope（写入 `~/.claude.json` 按项目路径存的部分），与连接页文案宣称的 `.mcp.json` 不符。导致地址变化 `IpChangedBanner` 与 Token 重生成 `TokenManager` 生成的 sed 命令（均假设 project scope = `.mcp.json`）在项目级场景下实际改不到真正生效的配置文件，表现为“复制 sed 命令执行后不生效/地址仍不对”。现显式加 `--scope project`，与 sed 命令生成逻辑的假设保持一致。

## [2.2.23] - 2026-07-12

### 亮点
- MCP 后端分发层重构：手写 `match` 分发改为「工具注册表 + `ToolSchema` 派生宏」，17 个工具的 `inputSchema` 自动从 handler 的 Args struct 派生，新增工具零样板、协议契约与代码同源
- 新增 over-the-wire 集成测试：真实起 MCP server + 真实 reqwest 客户端端到端验证协议握手、17 工具分发与落盘副作用、鉴权 / 限流 / gzip / 错误码，测试套件 72 → 82 全绿、`cargo clippy --no-default-features` 零警告
- 连接页方案 A 完整落地：Token 内嵌复制命令、`s-sec-label` 安全分区、渐变徽章步骤、灰底命令框、步骤行 hover
- 关于页更新历史自动化：从 `CHANGELOG.md` 自动生成（`gen-changelog.mjs` + `changelog.generated.ts` + `ChangelogView`），不再出现「落后好几个版本」

### 新增
- 工具注册表 `src/mcp/tools/registry.rs`：集中声明 17 个工具的名称 / 读写属性 / handler 分发，替代散落各处的 `match` 分支
- `ToolSchema` 派生宏（新增 `cc-bridge-macros` proc-macro crate，仅编译期依赖、不进 exe，守二进制体积红线）：从工具 Args struct 自动生成 `inputSchema`
- over-the-wire 集成测试模块（`http.rs`，10 个用例）：initialize 回显 / tools/list=17 / 未知方法 -32601 / 全工具分发+副作用 / 后台 run→output→stop 三元组 / auth 401·200 / 限流 429 / gzip 响应头
- 关于页 `ChangelogView` 组件 + `scripts/gen-changelog.mjs` + `src/lib/changelog.generated.ts`，更新历史从 `CHANGELOG.md` 自动同步
- `TokenManager.tsx` 令牌管理界面
- `list_allowed_roots` 增强：自动内嵌各根目录顶层 `CLAUDE.md` 到 `projectInstructions`（超过 20KB 仅给路径提示）

### 变更
- 后端分发由 `match` 分支改为 registry 查表分发，全部 17 个工具接入注册表
- 连接页方案 A 完整落地：Token 内嵌复制命令、`s-sec-label` 分区、渐变徽章步骤、灰底命令框、步骤行 hover（PastePanda 风格优化）
- 后端性能与质量优化：`config.rs` / `audit.rs` / `db.rs` / `main.rs` 模块重构
- `search_files` 内容搜索增强、`read_files` 编码与行号能力增强

### 修复
- `notebook_edit` 驼峰 `newSource` 字段被静默忽略：该字段此前只有 `#[serde(default)]` 缺 `#[serde(rename = "newSource")]`，客户端按文档传 camelCase 时单元格被清空为 `""`；补 rename 后修复（此缺陷因既有单测直接构造 Rust struct、从未走 JSON 反序列化而长期未发现，恰由本次 over-the-wire 测试捕获）
- 审计日志改同步落盘：`write_audit_for_call` 与 batch 子操作审计原用 `spawn_blocking` 后台异步写盘，与"响应返回后立即读 audit.log"无 happens-before，并发跑 `perf_real` 集成测试时后台写盘被抢占排队导致 `batch_writes_are_audited` 偶发 `NotFound`。改为同步写盘（单条 ~6.8µs，比 spawn_blocking 跨线程调度 20-50µs 更省，对微秒级小 IO 异步本是负优化），请求返回前审计必已落盘，竞争消除

### 测试
- 新增 10 个 over-the-wire 集成测试；测试套件 72 → 82 全绿（含原有单测 + registry 遍历断言 + over-wire）；`cargo clippy --no-default-features --tests` 零警告；`tsc --noEmit` 零错误

### 技术
- `reqwest` / `axum` 作为 dev-dependency 支撑集成测试，`default-tls` 在 Windows 走系统 schannel，无需 openssl 编译

## [2.2.22] - 2026-07-11

### 亮点
- 关于页与连接页全面改用 PastePanda 风格，信息更清晰、操作更顺手
- 扩展名可按类别勾选，白名单配置更快
- 更新历史改为自动同步，不再出现「落后好几个版本」

### 新增
- 关于卡片 PastePanda 风格重写：默认收起成一行，点开双列展示（技术栈 + 项目信息），更新历史按「新增 / 改进 / 修复 / 安全」分类标签呈现，详情弹框介绍完整能力。
- Header 版本号支持一键检查更新：空闲时点击即可检查，覆盖检查中 / 有新版 / 下载中 / 待重启 / 已最新 / 出错等状态。
- 托盘图标升级：改用应用真图标，并在右下角叠加运行状态小圆点。
- 扩展名芯片输入：常用扩展名按「前端 / 后端 / 配置 / 文档」分类，点开勾选、分色显示；也支持自定义输入（回车、逗号、粘贴拆分）。
- 统一应用信息数据源：名称 / 作者 / 仓库 / 协议等集中管理，多处界面一致。

### 变更
- 文件管控改用行式渐变徽章，备份与限流配置更紧凑直观。
- 网络卡片端口与保存按钮同行，去掉容易误解的「当前地址」行。
- 安全概览标题与展开箭头合并为一行，整行可点。
- 全应用统一为「CC Bridge」名称（此前部分界面显示小写 cc-bridge）。
- Header 图标改为纯图标，去掉多余底色与阴影。

### 修复
- 修好一处会导致 19 个编译错误的类型绑定问题。

### 技术
- 移除冗余输入组件、改用语内联输入；补充图标；Rust 与 TypeScript 均零警告。

## [2.2.17] - 2026-07-10

### 亮点
- 新增 Notebook 编辑能力，AI 可直接改 .ipynb
- 搜索文件支持上下文、行号等富选项，大项目找内容更精准

### 新增
- 新增 `notebook_edit` 工具：可按单元格对 `.ipynb` 笔记本做替换 / 插入 / 删除，AI 编辑 Notebook 更顺手（只读模式会拒绝该写类工具）。
- `run_command` 新增 `description` 字段：给每条命令加一句人话说明，审计日志里一眼看懂这条命令在做什么。

### 变更
- 远程 AI 连上即自动获得使用引导（哪些工具可用、安全约束），不用每次新会话口述。

### 说明
- 搜索文件增强：支持大小写不敏感、上下文行、行号、输出模式（仅路径 / 计数 / 内容）等富选项。
- 未做「命令执行目录持久化」：会改变 cc-bridge 刻意无状态的安全取舍，按评估留作独立方案。

### 测试
- 新增 11 个单元测试，测试套件 41 → 52 全绿。

## [2.2.16] - 2026-07-10

### 亮点
- 后台命令管控更稳，连接不再卡在残留进程上

### 变更
- 后台命令整树终止改用社区成熟方案（process-wrap），替代手写的 Windows 进程管理，跨平台更可靠。
- 修复「先启动子进程再挂入进程组」之间的竞态窗口，孙进程不再漏杀。
- 终止语义明确：显式杀整棵树，避免留下残留进程。

### 技术
- 移除自写的进程管理代码，依赖更精简；`cargo test` 41 全绿、零警告。

## [2.2.15] - 2026-07-10

### 新增
- 命令执行增加危险命令拦截：开启命令执行后，`rm -rf /`、格式化磁盘、fork bomb 等毁灭性命令会在执行前被直接拒绝，保护你的机器。

### 说明
- 当前为启发式拦截（最低成本兜底），误伤与漏拦并存，后续会升级为更严谨的沙箱。

## [2.2.14] - 2026-07-10

### 修复
- 根治真实程序（如 git.exe / cargo.exe）执行后读不到输出的问题：改用标准管道直接启动，命令输出现在能正确捕获、标准错误也不再恒为空。
- 修好测试套件会误杀自身的问题，约半数用例之前从未真正运行。

### 变更
- 移除不可用的终端模拟方案，依赖更干净。

## [2.2.13] - 2026-07-10

### 变更
- 后台命令整树终止改用 Windows 进程组，子进程 / 孙进程不再漏杀，应用异常退出也不会留下孤儿进程。
- 搜索文件改用成熟目录遍历库，自动跳过 node_modules / target 等，跨目录 glob 匹配终于好用。
- 写文件结果新增改动对比（diff），AI 改动前你能先核对。
- 限流改用真实对端 IP，防止伪造请求头绕过限流（修复一处安全隐患）。

### 新增
- 抽离进程管理与 diff 生成模块，代码结构更清晰。

### 修复
- 清理一批过时代码检查告警；删除一处从未被引用的死代码（限流模块）。

## [2.2.8] - 2026-07-10

### 新增
- 首次使用引导 `OnboardingGuide`：三步引导用户添加白名单目录 → 复制连接命令 → 启动服务，本地 `localStorage` 记忆已引导状态，仅首次弹出。
- 命令面板 `CommandPalette`（Ctrl+K / ⌘K）：键盘快速切换 4 个 Tab，支持搜索、↑↓ 导航、Enter 确认、Esc 关闭；全局快捷键 Ctrl+1~4 直跳 Tab。
- 连接页 Hero 卡升级：新增启停大按钮（loading 态 + 内联错误提示）、指标变化弹跳动画、运行时长平滑跳秒（本地每秒自增 + 5s 轮询校准）。
- 安全页「运行中的后台命令」卡片：列出 `run_command(background=true)` 启动的进程（PID/命令/已运行时长），一键终止，与远程 `get_command_output` 共享注册表。
- 安全页白名单目录搜索框 + 扩展名预设快捷填充（前端常用/后端常用/配置文件/文档类）。
- 日志页升级：搜索 + 工具/状态筛选、JSON/CSV(Excel) 导出、行展开查看参数详情（高亮代码块 + 复制）、清空日志二次确认。
- 托盘增强：图标随服务运行状态切换（运行时绿点 / 停止灰点，代码生成无需额外资源）；左键点击托盘 toggle 主窗口显隐；右键菜单新增「复制连接命令」（经前端通道写剪贴板 + toast）；tooltip 实时显示「运行中 / 已停止 / 地址变化」；启停时即时刷新托盘（通过 `mcp-status-changed` 事件）。
- 主题切换过渡动画：深/浅色切换时颜色类属性 0.45s 平滑过渡，切换瞬间临时启用 `theme-transition` 避免常驻 transition 拖累性能与首屏闪烁。
- 复制反馈补全：日志详情「复制参数」也走 `toast` 统一反馈，与连接页复制连接命令 / Token 保持一致。

### 变更
- `tabs.tsx` 升级为 segmented pill 滑动指示器（绝对定位高亮块 + transform 过渡，窗口 resize 重算），替代旧静态高亮。
- `SettingsToggles` 新增「命令执行」开关，开启等同授予 RCE，需勾选风险确认的二次确认弹窗；新增「恢复默认设置」按钮。
- `StatusResponse` 新增 `lastSelectedIp` / `ipChanged` 字段，IP 选中态提升到 App 层，重启后用上次确认 IP 回填，避免切 Tab 丢失。
- `start_mcp_server` / `stop_mcp_server` 命令新增 `AppHandle` 参数，启停后 emit `mcp-status-changed` 事件驱动托盘即时刷新。

### 修复
- 连接页 Hero 卡 4 列指示签删掉「在线客户端」（后端从未实现该字段，前端一直显示 `--`），改为 3 列（总请求 / 错误 / 运行时间）。
- Hero 主题适配：拆分 `--hero-gradient` / `--hero-shadow` / `--hero-glow-1/2` / `--hero-metric-bg/border` / `--hero-addr-bg/border` 变量，两主题各配一份，深色下渐变降饱和 + 加白边避免融背景；装饰光晕深色下透明度砍半避免刺眼；指标卡补玻璃质感（`backdrop-filter: blur(4px)` + 半透明背板）。
- LogTab 清理：删除未使用的 `PAGE_SIZE` / `totalPages` / `paged` memo / `useEffect` 同步分页 / `useState(0)` 状态（前端实际未做分页 UI）；`tsc --noEmit` 现在 0 错误。
- 类型修正：`ConnectHero.tsx` 的 `HeroMetric` 指标签 `icon` 字段从字面量字符串联合扩为完整 `IconName`（避免新增 `Icon` 类型时回归报错）；`button.tsx` 删除未使用的 `ReactNode` 导入。
- `package.json` 版本号同步到 2.2.8（之前漏改）。

## [2.2.7] - 2026-07-10

### 变更
- v2.2.2 → v2.2.6 release 期间累积改动合并提交：
  - 后端：注册 `start_update` 等 Tauri command、补 `tauri-plugin-updater` / `tauri-plugin-notification` / `tauri-plugin-process` 依赖，`main.rs` 调整启动流程。
  - 前端设计系统升级：靛蓝主题色、玻璃指标卡、segmented pill Tab、`TitleBarControls` 自绘标题栏、`Toast` 统一反馈组件、`index.css` +220 行新样式变量。
  - `UpdateContext` 抽出更新状态层；`Header` 拆 `UpdateBadge`；多个 tab 卡片样式更新。
- 图标套件重新生成（18 个 png/ico 体积变化）。

## [2.2.6] - 2026-07-09

### 新增
- Release 副产物：绿色便携版 zip（`cc-bridge_<version>_x86_64-pc-windows-msvc.zip`），解压即用不需安装，方便 U 盘随身 / 无管理员权限环境。CI 参考 PastePanda 方案新增 `📦 打包绿色便携版` step，自动随 tag 发布到 GitHub Release。

### 修复
- 同步 `Cargo.lock` 中 v2.2.5 版本号（之前 2.2.5 release 时 sync-version 触发了 lock 重生但未提交）。

## [2.2.5] - 2026-07-09

### 修复
- 自动更新 ACL 权限：`capabilities/default.json` 缺 `updater:default` 和 `process:default`，导致前端 `check()` 调用报 `Command plugin:updater|check not allowed by ACL`。补齐后 `check()` / `downloadAndInstall` / `relaunch` 全部放行。

## [2.2.4] - 2026-07-09

### 变更
- Release 体积优化：`Cargo.toml` 加 `[profile.release]` 配置（`codegen-units=1` + `lto="thin"` + `opt-level="s"` + `strip="symbols"`），预计 exe 体积从 19.5MB 降至 14-15MB。
- Header 组件拆分：把 `useUpdate` 调用与两个更新状态徽章抽到独立组件 `UpdateBadge.tsx`，降低 Header 复杂度，遵守 300 行组件上限。

### 新增
- 仓库级 git hook：`.githooks/pre-push` push 前自动运行 `tsc --noEmit` + `cargo test`，杜绝带病 push。

## [2.2.3] - 2026-07-09

### 变更
- CI 优化：`Swatinem/rust-cache@v2` 接入（缓存 `desktop/src-tauri` 依赖），依赖未变时构建耗时从 10+ 分钟降至 2-4 分钟。
- CI 升级：Node 20 → 22（Node 20 已 EOL，消除 GitHub Actions Node 弃用警告）。

## [2.2.2] - 2026-07-09

### 新增
- 命令执行 MCP 工具：`run_command`（后台执行 shell 命令）/ `stop_command`（终止）/ `get_command_output`（拉取输出）。
- 应用内自动更新：启动时 + 每 24 小时检查，指数退避重试，通过 Tauri event 实时推送下载进度；采用 Tauri v2 静态 `updater.json` 方案（指向 GitHub Release latest），下载后 minisign 验签再静默安装。
- `list_allowed_roots` 自动内嵌各根目录顶层 `CLAUDE.md` 到 `projectInstructions`（超过 20KB 仅给路径提示），远程 Claude Code 连接后一步即可拿到项目规则。

### 修复
- CI 构建显式设置空签名密码，避免无 TTY 环境下 Tauri 交互式密码提示卡死。

## [2.2.1] - 2026-07-08

### 新增
- 「读取编码自适应」功能开关（**默认关闭**）：关闭时按 UTF-8 读取避免误判，开启后自动识别 GBK/GB18030；显式 `encoding` 参数始终优先，不受开关影响。

### 修复
- 编码/换行保真加固（参考 nc-compile/ccedit.py 经验）：
  - `read_files` 整读/行读统一归一化到 LF 并回报 `newline`（CRLF/LF），修复 CRLF 文件在 `edit_files` 匹配失败的问题。
  - `edit_files` 写回**保留原换行 + 原 UTF-8 BOM**，新增 encode→decode round-trip 守卫（往 GBK 插入不可表示字符时拒写，防止损坏），改为原子写（临时文件 + rename）。

### 变更
- 审计日志页 6 列改版：操作（中文名）/参数摘要/来源 IP/耗时/状态，新增搜索与导出。
- 连接页启用服务按钮改造：高对比配色 + loading 态 + 错误提示；运行时间显示到秒（平滑跳秒）。
- 审计后端补全：记录 `source_ip`、失败调用参数、`duration_ms`。
- 删除 v1.0.0 遗留的 Node.js `server/`（sidecar 实现，纯 Rust 架构下运行时无用）；CI 由 `server` 测试改为 `desktop` 的 `cargo test`。

## [2.2.0] - 2026

### 新增
- 能力对齐 native Claude Code 文件层，工具数 9 → 12：
  - `edit_files`：精准字符串替换（唯一匹配 / `replaceAll`，保留原文件编码）。
  - `create_directory`、`remove_directory`。
- `read_files` 编码自适应：自动探测 UTF-8/GBK/GB18030/UTF-16 统一转 UTF-8，可用 `encoding` 强制指定，解决 GBK（如 NC65）源码读不了的问题。

### 变更
- 三个写工具纳入只读模式门控。
- 引入 `encoding_rs`。

## [2.1.0] - 2026

### 新增
- 界面美化升级：靛蓝主色、Hero 玻璃指标卡、segmented pill Tab、图标 chip。
- MCP 服务停止/启动按钮（顶栏 + Hero 卡，UI 联动置灰）。
- 设置页「功能开关」卡：路径白名单校验 / 只读模式 / 审计日志 / 写操作自动备份 / 限流保护（关闭白名单需二次确认 + 常驻警示条 + 顶栏徽章）。
- 连接页 IP/模式选中态强化 + 项目级默认 + health 命令复制。
- 日志页清空日志。

### 变更
- 白名单显示去除 `\\?\` 前缀。

## [2.0.0] - 2026

### 变更
- 纯 Rust 重写，去掉 Node.js sidecar（88MB → 14MB），安装包 25MB → 3.4MB。
- shadcn/ui 风格 4-Tab 界面（连接 / 安全 / 设置 / 日志）。

### 新增
- MCP scope 选择、开机自启、审计日志保留策略、安全项即时保存。

## [1.0.0] - 2026

- Node.js SEA + Tauri sidecar 方案（首个版本）。

[2.2.1]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.2.1
[2.2.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.2.0
[2.1.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.1.0
[2.0.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.0.0
[1.0.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v1.0.0
