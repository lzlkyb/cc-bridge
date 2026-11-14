# 本地开发环境

目标：clone 下来 15 分钟内跑起 `npm run dev`，并且本地门禁与 CI 结果一致。

## 1. 系统要求

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10/11 x64，或 macOS Apple Silicon | 目前没有 Intel Mac 与 Linux 构建 |
| Node.js | **22.x**（CI 用 22） | 见 `.nvmrc`；18+ 也能跑，但 CI 对齐 22 |
| Rust | stable，**MSVC 工具链** | 版本锁在 `desktop/rust-toolchain.toml` |
| VS Build Tools | 「使用 C++ 的桌面开发」 | 只需 Windows；提供 MSVC 链接器与 Windows SDK |
| WebView2 Runtime | 一般系统自带 | 精简版 Windows 需手动装 |
| macOS | Xcode Command Line Tools | `xcode-select --install` |

### 🔴 Windows 必须用 MSVC，不要用 GNU

```bash
rustup default stable-x86_64-pc-windows-msvc
rustup toolchain list          # 确认默认是 *-msvc
```

用 GNU 工具链编译出来的测试二进制在本机启动即崩（`0xC0000139` / `ENTRYPOINT_NOT_FOUND`），
表现为「Rust 测试一条都跑不了」，很容易被误判成代码问题。这个问题已经真实发生过一次，
排查成本远高于换工具链。

## 2. 拉代码与安装依赖

```bash
git clone git@github.com:lzlkyb/cc-bridge.git
cd cc-bridge/desktop

npm ci                 # 必须用 ci：package-lock.json 要完全对齐
npm run setup:hooks    # 把 core.hooksPath 指到 .githooks，push 时自动跑门禁
```

`npm run setup:hooks` 只写一条仓库级 git 配置（`core.hooksPath`），随时可以
`git config --unset core.hooksPath` 撤销。

## 3. 跑起来

```bash
cd desktop
npm run dev
```

首次会编译整个 Rust crate，几分钟起步；之后只编改动部分，前端走 Vite HMR。

**启动前必须确认两件事**：

1. **退出已安装的 cc-bridge**。`tauri-plugin-single-instance` 是无条件注册的，
   安装版持锁会让 dev 进程秒退，而且不会有明显报错，看起来像「点了没反应」。
2. **1420 端口空闲**。Vite 配置了 `strictPort: true`，被占用会直接失败，
   不会自动换端口。查占用：

   ```bash
   # Windows
   netstat -ano | findstr :1420
   # macOS
   lsof -i :1420
   ```

## 4. 本地门禁（与 CI 同一套）

```bash
cd desktop
npm run check        # 前端四项：组件体量 → eslint → tsc → vitest
npm run check:rust   # Rust 三项：fmt --check → clippy -D warnings → test
```

装了钩子的话，`git push` 会自动跑同样的 7 项，顺序按「失败越快越靠前」排。
想跳过用 `git push --no-verify`——但 CI 会照样跑，跳过只延迟发现问题。

> ⚠️ push 前不要另外手动起一个 `cargo test`。钩子内部会跑 clippy 和 test，
> 两个进程抢 `target/` 构建锁会报 `Blocking waiting for file lock` 并让 push 被拦。

## 5. 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `cargo test` 一条都跑不了，退出码 `0xC0000139` | GNU 工具链或架构不匹配 | 换 `*-msvc` 工具链，`rustup default stable-x86_64-pc-windows-msvc` |
| dev 起来后立刻退出，无报错 | 安装版单实例持锁 | 退出/结束 `cc-bridge-desktop` 进程后重试 |
| Vite 报端口被占用 | 1420 被别的项目或残留进程占用 | 按上节命令找出 PID 结束它；**不要**直接 `taskkill /IM node.exe`，会误伤同机其它项目 |
| `sccache: failed to spawn Command` / `os error 206` | Windows 命令行长度超 32767（CI 侧已知问题，本机装了 sccache 也可能撞） | 清空 `RUSTC_WRAPPER` 后重跑：`set RUSTC_WRAPPER=`（Windows）/ `unset RUSTC_WRAPPER`（macOS） |
| `npm ci` 卡住或 ECONNRESET | 网络/代理 | 配 npm registry 或代理后重试；不要改用 `npm install` 绕过锁文件 |
| macOS 打包失败 `bundle target nsis` | `tauri.conf.json` 的 targets 固定为 nsis | 用 `npx tauri build --bundles app` 覆盖 |

## 6. 目录速览

```
desktop/
├── src/                  # React 前端
│   ├── components/       # 组件（受 300 行 / 8 hook 体量门禁约束）
│   ├── hooks/            # 同上
│   └── lib/              # 公共纯函数，按主题分文件
├── src-tauri/            # Rust 后端
│   └── src/
│       ├── mcp/tools/    # MCP 工具实现（注册表驱动）
│       └── security/     # 路径白名单等安全约束，改动不得放松
└── scripts/              # 门禁、版本同步、发版脚本
```

CI 分工：Ubuntu 跑前端四项，Windows 跑 `cargo test`，macOS 跑
`clippy --all-targets` + 全量测试（平台差异只在 mac 编译时暴露）。
