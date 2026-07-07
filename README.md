# cc-bridge — 项目说明

> 写这份文档的目的：让接手这个项目的人（或另一个 AI 工具）不用翻聊天记录，看这一份就能了解这个项目是什么、为什么做、做成什么样了、还差什么。

## 这是什么

**cc-bridge**：一个跑在本地 Windows 开发机上的 MCP（Model Context Protocol）文件桥接服务，正在往"像 cc-switch 一样的原生桌面应用"演进。远程 Linux 服务器上的 Claude Code 通过标准 MCP 协议（Streamable HTTP transport）连接它，就能直接读写本地 Windows 机器上的文件、搜索代码、做批量操作——不再需要 scp 来回传文件，也不需要 SSHFS 挂载。

## 背景 / 解决的问题

团队日常在本地 Windows 电脑上写代码，但 Claude Code 部署在远程 Linux 服务器上。原来的痛点：

1. **文件传输效率低**：每次改动都要手动 scp 上传下载，大文件慢，还容易忘记同步导致版本混乱。
2. **SSHFS 不稳定**：挂载远程目录后，网络一断整个挂载点就卡死，终端被阻塞，得重新挂载才能继续工作。
3. **缺少智能化操作**：只能靠终端命令操作文件，没有批量重构、代码分析这类能力。
4. **操作无法审计**：不知道 Claude 改了哪些文件，误操作后没法追溯和恢复。

## 解决方案（整体架构）

```
远程 Linux 服务器（Claude Code 运行的地方）
        │  MCP 协议 / HTTP（同一内网/VPN 直连）
        ▼
本地 Windows 开发机
        │
        ├─ server/cc-bridge.js ── 唯一核心逻辑文件：MCP 协议实现 + 8 个文件工具
        │                         + 安全校验 + 自动备份 + 限流 + 审计日志
        │                         + 内置 Web 管理面板（ui.html）
        │
        └─ desktop/ ── Tauri 原生桌面壳，把上面这个服务包成一个真正的
                        桌面应用（任务栏图标/独立窗口/系统托盘），
                        体验对标 cc-switch
```

关键技术决策：**用真正的 MCP 协议**（官方 `@modelcontextprotocol/sdk`），不是自己拍脑袋做一套 REST API——这样远程 Claude Code 用 `claude mcp add --transport http` 就能把它当原生 MCP server 加进去，工具能被自动发现调用，不需要额外的协议转换胶水代码。

## 功能清单

### 8 个 MCP 工具（远程 Claude Code 直接调用）
| 工具 | 作用 |
|---|---|
| `list_directory` | 列目录，支持递归 + 深度限制 |
| `read_files` | 批量读文件，支持指定行范围（1-based） |
| `write_files` | 批量写/新建文件，自动建父目录，覆盖前自动备份 |
| `delete_files` | 批量删除文件（不删目录），删前自动备份 |
| `move_files` | 批量移动/重命名，目标已存在则先备份 |
| `copy_files` | 批量复制，目标已存在则先备份 |
| `search_files` | 按文件名 glob + 内容关键字/正则全文搜索 |
| `analyze_file` | 文件基础信息 + 函数/类数量的启发式估算（非 AST 精确解析） |

### 安全机制
- **路径白名单**（`allowedRoots`）：只能访问明确允许的根目录，`realpathSync` 防软链接逃逸，`path.relative` 判断防路径穿越。
- **扩展名白名单**（`allowedExtensions`）：默认放开常见代码/文本后缀，留空表示不限制。
- **Bearer token 认证**：所有接口都要 `Authorization: Bearer <token>`，用 `crypto.timingSafeEqual` 防时序攻击。
- **限流**：滑动窗口，默认 100 次/分钟，超限 429。
- **自动备份**：写/删/覆盖前备份到 `.cc-bridge-backup/`，按时间戳命名，保留最近 N 份自动清理旧的。
- **审计日志**：`audit.log`（JSON Lines），记录每次操作的时间/工具/路径摘要/成功失败/来源 IP。
- **单文件大小上限**：默认 20MB，防止意外读写超大文件。

### HTTP 接口一览
| 路径 | 方法 | 认证 | 作用 |
|---|---|---|---|
| `/mcp` | POST | 需要 | MCP 协议入口（Streamable HTTP，无状态，每请求新建一个 McpServer+transport） |
| `/health` | GET | 不需要 | 存活检测 |
| `/status` | GET | 需要 | 当前配置 + 运行状态 + 现成的 `claude mcp add` 连接命令 |
| `/audit/recent?limit=` | GET | 需要 | 最近 N 条审计日志 |
| `/` | GET | 不需要 | Web 管理面板（`ui.html`），面板内部再用 token 拿数据 |
| `/config` | POST | 需要 | 局部更新配置：白名单目录/扩展名/限流/备份份数**立即热生效**；port/host 存盘但需重启才生效 |
| `/config/token/regenerate` | POST | 需要 | 重新生成 token，立即生效 |
| `/fs/browse?path=` | GET | 需要 | 只读目录浏览（全盘可浏览，只读目录名不读文件内容），给"选择目录"功能用 |

### Web 管理面板（`ui.html`，参考 cc-switch 的卡片式视觉风格）
浏览器打开 `http://<机器IP>:<port>/`，粘贴 token 后可以：
- 看现成的 `claude mcp add ...` 连接命令，一键复制
- 编辑白名单根目录（手填路径 或 点"浏览…"用目录选择器，全盘导航）
- 编辑扩展名白名单/单文件大小上限/限流参数/备份保留份数（保存即生效，不用重启）
- 编辑端口/监听地址（保存后提示需要重启；桌面版下会自动重启）
- 一键重新生成 token
- 看运行状态（运行时长/请求数/错误数）和最近的审计日志
- 支持深色/浅色主题切换

桌面版下，页面会通过 URL 参数自动拿到 token（不用手动粘贴），并且改端口/监听地址后由桌面壳自动重启服务、自动跳转，不需要手动操作。

### 易用性设计
- **打包成单文件 exe**：用 Node 20+ 自带的 SEA（Single Executable Application）+ esbuild + postject，产出的 `cc-bridge.exe` 不需要用户机器装 Node.js，双击就能跑（`ui.html` 作为 SEA asset 内嵌进 exe，不需要额外带着这个文件）。
- **`--setup` 交互式配置向导**：命令行问答式配置白名单目录，不用手改 `config.json`。
- **启动横幅**：每次启动自动探测局域网 IP，直接打印出可复制粘贴的 `claude mcp add` 命令。
- **桌面应用**（`desktop/`）：任务栏图标 + 独立窗口 + 系统托盘，双击图标直接用，不用开终端/浏览器。

## 目录结构

```
cc-bridge/                                # 整个项目的根目录
├── README.md                             # 就是这份文档
├── server/                                # 核心 MCP 服务（已完成并验证）
│   ├── cc-bridge.js                       # 唯一核心逻辑源文件
│   ├── ui.html                            # Web 面板（内嵌进 exe）
│   ├── build.js                           # SEA 打包脚本（要在 Windows 机器上跑）
│   ├── package.json / package-lock.json
│   ├── config.json.example                # 配置模板（真正的 config.json 运行时自动生成，含 token，不进版本库）
│   ├── .gitignore
│   └── test/mcp-client-test.js            # 最小 MCP 客户端，覆盖 8 个工具 + 安全/限流/备份场景
└── desktop/                                # 桌面壳（Rust 代码已在 Linux 容器里编译验证过，见下方"当前状态"）
    ├── package.json                       # 只是 @tauri-apps/cli 的 npm 包装
    ├── prepare-sidecar.js                 # 把 server/dist/ 里的 exe 按 Tauri sidecar 命名规则复制过来
    ├── frontend-placeholder/index.html    # 未使用的占位页（真正页面来自 sidecar 自己的 HTTP 服务）
    └── src-tauri/
        ├── Cargo.toml / Cargo.lock / build.rs
        ├── tauri.conf.json
        ├── capabilities/default.json
        ├── icons/                          # 占位图标（纯色方块，RGBA 格式），发布前要用 `npx tauri icon` 换成真的
        └── src/main.rs                     # 拉起/管理 sidecar + 窗口 + 系统托盘 + 配置变更自动重启
```

## 技术选型摘要

- **语言/运行时**：Node.js 20+，官方 `@modelcontextprotocol/sdk`（Streamable HTTP transport），`zod` 做工具参数校验。
- **不用**：FastAPI/Express/其他 REST 框架（用原生 `http.createServer`，保持依赖面小）。
- **打包**：Node SEA（不是 pkg/nexe），因为官方支持、产物干净、不用额外装 Node 运行时。
- **配置存储**：同目录 `config.json`（不是环境变量/命令行参数），首次启动自动生成默认值（`allowedRoots` 为空 = 安全默认，拒绝所有文件操作）。
- **桌面壳**：Tauri 2（Rust），跟 cc-switch 同款技术栈，产物比 Electron 小得多（用系统自带 WebView2，不用捆绑 Chromium）。

## 当前状态

1. ✅ **`server/` 核心 MCP 服务**——已完整实现并在这台 Linux 机器上验证通过（`node test/mcp-client-test.js` 16 项全部 PASS，覆盖 8 个工具、并发写锁、备份保留、路径穿越拦截、限流、token 校验等）。打包出的 SEA exe 也验证过能独立运行。**这部分需要真正部署时，要在 Windows 机器上重新 `npm install` + `node build.js`**（这台 Linux 服务器上产出的是 Linux 二进制，不能直接给 Windows 用）。

2. ✅ **`desktop/` 桌面壳（Rust 代码已编译验证）**——目标是把上面的服务包成一个像 cc-switch 一样的原生桌面应用（Tauri 2）：任务栏图标、独立窗口、系统托盘、关闭窗口最小化到托盘、托盘菜单退出才真正杀进程。技术方案：
   - `cc-bridge.exe`（SEA 产物）原样复用，作为 Tauri 的 **sidecar 子进程**，Rust 侧负责拉起/杀死它。
   - Rust 侧读 `config.json` 拿 token，通过 URL 参数 `?token=...&managed=1` 直接把 token 传给页面，省去手动粘贴。
   - Rust 侧后台轮询 `config.json` 的 port/host，检测到变化就自动重启 sidecar 并让窗口跳转到新地址——解决了"改端口必须手动重启"的老问题。
   - **验证情况**：这台 Linux 服务器本来没有 Rust 工具链，装了 rustup + 在一个 Ubuntu 24.04 容器里装齐 `webkit2gtk`/`gtk3`/`libayatana-appindicator3` 等桌面依赖后，`cargo check` 已经跑通（Linux target），过程中揪出并修好了一个真实的借用检查错误（`.run()` 退出回调里 `MutexGuard` 生命周期问题）和一个图标格式问题（占位图标最初是 RGB，Tauri 要求 RGBA）。main.rs 用到的 Tauri/tauri-plugin-shell/tauri-plugin-single-instance API 已经确认是对的。**没有验证过的**：真正的 Windows 编译（`cargo tauri build` 的 NSIS 打包步骤是 Windows-only，跨平台编译不现实），需要在 Windows 机器上装好 Rust + Tauri CLI 后跑一次确认。
   - 占位图标是纯色方块（RGBA 格式，已验证能被 Tauri 接受），正式发布前需要用 `npx tauri icon <一张方形PNG>` 换成真的品牌图。

## 部署到 Windows 机器的完整流程

```bash
# 1. 把 server/ 整个文件夹传到 Windows 机器（不带 node_modules 更干净）
cd server
npm install

# 2. 配置白名单目录（二选一）
node cc-bridge.js --setup
# 或者直接启动后在浏览器面板里配置：
node cc-bridge.js

# 3. 打包成不依赖 Node 环境的单文件 exe
node build.js
# 产出 dist/cc-bridge.exe，双击即可运行

# 4. 启动后终端会打印一条现成命令，粘贴到远程 Linux 服务器执行：
# claude mcp add --transport http cc-bridge http://<局域网IP>:7823/mcp --header "Authorization: Bearer <token>"
```

之后如果要用桌面壳版本（`desktop/`）：
```bash
# 装好 Rust (rustup.rs) + Tauri CLI 后
cd desktop
npm install
npm run build   # 会先跑 prepare-sidecar.js 把 ../server/dist/cc-bridge.exe 复制成 sidecar，再 cargo tauri build
```

## 已知限制

- 只支持同一内网/VPN 直连，没做公网穿透/反向代理。
- `analyze_file` 的函数/类计数是正则启发式估算，不是真正的语法解析。
- `delete_files` 不支持删整个目录，只删单个文件（避免误删目录树）。
- 审计日志不会自动轮转/清理，长期运行需要自己清。
- 如果把 Web 面板的"监听地址"改成某个具体 LAN IP 而不是 `0.0.0.0`/`127.0.0.1`，桌面壳窗口（固定连 `127.0.0.1`）可能连不上自己的 sidecar——建议桌面壳场景下监听地址保持默认。
- 桌面壳的 Windows 目标编译没有被真正验证过，只验证了 Linux 下 `cargo check` 通过（详见"当前状态"）。
