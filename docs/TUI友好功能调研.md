# 终端 TUI 用户友好功能调研（cc-bridge）

> 2026-10-12 · 调研目的：在已落地的「TUI 虚拟滚动条」之后，还有哪些对用户友好、方便操作的终端功能值得做。
> 方法：对标 iTerm2 / Ghostty 1.3 / WezTerm / Warp / VS Code / Zeron 的公开特性与 issue 反馈，结合 cc-bridge 现状与 xterm.js 6 生态评估可行性。

## 一、cc-bridge 现状盘点

已有：拖选复制（含鼠标报告态修复）/ 粘贴（bracketed paste）/ 滚动条搜索 / 字号调节 / OSC 7+133+1337 状态栏（cwd、git 分支、退出码）/ OSC 133 注入钩子 / TUI 态虚拟滚动条（拖动→wheel 转发）/ 统一通知系统（Toast + InlineNotice + ActionCard）/ 多标签 / 软件内全屏 / 断线保留终端内容。

## 二、业界趋势要点（调研来源）

- **Claude Code 2.1.172+ 默认 fullscreen 渲染器**是最大变量：备用屏 + 鼠标捕获，滚动/选择/复制是与其它 CLI 工具差异最大的痛点区（官方 issue #66601、#21386、#83487 等）。终端侧的标准救急手段是 **Shift+滚轮强制滚本地 scrollback**（Zeron #361 验收标准、WezTerm/iTerm2 通行做法）。
- **Ghostty 1.3（2026-03）** 新增：scrollback 搜索、原生滚动条、**click-to-move-cursor（点击移动光标）**、**命令完成通知**、key tables。
- **OSC 协议成为 TUI 友好性的主战场**（terminfo.dev 统计平均采用率 78%）：
  - `OSC 9;4` 进度条（ConEmu 起，Ghostty/Windows Terminal/WezTerm/Konsole 均支持；**@xterm/addon-progress 官方插件**，周下载 11 万）；
  - `OSC 9 / 777 / 99` 桌面通知；
  - `OSC 8` 超链接（xterm.js 5.0 起核心原生解析；`ls --hyperlink`、cargo、GCC、ripgrep 等大量工具已输出）；
  - `OSC 0/2` 标题（程序名）；
  - `OSC 133` 语义提示符标记（VS Code 命令装饰、iTerm2 命令历史导航、Ghostty 按提示符滚动的数据基础）。
- **WezTerm** 通行交互基线：Shift+PgUp/PgDn 滚回看、Shift+Insert 粘贴选区、滚轮在鼠标报告态仍可被修饰键劫持回本地。
- **VS Code** 独有：type-ahead（SSH 高延迟下本地回显）、命令导航装饰。

## 三、机会清单（按性价比分档）

### P0 · 低成本高感知（纯前端，1-2 天/项）

| # | 功能 | 说明 | 技术路线 |
|---|------|------|----------|
| 1 | **Shift+滚轮强制滚本地 scrollback** | TUI 态救急看历史的标准行为，用户肌肉记忆 | 滚轮带 shiftKey 时跳过转发、走 `term.scrollLines`（本地） |
| 2 | **BEL 铃 → 统一通知** | Claude Code 设置 terminal_bell 后任务完成/等待输入发 BEL；vim/长命令同理。直接接入已建成的统一通知系统 | `term.onBell` → Toast/标签角标；防抖（vi 内 Esc 不轰炸） |
| 3 | **OSC 9;4 进度 → 标签页/状态栏** | 长任务（构建、claude 长操作）进度直接可见，不用盯屏幕 | `@xterm/addon-progress`（官方）→ 标签页小进度条 + 状态栏段 |
| 4 | **OSC 0/2 标题 → 标签页程序名** | 标签自动显示 `claude` / `vim` / `htop`，多标签辨识度大增 | `term.onTitleChange` → 标签文本（白名单过滤，防诈骗标题） |
| 5 | **多行粘贴确认** | 粘贴含换行的命令（尤其 root 会话）先确认，防脚本炸弹；iTerm2/Warp 标配 | onData 前检测 paste 内容含 `\n` → InlineNotice 确认（可勾选"本次会话不再问"） |

### P1 · 中成本中高感知（纯前端为主，2-4 天/项）

| # | 功能 | 说明 | 技术路线 |
|---|------|------|----------|
| 6 | **命令导航（OSC 133 数据已在手）** | 点状态栏/快捷键跳到上一条命令的输出起点；显示上一条命令耗时。VS Code 装饰、iTerm2 命令历史同源 | 已注入 133 钩子 → `registerMarker` 标记 + scrollLines 跳转 |
| 7 | **文件路径点击 → SSH 文件浏览器定位** | cc-bridge 特有优势：输出里的 `/path/to/file` 点击即跳 SFTP 浏览器该目录（他厂终端只能开本地编辑器） | 自定义 LinkProvider 正则识别绝对路径 + cwd（OSC 7 已有）消歧 |
| 8 | **智能选中增强** | 双击选中带路径/带引号/带 `-flag` 的整段；Ctrl+Shift+C 已有，配得上更好的选区 | 自定义 word separator + LinkProvider 组合 |
| 9 | **Ctrl+滚轮调字号** | 主流终端标配，与现有字号徽标复用 | wheel 事件拦 ctrlKey → useTerminalFontSize 步进 |
| 10 | **TUI 态选区保护** | 拖选进行中滚轮不丢选区（Claude Code issue 实测痛点） | 拖选态吞掉 wheel 转发、保持选区 |

### P2 · 高成本/低频（暂缓，记录在案）

| # | 功能 | 说明 | 成本 |
|---|------|------|------|
| 11 | 图片协议（iTerm2 imgcat / Sixel） | 远端图表内联显示；`@xterm/addon-image` 支持 iTerm2 协议 | 中大；渲染与体积预算压力（安装包 ≤20MB 红线） |
| 12 | serialize 会话快照恢复 | 断线重连把屏幕状态完整还原（addon-serialize） | 中；现有「断线保留终端」已覆盖 80% 场景 |
| 13 | type-ahead 本地回显 | SSH 高延迟手感质变，但需 Rust 侧 PTY 协同 | 大（Rust+前端）；VS Code 也做了一年多 |
| 14 | kitty keyboard protocol | 深水区，Claude Code 不依赖 | 大 |

### 反向清单（明确不做）

- **方向键转发滚轮**：iTerm2 默认行为已证伪（Claude Code 当成输入历史导航，issue #66601）——我们的 wheel→SGR 路线正确。
- **OSC 52 远端剪贴板**：安全面过大（远端可写本地剪贴板），需要白名单确认机制，收益低。

## 四、推荐路线

**第一批（P0 全做，约 1 周）**：①Shift+滚轮 ②BEL 通知 ③OSC 9;4 进度 ④标题→标签名 ⑤多行粘贴确认。
理由：全部是「协议透传/交互补课」类，风险低、复用已有基建（统一通知系统、状态栏、标签组件、paste 链路），且每一项都能在 Claude Code 场景立刻感知。

**第二批（P1 择 2）**：⑥命令导航（数据免费）+ ⑦路径点击跳文件浏览器（cc-bridge 差异化，别的终端做不了）。

## 五、参考

- Claude Code fullscreen 文档与 issue：code.claude.com/docs/en/fullscreen；#66601 / #21386 / #83487
- OSC 9;4 规格与采用矩阵：rockorager.dev/misc/osc-9-4-progress-bars；@xterm/addon-progress（npm）
- OSC 8 采用清单：github.com/Alhadis/OSC8-Adoption（xterm.js since 5.0.0）
- Zeron 终端 wheel 转发三分支设计与 Shift+滚轮验收标准：zeronsh/zeron#361
- Ghostty 1.3 特性 / WezTerm features / terminfo.dev OSC 矩阵
