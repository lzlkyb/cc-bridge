# 参与开发

cc-bridge 是本地 MCP 文件桥接桌面应用：Rust + Tauri 2 后端，React + TypeScript 前端。
欢迎 issue、文档修正和代码贡献。改动越大，越建议先开 issue 对齐方向，避免白做。

## 先读这两份

- [`docs/dev-setup.md`](docs/dev-setup.md)：从零跑起来（工具链、WebView2、常见环境错误）。
- [`SECURITY.md`](SECURITY.md)：安全问题的报告方式。**不要开公开 issue。**

## 协作模型

有 write 权限的贡献者直接在**主仓开分支**；其他人 fork 后提 PR。两种都接受，但都必须 rebase：

```bash
git clone git@github.com:lzlkyb/cc-bridge.git
cd cc-bridge
git checkout -b feat/your-feature

# 开工前、提交 PR 前各跑一次
git fetch origin && git rebase origin/main
```

> 为什么强调 rebase：`pull_request` 事件运行的是**你分支里的 workflow 文件**。
> fork 长期不 sync，就会一直跑旧版 CI——PR #1 曾因此连红两次，红的不是代码。
> 遇到这种情况先 rebase 再 push，不要改代码去迁就 CI。

## 环境

```bash
cd desktop
npm ci                 # 用 ci，不要用 install，锁文件要对齐
npm run setup:hooks    # 装 pre-push 门禁（CI 也会跑，但本地能提前发现）
npm run dev            # Tauri dev，前端 HMR
```

跑 dev 前先退出已安装的 cc-bridge：`tauri-plugin-single-instance` 会让 dev 秒退。
端口 1420 不能被占用（同一台机器上跑别的 Vite 项目也会撞）。

## 门禁

push 时 `.githooks/pre-push` 自动跑 7 项。也可以手动跑：

| 范围 | 命令（在 `desktop/` 下） | 内容 |
|---|---|---|
| 前端四项 | `npm run check` | 组件体量 → ESLint → tsc → vitest |
| Rust 三项 | `npm run check:rust` | fmt --check → clippy -D warnings → test |

前端四项缺一不可。Rust 三项必须带 `--no-default-features` / `--all-targets`，
漏了会漏编译另一半代码路径（Windows/macOS 的平台分支）。

## 代码约定

- **组件体量**：`src/components/**` 与 `src/hooks/**` 单文件 ≤ 300 行，且单文件
  `useState + useEffect` 总数 ≤ 8。存量超标文件登记在
  `desktop/scripts/check-component-size.mjs` 的 `BASELINE`，采用棘轮：只许变小。
  接近上限时**新建文件**，不要把逻辑搬进 hook 凑行数。
- **公共纯函数**放 `desktop/src/lib/`，按主题分文件；不要往 `lib/utils.ts` 里堆。
- **换行符统一 LF**（`.gitattributes` 已配置），不要提交 CRLF。
- **ESLint 只开 `react-hooks` 两条规则**（`rules-of-hooks` / `exhaustive-deps`），
  故意不开格式规则（项目没有 Prettier，现在加会改动整个仓库）。
  修好存量违规后跑 `npm run lint:prune` 收紧基线。
- **安全模块不得放松**：路径白名单校验（`security/path.rs`）、Bearer token 常量时间比较、
  限流。任何改动都要保留「被拒时附带白名单」的错误提示。
- **新增 MCP 工具**（注册表数据驱动）：在 `src/mcp/tools/xxx.rs` 写 `handle()` 并给参数
  类型派生 `ToolSchema` → `tools/mod.rs` 声明 `pub mod xxx;` → `registry.rs` 的
  `all_tools()` 加一行 `register_tool!`。**不要改** `http.rs` 的 `dispatch_tool` /
  `get_tool_definitions`，它们遍历注册表。
- **返回值有上限**：新增或修改返回列表、文件内容、命令输出的工具，必须给上限，
  按**序列化后**的结果文本计算（默认 32KB，封顶 45KB）。不要用 `to_string_pretty`。

## 提交

- 一个提交做一件事。**逐文件 `git add`，不要 `git add -A`**。
- 前缀：`feat:` 新功能 / `chg:` 变更 / `fix:` 修复 / `refactor:` 重构 / `docs:` 文档。
- 版本号只有一个真源：`desktop/src-tauri/Cargo.toml`。**贡献者不要动版本号**；
  `package.json` 与 `tauri.conf.json` 里的版本由 `scripts/sync-version.mjs` 同步，手改会被覆盖。
- 日常改动只往 `CHANGELOG.md` 顶部的 `## [Unreleased]` 追加条目（按 新增/变更/修复 分类）。

## PR

- 说明解决什么问题、影响哪个平台、**验证了什么**（具体命令 + 结果）。
- UI 改动附截图；Rust 改动说明是否在 macOS 侧验证过（CI 会跑 `cargo check`）。
- 门禁红了先看 job 的 Summary。出现 `sccache: failed to spawn Command` 或
  `os error 206` 时，通常不是你的代码问题（Windows 命令行长度上限），在 PR 里说明即可。
- 维护者可能会直接在你的分支上补一个小修复；不想被改动就在 PR 里写明。

## 发版

发版由维护者执行（`npm run release`），依赖代码签名私钥与 Gitee 镜像凭据，
**不对贡献者开放**。tag 构建也不跑前端门禁，所以外部 PR 不参与发版流程。
