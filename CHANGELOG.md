# Changelog

本项目所有重要变更记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
