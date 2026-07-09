# cc-bridge 项目开发规则

> 本地 MCP 文件桥接桌面应用（纯 Rust + Tauri 2 后端 / React + TS 前端）。
> 规则对标 PastePanda，适配 cc-bridge 的真实技术栈与目录结构。

## 1. 先出方案再动手
修改代码前先出方案让用户确认，涉及取舍时提供 2-3 个方案对比（含优缺点），让用户选择。复杂任务先进 Plan Mode 规划再执行。

## 2. 每次修改同步递增两处版本号
cc-bridge 版本号有**两个来源，必须保持一致**：
- `desktop/src-tauri/tauri.conf.json` 的 `version`
- `desktop/src-tauri/Cargo.toml` 的 `version`

改动后两处同时递增，不允许只改一处导致漂移。`/health` 返回的 `version` 与 README 版本历史也需同步。

## 3. 构建 exe / 安装包前要询问用户
用户确认后才在 `desktop/` 目录执行 `npm run build`（= `tauri build`，产出 `cc-bridge-desktop.exe` + NSIS 安装包）。构建前先 `taskkill //F //IM cc-bridge-desktop.exe` 结束占用进程。

## 4. 改动 UI 要先出 HTML 设计稿
涉及界面变更时，先生成 HTML 设计稿让用户确认效果，再改代码。设计稿放 `design/`（见规则 13）。

## 5. 版本递增后等用户验证确认再提交 git
不要自动 `git commit`。等用户明确说"提交"或"commit"再操作。CI 分支为 `main`。

## 6. 预览测试用 Tauri dev 后台运行
在 `desktop/` 目录下启动，独立窗口后台运行，支持 Vite HMR 热更新，不阻塞主终端：
```powershell
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd desktop; npm run dev" -WindowStyle Minimized
```

## 7. 方案设计需考虑代码架构
模块化、可维护性、扩展性，遵循项目已有的分层架构。

**前端组件文件大小限制**（硬性规则）：
- 单个 `.tsx` 组件文件 **禁止超过 300 行**（不含类型定义）。
- 接近上限先拆分再继续：复杂状态逻辑抽到 `hooks/useXxx.ts`，独立 UI 区块抽到子组件，纯计算抽到 `lib/`。
- 当前超标文件（后续重构）：
  - `desktop/src/components/tabs/ConnectTab.tsx`（467 行）
- 新增功能时，若目标文件接近 300 行，默认新建文件而非追加。

**Rust 后端规则**：
- 提交前跑 `cargo fmt` + `cargo clippy`（在 `desktop/src-tauri/` 下），保持零警告。
- 新增 MCP 工具三件套：在 `src/mcp/tools/xxx.rs` 写 handler → 在 `tools/mod.rs` 声明 `pub mod` → 在 `http.rs` 的 `dispatch_tool` 加分支 + `get_tool_definitions` 加定义。三处缺一工具不可用。README「9 个 MCP 工具」表同步更新数量。
- **安全模块不得放松**：路径白名单校验（`security/path.rs` 的 `canonicalize` + 祖先遍历）、Bearer token 常量时间比较、限流，任何改动都不能削弱这些约束，且要保留被拒时附带白名单的错误提示。

## 8. 方案设计需考虑性能
内存占用、二进制体积（当前安装包 3.4MB / exe 14MB，是核心卖点，勿引入无谓依赖）、前端加载速度、轮询频率（状态 5s / 审计 10s）。

## 9. 方案设计需考虑用户体验
交互流畅度、反馈及时性、边界状态（加载中 / 空状态 / 错误）。白名单为空、连接失败等场景要有明确引导，不让用户盲猜。

## 10. 改完代码不需要重启 dev
若 `tauri dev` 已运行，前端改动 Vite HMR 自动热更新，直接看效果。**注意**：改动 Rust 后端（`src-tauri/`）需重新编译，HMR 不生效，须重启 dev 或重新 build。

## 11. 公共工具函数统一放 lib/utils.ts
多个前端组件共用的纯函数（IP 提示、命令拼接、掩码、相对时间等）必须在 `desktop/src/lib/utils.ts` 中 `export`，各组件 `import` 引用，禁止重复定义。（当前 `lib/` 仅有 `tauri.ts` + `types.ts`，抽第一个公共函数时创建 `utils.ts`。）

## 12. 改动 UI 前必须读取真实组件源码
生成 HTML 设计稿前，先读相关 `.tsx` 与样式（`index.css` / TailwindCSS 变量）源码，设计稿的样式、结构、图标、文案必须与真实代码一致，不得凭空自创。

## 13. 文件存放目录规范
| 文件类型 | 存放目录 |
|---------|---------|
| `.md` 文档 | `cc-bridge/docs/` |
| `.html` 设计稿 | `cc-bridge/design/` |

（当前两目录不存在，首次产出对应文件时创建。README.md 保留在项目根。）

---

## 发版流程
当用户说 **"tag"** 或 **"打tag"** 时执行发版：

1. **递增版本号** — 同步 `tauri.conf.json` + `Cargo.toml` 的 patch 版本 +1（如 2.0.0 → 2.0.1），并更新 README 版本历史。
2. **更新 CHANGELOG.md**（若无则创建）— 扫描上次 tag 到当前的 commit，按前缀分类，在文件顶部插入新版本段落，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。
3. **git add** — 暂存所有变更（含 CHANGELOG.md）。
4. **生成 commit message** — 带前缀（`feat:`/`chg:`/`fix:`），标题 + 空行 + 变更列表。
5. **git commit**。
6. **git push origin main** — 推送代码。
7. **git tag v{version}**（如 `v2.0.1`）。
8. **git push origin v{version}** — 推送标签，触发 `.github/workflows/build.yml` 的 `build-windows`（仅 `refs/tags/v*` 触发）构建 Windows exe + 安装包并发布 Release。

> CI 说明：`build.yml` 先在 Linux 跑 Rust 测试套件（`test` job，`desktop/src-tauri` 下 `cargo test`），通过后才在 `windows-latest` 构建。tag 前确认测试可过。

### Commit 前缀规范
| 前缀 | 分类 | 示例 |
|------|------|------|
| `feat:` | ✨ 新功能 | `feat: 新增 list_allowed_roots 工具` |
| `chg:` / `change:` | 🔄 变更 | `chg: 协议版本改为回显客户端` |
| `fix:` | 🐛 修复 | `fix: 修复多网卡 IP 选错` |
| `refactor:` | 🔧 重构 | `refactor: 拆分 ConnectTab` |
| `docs:` | 📖 文档 | `docs: 更新 README 工具表` |
