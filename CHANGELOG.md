# Changelog

本项目所有重要变更记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
