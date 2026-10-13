# Claude Code 用户痛点调研 × cc-bridge 终端侧方案

> 调研日期：2026-10-12。来源：anthropics/claude-code GitHub issues（#79025、#53394、#16578、#60185、#826、#18170 等）、官方 terminal-config 文档、社区方案（tmux-claude-code、claude-ssh-image-skill、cc-clip、NO_FLICKER 一年时间线复盘）。
> 范围限定：**终端模拟器侧能做的**（cc-bridge 是 Tauri+xterm.js 终端），Claude Code 自身 bug 只列出并说明「我们能不能帮上」。

---

## 一、痛点全景（按社区声量排序）

| # | 痛点 | 证据 | 终端侧可否修 |
|---|------|------|:---:|
| 1 | **渲染花屏/残影**：旧帧文字透出、提示条整帧重复、mid-word 折行 | #79025（Windows Terminal 高发）、#78890、#53394；根因是 Claude 差分渲染器发 CUF 跳格不清 cells，**用户唯一自救 = 手动拖窗口 resize 触发全量重绘** | ✅ **能**（一键程序化 resize） |
| 2 | **Shift+Enter 提前提交**（想换行却发出去了） | 官方文档专页；VS Code 等 xterm.js 系要 /terminal-setup；SSH 链路更坑 | ✅ **能**（keymap 映射） |
| 3 | **SSH 下图片粘贴不通**：本地剪贴板截图无法给远端 Claude Code | 官方确认无解，社区长出一堆 daemon+反向隧道方案（cc-clip / claude-ssh-image-skill / Raycast 脚本） | ✅ **能，且是我们的王牌**（已有 SFTP 通道） |
| 4 | **完成/等待输入无提醒**（人切走干别的，Claude 停了不知道） | 官方文档整节；iTerm2 专用 OSC 9 通道 | ✅ 已覆盖（BEL）+ 可补 OSC 9 |
| 5 | **滚动问题**：滚不动对话、reading position 被劫持、scrollback 被刷爆 | #826、#1486、#60185（tmux copy mode 失效）、Zeron 把「Shift+滚轮」写进验收标准 | ✅ 已覆盖（TUI 滚动条 + Shift+滚轮） |
| 6 | **拖选复制不了 / 复制带尾随空格与缩进** | #18170 + 我们自己修过拖选 | ✅ 已覆盖拖选；**尾随空白可顺手修** |
| 7 | **ESC/输入延迟**（SSH 高延迟下打字卡顿，无本地回显） | tmux-claude-typeahead 等社区项目存在的原因 | ⚠️ Rust 侧 type-ahead，量大 |
| 8 | **长会话卡顿/内存**：Ink 渲染树膨胀、memory leak #4953 | Claude 自身问题 | ❌ |
| 9 | **状态行超宽错乱**（≤80 列时逐行打印不原地更新） | #16578（用户都聚集在窄窗口场景） | ❌（Claude 侧截断问题） |
| 10 | **tmux/多路复用器全套问题**：闪烁、escape-time 500ms、extended-keys、2000 行 history 不够 | tmux-claude-code 项目 8 条配置 | ⚠️ 我们不是 tmux，多数天然免疫 |

---

## 二、方案（P0 → P2）

### P0 · 小改动高感知（全部纯前端）

**① Shift+Enter 换行（修掉「提前提交」）**
- 现状探明：xterm.js 6 **没有** kitty 键盘协议（lib 内 0 命中），Enter 一律发 `\r`，Shift 修饰符被丢弃 → Claude Code 视为提交。
- 方案：`terminalKeymap.ts` 拦 `Shift+Enter` → 发 `"\n"`（LF）。依据：官方文档「Ctrl+J（LF）在所有终端无需配置即可换行」，LF 即官方兜底通道；且 LF 在 bash/zsh 提示符 = accept-line（与 Enter 等价），**shell 场景零副作用**。顺带 `Alt+Enter` → `"\x1b\r"`（对应官方 Option+Enter 换行）。
- 代价：约 10 行 + 单测。

**② 一键「强制重绘」（花屏自救按钮）**
- 现状：Windows 上 Claude 差分渲染残影是最高声量痛点（我们就是 Windows 应用，用户全踩中）；社区共识唯一解法 = resize 强制全量重绘。
- 方案：状态栏/工具栏加「重绘」动作：`term.resize(cols-1, rows)` → 还原 `cols`（两帧内 xterm 全量重画并重排）。再加快捷键。或者更优雅：监测到 alt buffer 态用户按 Ctrl+Shift+R 时执行。
- 代价：约 30 行。

**③ OSC 9 通知通道补齐**
- Claude Code 的 preferredNotifChannel 默认 auto 会选 iterm2（OSC 9）或 terminal_bell；我们已处理 BEL，再解析 `OSC 9;<text>` 直接 toast 通知正文（比铃信息量更大，iTerm2 用户拿到的就是这条）。
- 代价：useTerminalOsc 加一个 registerOscHandler（注意 hooks 棘轮，可能要从 8 个里挪）。

**④ 拖选复制去尾随空白**
- #18170：复制内容带尾随空格/缩进，粘进编辑器/文档很脏。我们 `useSshTerminalSelect.ts` 两处 `writeText(sel)` 前对每行 `trimEnd()`（纯前端纯函数 + 单测）。
- 代价：约 15 行。

### P1 · 差异化王牌

**⑤ 剪贴板图片 → SFTP 上传远端（业界最痛、无人做在终端里）**
- 痛点：SSH 下图片粘贴物理上不可能（剪贴板在本地，Claude 在远端）。社区方案全是「本地 daemon + SSH 反向隧道 + 远端 shim」三件套，安装成本高到要写博客教程。
- 我们的组合优势：**本地剪贴板读取（plugin-clipboard-manager，已有）+ SFTP 上传（文件浏览器现成）+ 远端 cwd 探测（OSC 7，已有）**。
- 方案：终端工具栏「粘贴图片到远端」/ Ctrl+Shift+V：读剪贴板图片 → 存 `/tmp/cc-bridge-<时间戳>.png`（经 SFTP）→ 向终端写入路径文本（插入输入行），用户回车即被 Claude Read。比 cc-clip 少 daemon、少隧道、少远端装任何东西——**这是别的终端做不到的**。
- 代价：中等（图片编码 + 上传链路复用，估计 1~2 天）。

**⑥ TUI 滚动速度可调**
- Claude 官方 `CLAUDE_CODE_SCROLL_SPEED`（1-20）是环境变量；我们自己的 TUI 虚拟滚动条目前恒 1 行/格。设置页加「TUI 滚动速度」档位（1/3/5 行），拖滚动条与 wheel 转发共用。
- 代价：小（terminalScroll.ts 加系数参数 + 设置项）。

### P2 · 记账暂缓

- **⑦ type-ahead 输入回显**：SSH 100ms+ 延迟时打字跟手（社区 tmux-claude-typeahead 同类）。需 Rust 侧本地回显缓冲，与远端回显对账，复杂度高，单独立项。
- **⑧ scrollback 容量设置**：长会话流式输出 4k-6.7k scroll 事件/秒刷爆缓冲；xterm `scrollback` 默认 1000，可加设置（大缓冲有内存代价，需要权衡上限）。
- **⑨ Claude 会话持久化/恢复标签**（对标 VS Code 的 terminal-sessions 扩展）：重开软件恢复 `claude --resume` 会话。有产品价值但涉及会话生命周期管理，单独立项。

---

## 三、已覆盖对照（本会话已上线的 P0/P1）

| 业界痛点 | cc-bridge 对应 |
|---|---|
| TUI 态滚不动/拖滚动条无效 | TUI 虚拟滚动条（wheel→SGR 转发 + 顶/底 Ctrl+Home/End） |
| 原生 scrollback 进不去 | Shift+滚轮强制滚本地 |
| 拖选复制不了 | 合成 mousedown 补建选区 |
| 完成无提醒 | BEL → toast + 标签铃点 |
| 长任务进度不可见 | OSC 9;4 标签进度条 |
| 多标签分不清哪个是 Claude | OSC 标题 →「主机 ▸ 程序名」 |
| 命令跑了多久/输出在哪 | OSC 133 耗时段 + Ctrl+Shift+↑/↓ 跳转 |
| 粘贴多行脚本炸弹 | 两段式确认（bracketed-paste 感知） |
| 主题不匹配（Claude 深/浅色跟随） | xterm 原生响应 OSC 10/11 查询，无需改动 ✅ |
| tmux 全套问题 | 我们非多路复用器，escape-time/extended-keys/allow-passthrough 问题天然不存在 ✅ |

---

## 四、终端侧修不了（说明给用户的话术）

- 闪烁历史残影、状态行超宽错乱、内存泄漏、Token 限额报错不清晰——全是 Claude Code 渲染器/产品侧问题。我们能做的是把用户留在正确的模式上（alt-screen + 我们的全量重绘兜底）。
- RTL/泰文渲染错误——Claude 侧 Ink 库问题。

## 五、推荐实施顺序

**第一批（P0 四项，约 1 天）**：①Shift+Enter/Alt+Enter ②强制重绘 ③OSC 9 通知 ④复制去尾随空白。
**第二批（P1，1~2 天）**：⑤图片→SFTP（王牌，先出 HTML 设计稿确认交互）⑥TUI 滚动速度。
**暂缓记账**：⑦type-ahead ⑧scrollback 设置 ⑨会话恢复。
