# Changelog

本项目所有重要变更记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.3.6] - 2026-07-17

### 用户摘要
本次大幅提升命令执行灵活性、可靠性，以及托盘便利性。你现在可以在设置页选择 Git Bash 作为命令执行壳层——远端 Claude Code 连接时会自动感知、生成 POSIX 风格的命令（如 `rm`/`cp`/`grep`），像在真实 Linux 终端里操作你的 Windows 文件；即使你本机没装 Git for Windows，切换到 bash 也会被前端直接拦截并提示，不用等到执行时才报错。托盘菜单新增「复制 IP 替换命令」项——网络变动后点一下即可拿到 sed 命令去远端更新 IP，不用再去连接页操作。同时修复了托盘「复制连接命令」在窗口隐藏时失败的问题（现在不再依赖浏览器焦点，直接系统级写剪贴板 + 通知反馈），以及之前 read_files 会把 PNG/EXE/.pyc 等二进制文件误判为文本返回乱码的隐藏 bug。

### 新增
- **bash 命令执行壳层支持**：设置页新增加「命令执行壳层」分段控件（cmd / bash），选择 bash 后命令通过 Git Bash 执行（支持 POSIX 路径与语法如 `rm`/`cp`/`grep`/`sed`）。
  - 远端感知：`tools/list` 按当前壳层动态生成 run_command 工具描述（bash 下提示用 POSIX 路径/语法、`$HOME`、`/tmp` 等），重连/新会话即生效。
  - 返回回声：每次 `run_command` 返回额外 `shell` 字段（`"cmd"` 或 `"bash"`），已连会话无需重连，从工具返回中即可获知当前壳层并自行纠正命令语法。
  - bash 探测定时生效：Git for Windows 安装后无需重启服务端，下一次调用即刻检测到（`OnceLock` 改 `Mutex`，未命中时重探）。
- **bash 不可用前端拦截**：本机未安装 Git for Windows 时，设置页 bash 选项置灰 + 灰字提示，点击不保存并弹 toast，不用等到实际执行命令时才知道 bash 不可用。
- **托盘新增「复制 IP 替换命令」**：生成 sed 命令（`sed -i 's#http://[0-9.]*:{port}/mcp#http://{新IP}:{port}/mcp#g' ~/.claude.json`），与连接页 `IpChangedBanner` 命令形式一致，Rust 端直接写系统剪贴板 + 通知反馈。

### 修复
- **托盘「复制连接命令」不再依赖 webview 焦点**：原实现走「Rust emit 事件 → 前端复制」通道，窗口隐藏/失焦时前端 `writeText` 调用必失败 → 弹「复制失败，请手工复制」。改为 Rust 端直接用 `tauri-plugin-clipboard-manager` 写系统剪贴板 + 系统通知反馈，彻底绕开 webview 依赖。
- **`read_files` 二进制文件防乱码守卫**：新增 `is_binary_content` 函数（NUL 字节 / 非打印控制字符占比 >10% → 判二进制），在 `read_text` 之前先拦截 PNG/EXE/`.pyc` 等二进制文件，避免被 GBK/GB18030 误判为可解码文本并返回满屏乱码污染远程 CC 上下文。

### 变更
- **`edit_files` 匹配失败时给出空白告警**：`old_string` 未匹配到时检测首尾是否多带空白字符（空格/制表符/换行，模型常见失误），命中返回 `warning` 字段提示。
- MCP `initialize` 握手文案新增提示：建议连接后第一步调用 `list_allowed_roots`，让远程 Claude Code 无需再手动 read_files 获取项目规则。

## [2.3.4] - 2026-07-16

### 用户摘要
本次重点提升界面动效质感与更新交互体验。弹窗关闭、Tab 切换、列表增删现在都有顺滑的过渡与动画（关闭不再硬消失）；按钮点击有水波纹反馈、连接页指标数字平滑滚动；并对系统「减弱动效」设置做自动降级——开启后动画自动关闭，照顾对动效敏感的用户。更新提示更贴心：点「稍后」后本版本不再自动弹框，有新版本仍会提醒你；同时修复了窄屏下网络设置按钮文字竖排的问题。

### 优化
- 引入轻量动画库（gzip 约 3.5KB，不触碰安装包体积红线）并抽离统一弹窗原语，更新说明 / 版本历史 / 目录浏览 / 通用对话框 / 确认框共 5 处弹窗关闭时带退场动画，不再硬消失。
- Tab 切换由硬切改为交叉淡入（右侧滑入 + 淡入），切换更顺滑。
- 安全页白名单列表、日志页审计表格的增删与重排接入 FLIP 动画，增删项平滑入退场。
- 按钮新增点击水波纹反馈与 refined hover/active 反馈；Toast 补充退场动画；连接页 Hero 指标数字改为平滑滚动（count-up）。
- 全局「减弱动效」守卫：系统开启该设置时自动关闭动画与特效（弹窗退场、列表动画、水波纹、数字滚动、连接页画布特效均降级），无障碍友好。
- 全局样式新增弹性与缓出缓动 token，统一动效曲线。

### 修复
- 修复设置页「网络」卡片在窄屏下「保存」按钮与「无更改」提示中文逐字换行竖排的问题。

### 新增
- 更新交互优化：点「更新」且有可用更新时弹框查看详情；点「稍后更新」后本版本不再自动弹框（按版本号记忆，版本变化自动解除抑制），始终保留手动入口。

## [2.3.3] - 2026-07-16

### 用户摘要
本次为 UI 设计语言统一与表层润色的收尾版本：统一全局过渡与微交互反馈、抽离分隔线语义类、收敛空状态交互（保留日志/命令面板的引导式空状态，去掉白名单与后台命令的原生空状态以贴合既有交互）。同时随本次发布落地 P0/P1 的安全加固与多项交互修复。

### 优化
- 微交互统一：在 `@theme inline` 集中定义全局默认过渡（150ms cubic-bezier），新增 `.interactive` 语义类（颜色/背景/边框/阴影/缩放过渡 + 按压 `scale(0.98)`），按钮系统统一 `active:scale-[0.98]` 按压反馈。
- 新增 `ui/Spinner.tsx` 统一加载指示（替换各处内联 spinner 文本/图标），`UpdateBadge`/`VersionHistoryModal` 的“加载中”改用统一组件。
- 分隔线规范：新增 `.divider-x` / `.divider-x-top` / `.divider-y` 语义类（值指向 `hsl(var(--border))` 随主题切换、末条自动去边框），收口 9 处重复的单面分隔线（SettingsRow / AuditPager / OnboardingGuide / VersionHistoryModal×3 / AboutGroup×3），零视觉变化。
- 空状态收敛：仅保留日志页与命令面板的引导式空状态（`ui/EmptyState.tsx`）；白名单为空与“运行中后台命令”恢复为 P2 前交互（无命令时整卡不显示，贴合原有体验）。

### 安全
- `edit_files` 之前无论 `encoding_detect_enabled`（默认关）怎么设都无条件自动探测编码，与 `read_files`（关时强制 UTF-8）不一致，导致同一文件在两个工具里可能解码出不同内容。现 `edit_files` 与 `read_files` 保持同样的判断逻辑。
- `encoding::read_text` 之前用 `_had_errors` 丢弃了解码错误标志：当文件既非合法 UTF-8、也无法被 GBK/GB18030 无损解码时，会静默用 U+FFFD 替换无法解码的字节并返回成功，后续 `edit_files`/`notebook_edit` 写回时会把这些替换字符永久烤进文件。现改为直接返回错误，与同模块写方向已有的“编码有损拒绝写入”原则保持一致。
- `security/path.rs` 新建路径分支新增显式拒绝 remainder 中的 `..`/`.` 组件（`contains_dotdot`），不再依赖 Windows `\\?\` 前缀的实现细节副作用挡住路径穿越。
- `auth::verify_token` 改为完全常量时间比较，消除长度侧信道。
- 4 个后台周期任务（路径锁/cwd 会话回收、本机地址变化检测、后台命令定时清理、防火墙缓存刷新）加 panic 自愈重启，不再因一次未捕获的 panic 永久静默停止。
- 安全页/连接页新增传输安全提醒：默认监听 0.0.0.0 + 明文 HTTP 需配合 VPN/受信任内网使用（README 同步说明）。

### 修复
- 安全页“查看备份目录”按钮（`reveal_backup_dir`）点击时会一闪而过弹出黑色 cmd 窗口：它用 `cmd /c start` 拉起资源管理器，但漏加了 `CREATE_NO_WINDOW`（同目录下的 `reveal_install_dir` 之前已改用 `reveal_item_in_dir` 修过同类闪窗问题，但后来新增的 `reveal_backup_dir` 没跟着修；`run_command.rs`/`firewall.rs` 里的 `CREATE_NO_WINDOW` 修复也没覆盖到这里）。现对齐 `firewall.rs` 的同款写法加上 `creation_flags(CREATE_NO_WINDOW)`。
- 命令面板（Ctrl+K）重新生成 Token/清空审计日志之前打字+回车即执行，现走与正常页面一致的二次确认。
- 导入配置选中文件后立即覆盖全部安全设置并重启服务，现先弹确认框展示将覆盖的范围。
- 安全页白名单目录删除、多处添加目录失败无提示等交互细节问题。
- 多处（ConnectTab/CommandPalette/TokenManager/onboarding 等 9 处）剪贴板复制未 await/catch 导致的“显示已复制但其实没复制”假阳性反馈，新增统一入口 `lib/utils.ts::copyText()`。

### 新增
- 日志页新增“导出诊断报告”，基于当前筛选拼版本/性能摘要/按工具耗时/错误列表的 Markdown，下载为 `.md` 同时复制到剪贴板。
- `ErrorBoundary` 新增“完全刷新”按钮作为“重新加载”的最后手段。

### 重构
- 新增 `ui/ConfirmDialog.tsx` 统一确认弹窗，替换 6 处重复/内联弹窗实现。
- 修复 `ConnectTab.tsx` 拆分后的 5 个子文件（`connect/` 目录）缺少一层相对导入路径导致的编译错误；`LogTab.tsx` 新拆出 `LogDetailPanel.tsx`；`SecurityTab.tsx` 确认已拆分为 `RunningCommandsCard`/`FileControlCard`。
- `cleanup_finished_commands`/`evict_finished_commands` 从 Tauri 命令层收拢为 `AppState` 方法，消除反向依赖；删除 `db.rs` 重复的 `generate_token`。

## [2.3.2] - 2026-07-16

### 用户摘要

本次更新重点提升「检查更新 / 下载安装」的稳定性和反馈清晰度，并修复了备份版本历史里的几个交互问题。

**更新更稳更快**
- 国内更新更稳：下载安装包时改为「Gitee 镜像优先，失败自动回退到 ghproxy / GitHub」，大幅减少下载卡住、中断或极慢的情况。
- 下载速度可见：更新过程中新增实时速度显示（如「2.3 MB/s」），进度更直观。

**修复：更新相关**
- 修复下载进度条一直卡在 0% 的问题，现在能正确显示下载百分比。
- 修复点击「检查更新」后没有任何反应的问题：若已是最新版本，现在会正常提示「已是最新」。
- 修复性能面板中「额外开销」一项始终为空的问题，耗时数据现在完整准确。

**修复：备份与版本历史**
- 修复在版本历史弹框里点击「还原」时，确认框被遮挡、看不到也点不到的问题。
- 修复企业级深层文件夹的备份，在版本历史里「还原 / 查看改动」按钮仍为灰色、无法使用的问题——现在能正确定位并还原。

### 新增
- 版本历史弹框（`VersionHistoryModal.tsx`）交互友好化，先出 HTML 设计稿确认后落地：
  - **diff 默认“仅看变更”**（核心改动）：「看改了什么」/「与上一版比」之前把未改动的 context 行和变更行平铺展示，文件稍大时很难找到真正改了哪里。新增 "仅看变更/完整上下文" 切换（默认仅看变更），连续未变更行折叠成可点击的“…还有 N 行未变更…”分隔条（变更行前后各留 2 行上下文），加行号（前端根据 kind 序列自己推算，后端无需改动）+复制按钮。
  - **按钮按危险程度分色**：「看改了什么」/「与上一版比」（纯查看）统一蓝色描边，不可逆的「还原」改红色描边，避免手滑点错。
  - **禁用原因内联提示**：白名单关闭/无索引记录导致按钮禁用时，除了保留 title 悬浮提示，按钮组下方新增一行小字直接说明原因，不需要 hover 才能看到。
  - **“按时间”视图补齐“与上一版比”**：之前只有「看改了什么」，现在与「按文件」视图能力对齐。
- 更新下载进度新增下载速度显示（如 "2.3 MB/s"）。Rust 侧 `download_and_install` 回调里加了 ~250ms 窗口限流计算（不是每个 chunk 都重算，避免快网速下数字跳得难看），`update:progress` 事件新增 `bytesPerSec` 字段；前端 `UpdateContext`/`UpdateBadge`/`AboutGroup` 相应接收并展示，新增 `formatBytesPerSec` 工具函数复用现有 `formatBytes`。
- 自动更新支持 Gitee 镜像优先 + 客户端自动回退，解决国内用户直连 GitHub 下载安装包不稳定/很慢的问题。根因：之前下载 URL 在 CI 构建时写死进 `updater.json` 的单个字符串（固定指向 `ghproxy.net`），没有任何运行时兜底。现在 CI（`.github/workflows/build.yml`）每次发版会额外把产物 + 专属 manifest（`updater-gitee.json`）同步到 Gitee 镜像仓库的 `releases` 分支 `latest/` 目录（固定覆盖，不按 tag 累加，避免仓库无限增长）；客户端（`commands.rs` 的 `start_update`/`check_update`）改为按候选源列表依次尝试（Gitee 优先→现有 ghproxy/GitHub 回退），任一候选检查或下载失败就换下一个，签名校验仍由 tauri-plugin-updater 内部处理、不受影响。`desktop/scripts/generate-updater-json.mjs` 新增 `UPDATER_URL_TEMPLATE`/`UPDATER_OUTPUT_FILENAME` 两个环境变量支持 Gitee 这种与 GitHub Release 拼法形状不同的镜像。
  - `GITEE_REPOSITORY` 常量已改为真实 Gitee 仓库路径 `lzul/cc-bridge`。仍需在 GitHub Actions secrets 里配置 `GITEE_TOKEN`/`GITEE_REPOSITORY`（后者值也是 `lzul/cc-bridge`）才能让 CI 的 Gitee 同步步骤生效，且需 Gitee 仓库确实已导入/镜像好。

### 修复
- `overheadMs`（日志/性能面板五维耗时拆解的其中一维）在真实运行时恒为 `None`，前端从未真正显示过这一项：`write_audit_for_call` 构造审计条目时 `audit_ms` 还未知（传 `None`）导致 `overhead_ms` 被永久算成 `None`，后面补 `server_ms`/`audit_ms` 时忘了同步重算。新增一个真实走 HTTP 全链路、回读真实 audit.log 的回归测试实测抛出此 bug。

### 优化
- `mcp/tools/registry.rs` 单测删除硬编码 `tools.len()==17` 断言，改为纯不变式校验，新增工具时无需同步改这个数字。
- 新增 `mcp::http::restart_server(state)` 收拢 4 处重复的 MCP 重启逻辑（`restart_mcp_server`/`start_mcp_server`/`import_config`/托盘菜单）。
- `batch` 工具描述补充 non-transactional 说明，避免远程调用方误判部分失败会回滚。
- CLAUDE.md 规则 7 同步更新为实际的注册表 register_tool! 流程，并同步更新相关 RFC 的状态字段。

- 版本历史弹框里点击“还原”弹出的确认框被压在弹框下面（看不到/点不到）：`RestoreBackupDialog` 用的是普通弹框级别的 `z-50`，而 `VersionHistoryModal` 自身是 `z-[1000]`，从它里打开时确认框被压在下面。改为 `z-[1001]`，高于父弹框。前端只改 className，HMR 热更新即生效。
- 版本历史弹框中"看改了什么"/"还原"按钮即使白名单已开启仍为灰（对深层企业级仓库尤其明显）：旧实现靠在白名单根目录下按文件名做有边界目录遍历反查原始路径（`max_depth=6`、`max_scan=8000`），文件实际嵌套深度超过 6 层或仓库文件数超过 8000 时必然查不到。改为在创建备份时（`backup.rs`）就将原始绝对路径写入新增的 `backup_index` 表（`db.rs`），`list_backups` 改为直接查表精确还原，不再依赖有界目录遍历。删除了旧的 `build_targets_map`/`walk_collect_targets`。现有备份（该表上线前创建）无索引记录，仍会显示为无法定位，需重新产生备份才能用新机制。
- 更新下载进度条一直显示 0%：`commands.rs` 下载回调误把 `tauri-plugin-updater` 给的“本次分片字节数”当成了“累计已下载字节数”直接 emit 给前端，前端每次用单个分片大小除以总大小算百分比，结果永远接近 0。改为在 Rust 侧用 `downloaded_total` 累加分片字节数后再 emit，前端逻辑无需改动。
- 点击「检查更新」后无提示、无报错（静默回到原样）：前端 `UpdateContext` 的 `update:uptodate` 监听器错误地把状态直接重置为 `idle`，跳过了「已是最新」状态，导致「已是最新」pill 与 toast 永不触发。改为进入 `uptodate` 状态并启用已声明的 `uptodateTimerRef`（4 秒后自动回 `idle`），恢复正确的反馈。

## [2.3.1] - 2026-07-15

### 用户摘要

新增备份版本历史功能，可查看文件改动、对比版本差异、一键还原到任意历史版本。防火墙状态检测更智能，不再因系统环境问题误弹错误框。

### 新增
- 备份浏览器（版本历史弹框）：设置页备份段新增「版本历史」入口，居中大弹框按原文件分组展示版本时间线；支持「看改了什么」(`get_file_diff`，白名单关闭时禁用)、「与上一版比」(`diff_backups` 相邻版对比)、「还原」(复用 RestoreBackupDialog)；含检索 / 排序 / 文件索引跳转 / 按文件·按时间视图切换 / 展开全部。后端新增 `diff_backups` 命令（两 .bak 互比，双重白名单校验）。
- 防火墙 netsh 可用性探测：启动一次性探测 `netsh` 是否可用，损坏时停用防火墙查询并改为连接页温和提示，避免反复弹出系统错误框。

### 变更
- IP 变化弹窗作用域改为跟随连接页「项目级 / 全局模式」选择卡实时联动（复用现有控件），只给单一精确命令，去掉旧数据的两条兜底。
- 打开安装目录改用 `tauri-plugin-opener` 的 `reveal_item_in_dir`（不再闪 cmd 窗口）；创建桌面快捷方式给 powershell 加 `-WindowStyle Hidden`（不再闪窗口）。
- 安全页「备份份数 / 请求限制」图标去渐变背景，统一为单色 lucide 图标，与白名单等图标风格一致。
- `Status` 新增 `firewallAvailable` 字段，供前端判断并显示防火墙探测不可用提示。

### 修复
- 防火墙查询触发 `netsh.exe` 崩溃(0xc0000142)时反复弹出系统错误框：子进程创建时 `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)` 抑制硬错误弹窗，且 netsh 命令与提权 powershell 均加 `CREATE_NO_WINDOW`；启动探测到 netsh 不可用后停用后续查询。

## [2.3.0] - 2026-07-15

### 用户摘要

权限自动授权一键配置，AI 调用不再每次弹窗确认。后台命令支持自动清理和智能排队，不再因旧命令占位而拒绝新任务。新增 Windows 防火墙可视化管理，一键开放端口。运行面板更紧凑、信息密度更高。

### 新增
- 连接页新增"权限自动授权"区块（`ConnectTab.tsx`，紧跟在 `TokenManager` 之后）：一键复制命令往 Claude Code 的 `permissions.allow` 追加 cc-bridge 工具规则 + 信任该 MCP 服务器，免去每次调用都弹窗确认（无需重启会话，改完立即生效）。
- 新增 `buildPermissionGrantCommand`（`lib/utils.ts`）：默认逐个列出 14 个文件/列表类工具规则，`run_command`/`get_command_output`/`stop_command` 三个命令执行工具需手动打开开关才会带上（改成单条 `mcp__cc-bridge__*` 通配符，同时自动覆盖未来新增工具），开关打开时显示红色警示条。
- 权限命令用 `python3` 读-改-写，幂等去重，不依赖 `jq`（不保证所有用户环境已安装）；目标文件固定落 `settings.local.json`（项目级，不进 git）/`settings.json`（全局），与连接命令用的 `.mcp.json` 区分开——权限规则属个人本地免打扰设置，不适合和团队共享的 MCP 服务器配置混在一起。
- 项目级且路径未填写时显示警告：命令不带 `cd` 前缀会直接用执行时终端所在目录拼相对路径，若不在目标目录下执行会悄悄写到错误位置且不报错，故加了明显警示文案。
- `formatDurationMs`（`lib/utils.ts`）：毫秒耗时自动换算中文单位（微秒/毫秒/秒/分），避免用户看到 10000ms 这类大数字还要心算，应用到 `LogTab.tsx`/`PerfCharts.tsx` 全部耗时展示点，删除 `PerfCharts.tsx` 重复的局部 `fmt()`。
- 安全页"运行中的后台命令"卡片新增状态徽章（`CommandStatusBadge`：运行中/已结束/失败 + 退出码），避免处于 5 分钟清理宽限期内的已结束命令被误以为还在跑，卡片标题下加一行说明文字。
- 后台命令定时自动清理（`commands::cleanup_finished_commands`，`main.rs` 每 60s 调一次）：已结束满 5 分钟宽限期（供查看最终输出）后自动从 `running_commands` 注册表移除。
- 后台命令数命中 5 个并发上限时优先腾位（`commands::evict_finished_commands`）：不等 5 分钟宽限期，先尝试把已结束的命令立即移除为新命令腾空位，真正 5 个都还在跑时才拒绝，不再需要用户手动 `stop_command` 才能重试。
- 运行卡双栏布局优化（方案B）：状态行 → 双栏（左概览卡 + 右 2×3 网格）→ 底部治理+控制，5 层结构压缩到 3 层，高度 ~375→275px。
- 停止服务按钮质感优化（去硬边框改 box-shadow 三层叠加 + backdrop-blur 增强）+ 卡片底部分隔线由 border-t 实线改为两端渐隐渐变线。
- 数据雨负载联动（ConnectHero）：rpm 越高雨越密越快，空闲稀疏慢速呼吸。
- 防火墙落地：新增 firewall.rs（Windows netsh 规则级查询 + UAC 提权开放端口）、state.rs FirewallCache 后台刷新、commands.rs refresh_firewall/open_firewall_port；ConnectTab 新增防火墙告警块（一键开放/重新检查/手动 netsh）。
- 更新下载进度条可视化：Header 进度环 + 关于卡片进度胶囊。
- 安装目录查看与桌面快捷方式重建：设置页新增「安装与快捷方式」卡片（展示安装位置 + 打开目录 + 创建桌面快捷方式）；commands.rs 新增 install_dir / reveal_install_dir / create_desktop_shortcut。
- 更新内容展示增强：Header 更新徽章可点击展开详情、关于卡片展开态内联「本次更新内容」、新增 UpdateNotesDialog 弹窗、ReleaseNotes 中文标签徽章（新功能/修复/变更/重构/文档）。

### 变更
- 运行卡方案A压缩：padding/gap/font-size 缩减，高度 ~448→375px，保留全部指标。
- 累积性能优化、UI 体验增强与文档更新。

### 修复
- **执行命令时一闪而过的空白 cmd 黑窗**：`spawn_shell` 之前只设置了 stdout/stderr 为 `Stdio::piped()`，没显式设置 stdin。cc-bridge 本身是 GUI 子系统程序没有控制台，子进程默认继承到的 stdin 句柄无效，`cmd.exe` 拿到无效句柄后会尝试自己申请控制台兼底，瞬时击穿 `CREATE_NO_WINDOW` 的抑制效果。现显式 `c.stdin(Stdio::null())`，不再给 cmd.exe 理由自己申请控制台。
- 安全页"运行中的后台命令"卡片"已运行"一直增长：`elapsed_seconds` 之前恒用 `started_at.elapsed()` 实时计算，即使进程早已退出（v1 不自动回收注册表条目）仍会随面板轮询一直长。`RunningCommand` 新增 `finished_elapsed_secs` 字段，由 wait 线程与 `exit_code` 同时定格，面板优先用定格值。
- **O1 耗时拆解面板长期缺失两项维度**：`auditMs`/`overheadMs` 之前用整数毫秒存储，实测典型值在微秒级（~6.8µs）会恒截断为 0，被前端 `filter(s.ms > 0)` 过滤隐藏。后端 `audit.rs`/`http.rs` 改用 `f64` 保留小数精度，两项现在能正常显示。
- `batch` 子操作审计记录之前全部传 `None`，导致日志列表里 `batch` 相关行的耗时列一律显示"—"。`batch.rs` 现在为每个子操作单独计时。
- 安全页"运行中的后台命令"卡片：操作列固定宽度 `w-[160px]` 小于两个按钮（查看输出/收起 + 终止）实际宽度，导致换行。加宽到 `w-[210px]`，并加 `whitespace-nowrap` 防止文字换行。
- `buildConnectCommand`（连接页"项目级"接入命令）缺失 `--scope project` 参数：之前项目级分支不加任何 `--scope`，而 Claude Code CLI 不带 `--scope` 时默认是 `local` scope（写入 `~/.claude.json` 按项目路径存的部分），与连接页文案宣称的 `.mcp.json` 不符。导致地址变化 `IpChangedBanner` 与 Token 重生成 `TokenManager` 生成的 sed 命令（均假设 project scope = `.mcp.json`）在项目级场景下实际改不到真正生效的配置文件，表现为"复制 sed 命令执行后不生效/地址仍不对"。现显式加 `--scope project`，与 sed 命令生成逻辑的假设保持一致。
- 安装目录打开「显示成功但不弹窗」：`reveal_install_dir` 改用 ShellExecute 直接打开目录，规避 explorer 单实例 DDE 转发导致不弹窗的怪癖。
- 桌面快捷方式创建失败：`create_desktop_shortcut` 桌面路径改取 `USERPROFILE\Desktop` 优先，不再依赖易解析失败的 `app.path().desktop_dir()`。

## [2.2.23] - 2026-07-12

### 用户摘要

MCP 后端重构，新增工具更可靠、零样板代码。关于页更新历史自动同步，不再出现「版本落后好几个月」。连接页操作引导更清晰。

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

### 用户摘要

全新视觉风格升级（PastePanda 风格）。白名单扩展名可按前端/后端/配置/文档等类别一键勾选，配置更快。托盘图标新增运行状态指示（绿点/灰点）。Header 点击版本号即可检查更新。

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

### 用户摘要

AI 可直接编辑 .ipynb Notebook 文件（按单元格替换/插入/删除）。文件搜索支持上下文行、行号、大小写不敏感等高级选项，大项目中找内容更精准。

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

### 用户摘要

后台命令终止更可靠，子进程/孙进程均不再残留。

### 亮点
- 后台命令管控更稳，连接不再卡在残留进程上

### 变更
- 后台命令整树终止改用社区成熟方案（process-wrap），替代手写的 Windows 进程管理，跨平台更可靠。
- 修复「先启动子进程再挂入进程组」之间的竞态窗口，孙进程不再漏杀。
- 终止语义明确：显式杀整棵树，避免留下残留进程。

### 技术
- 移除自写的进程管理代码，依赖更精简；`cargo test` 41 全绿、零警告。

## [2.2.15] - 2026-07-10

### 用户摘要

新增危险命令拦截（如 rm -rf /、格式化磁盘等），防止 AI 误操作破坏你的机器。

### 新增
- 命令执行增加危险命令拦截：开启命令执行后，`rm -rf /`、格式化磁盘、fork bomb 等毁灭性命令会在执行前被直接拒绝，保护你的机器。

### 说明
- 当前为启发式拦截（最低成本兜底），误伤与漏拦并存，后续会升级为更严谨的沙箱。

## [2.2.14] - 2026-07-10

### 用户摘要

修复 git、cargo 等真实程序执行后读不到输出的问题，命令输出现在能正确捕获。

### 修复
- 根治真实程序（如 git.exe / cargo.exe）执行后读不到输出的问题：改用标准管道直接启动，命令输出现在能正确捕获、标准错误也不再恒为空。
- 修好测试套件会误杀自身的问题，约半数用例之前从未真正运行。

### 变更
- 移除不可用的终端模拟方案，依赖更干净。

## [2.2.13] - 2026-07-10

### 用户摘要

后台命令终止更彻底（子/孙进程均不漏杀）。跨目录文件搜索更好用（自动跳过 node_modules 等）。写文件后可直接预览 AI 做的改动（diff 对比）。

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

### 用户摘要

首次使用引导、键盘快捷键（Ctrl+K 命令面板）、托盘图标运行状态指示、日志搜索与导出（JSON/CSV）、主题切换平滑过渡——全面体验升级。

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

### 用户摘要

累积 UI 升级：新靛蓝主题色、玻璃质感指标卡、统一消息提示组件。

### 变更
- v2.2.2 → v2.2.6 release 期间累积改动合并提交：
  - 后端：注册 `start_update` 等 Tauri command、补 `tauri-plugin-updater` / `tauri-plugin-notification` / `tauri-plugin-process` 依赖，`main.rs` 调整启动流程。
  - 前端设计系统升级：靛蓝主题色、玻璃指标卡、segmented pill Tab、`TitleBarControls` 自绘标题栏、`Toast` 统一反馈组件、`index.css` +220 行新样式变量。
  - `UpdateContext` 抽出更新状态层；`Header` 拆 `UpdateBadge`；多个 tab 卡片样式更新。
- 图标套件重新生成（18 个 png/ico 体积变化）。

## [2.2.6] - 2026-07-09

### 用户摘要

新增绿色便携版 zip 包，解压即用无需安装，方便 U 盘随身携带或无管理员权限环境使用。

### 新增
- Release 副产物：绿色便携版 zip（`cc-bridge_<version>_x86_64-pc-windows-msvc.zip`），解压即用不需安装，方便 U 盘随身 / 无管理员权限环境。CI 参考 PastePanda 方案新增 `📦 打包绿色便携版` step，自动随 tag 发布到 GitHub Release。

### 修复
- 同步 `Cargo.lock` 中 v2.2.5 版本号（之前 2.2.5 release 时 sync-version 触发了 lock 重生但未提交）。

## [2.2.5] - 2026-07-09

### 用户摘要

修复自动更新权限问题，确保检查和下载更新功能正常可用。

### 修复
- 自动更新 ACL 权限：`capabilities/default.json` 缺 `updater:default` 和 `process:default`，导致前端 `check()` 调用报 `Command plugin:updater|check not allowed by ACL`。补齐后 `check()` / `downloadAndInstall` / `relaunch` 全部放行。

## [2.2.4] - 2026-07-09

### 用户摘要

安装包体积缩减约 25%（19.5MB → 约 14MB）。代码推送前自动运行质量检查，杜绝带病发布。

### 变更
- Release 体积优化：`Cargo.toml` 加 `[profile.release]` 配置（`codegen-units=1` + `lto="thin"` + `opt-level="s"` + `strip="symbols"`），预计 exe 体积从 19.5MB 降至 14-15MB。
- Header 组件拆分：把 `useUpdate` 调用与两个更新状态徽章抽到独立组件 `UpdateBadge.tsx`，降低 Header 复杂度，遵守 300 行组件上限。

### 新增
- 仓库级 git hook：`.githooks/pre-push` push 前自动运行 `tsc --noEmit` + `cargo test`，杜绝带病 push。

## [2.2.3] - 2026-07-09

### 用户摘要

持续集成构建速度大幅提升（依赖缓存，10+ 分钟 → 2-4 分钟），新版本发布更快。

### 变更
- CI 优化：`Swatinem/rust-cache@v2` 接入（缓存 `desktop/src-tauri` 依赖），依赖未变时构建耗时从 10+ 分钟降至 2-4 分钟。
- CI 升级：Node 20 → 22（Node 20 已 EOL，消除 GitHub Actions Node 弃用警告）。

## [2.2.2] - 2026-07-09

### 用户摘要

AI 现在可以执行 Shell 命令（可选开关控制）。应用内自动更新上线：启动和每 24 小时自动检查，下载进度实时可见，静默安装。AI 连接后自动获取项目规则文件，上手更快。

### 新增
- 命令执行 MCP 工具：`run_command`（后台执行 shell 命令）/ `stop_command`（终止）/ `get_command_output`（拉取输出）。
- 应用内自动更新：启动时 + 每 24 小时检查，指数退避重试，通过 Tauri event 实时推送下载进度；采用 Tauri v2 静态 `updater.json` 方案（指向 GitHub Release latest），下载后 minisign 验签再静默安装。
- `list_allowed_roots` 自动内嵌各根目录顶层 `CLAUDE.md` 到 `projectInstructions`（超过 20KB 仅给路径提示），远程 Claude Code 连接后一步即可拿到项目规则。

### 修复
- CI 构建显式设置空签名密码，避免无 TTY 环境下 Tauri 交互式密码提示卡死。

## [2.2.1] - 2026-07-08

### 用户摘要

中文编码文件（如 GBK/GB18030）现在可正常读写。文件的换行格式（CRLF/LF）和 BOM 头会被原样保留，不会因编辑而损坏。审计日志支持搜索和导出，方便追溯 AI 做了什么。

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

### 用户摘要

新增精准文件编辑（指定原文本→替换为新文本）、创建/删除目录。中文编码文件（如 NC65 企业软件源码 GBK 编码）现在可自动识别并正常读取。

### 新增
- 能力对齐 native Claude Code 文件层，工具数 9 → 12：
  - `edit_files`：精准字符串替换（唯一匹配 / `replaceAll`，保留原文件编码）。
  - `create_directory`、`remove_directory`。
- `read_files` 编码自适应：自动探测 UTF-8/GBK/GB18030/UTF-16 统一转 UTF-8，可用 `encoding` 强制指定，解决 GBK（如 NC65）源码读不了的问题。

### 变更
- 三个写工具纳入只读模式门控。
- 引入 `encoding_rs`。

## [2.1.0] - 2026

### 用户摘要

全新视觉升级（靛蓝主色、玻璃质感卡片）。安全功能开关集中管理：白名单校验、只读模式、审计日志、自动备份、限流保护——一键控制，关闭关键安全项有二次确认和常驻警示。

### 新增
- 界面美化升级：靛蓝主色、Hero 玻璃指标卡、segmented pill Tab、图标 chip。
- MCP 服务停止/启动按钮（顶栏 + Hero 卡，UI 联动置灰）。
- 设置页「功能开关」卡：路径白名单校验 / 只读模式 / 审计日志 / 写操作自动备份 / 限流保护（关闭白名单需二次确认 + 常驻警示条 + 顶栏徽章）。
- 连接页 IP/模式选中态强化 + 项目级默认 + health 命令复制。
- 日志页清空日志。

### 变更
- 白名单显示去除 `\\?\` 前缀。

## [2.0.0] - 2026

### 用户摘要

完全重写！安装包从 25MB 缩小到 3.4MB，去掉 Node.js 依赖，启动更快、资源占用更低。全新 4 标签页界面：连接、安全、设置、日志。

### 变更
- 纯 Rust 重写，去掉 Node.js sidecar（88MB → 14MB），安装包 25MB → 3.4MB。
- shadcn/ui 风格 4-Tab 界面（连接 / 安全 / 设置 / 日志）。

### 新增
- MCP scope 选择、开机自启、审计日志保留策略、安全项即时保存。

## [1.0.0] - 2026

### 用户摘要

首个版本：本地 MCP 文件桥接，让 AI 安全读写你的文件，全程不经过云端。

- Node.js SEA + Tauri sidecar 方案（首个版本）。

[2.2.1]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.2.1
[2.2.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.2.0
[2.1.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.1.0
[2.0.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v2.0.0
[1.0.0]: https://github.com/lzlkyb/cc-bridge/releases/tag/v1.0.0
