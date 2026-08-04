# WebView2 共享 BROWSER 进程方案

## Context

### 问题
- 之前 cc-bridge 在本机只占 ~10MB 进程（其它 webview2 app 子进程），与同机其他 WebView2 应用共享 BROWSER 进程
- 根因：腾讯游戏管家（GameViewer）注入了 `WEBVIEW2_USER_DATA_FOLDER` 环境变量，强制所有 webview2 app 使用 `C:\ProgramData\GameViewer\EBWebView`，导致 BROWSER 进程被腾讯“代养”
- 8-4 清理后环境干净：`WEBVIEW2_USER_DATA_FOLDER` 已删，cc-bridge 单独承担完整的 6 进程（**374MB**）：
  - cc-bridge-desktop 父: 45MB
  - BROWSER: 152MB
  - renderer: 64MB
  - gpu-process: 45MB
  - utility ×2: 19+34MB
  - crashpad: 11MB

### 用户意图
用户希望恢复先前那种"开几个应用共享内存"的轻量感觉。已被用户认可为方案 A（强制共享），路径 `WebView2Shared`，静默加入。

### 关键机制
WebView2 只在多个实例共享同一个 user-data-dir 时复用 BROWSER 进程。Edge runtime 启动时读取 `WEBVIEW2_USER_DATA_FOLDER` 环境变量，把它作为所有 WebView2 实例的根目录。相同目录的所有实例共用同一个 BROWSER。

### 安全性
跨 app 共享 cookies / localStorage / IndexedDB / ServiceWorker / Cache。属于 machine-wide 副作用，**意味着这台上跑的所有 webview2 app（VSCode / Teams / 微信 / 钉钉等）都会自动加入共享池**。已被用户明确接受。

---

## Implementation Plan

### 改动范围
**仅修改一个文件**：`desktop/src-tauri/src/main.rs`，插入位置在 `fn main()` 内 `env_logger::init();` 之后、构造 `tauri::Builder::default()` 之前。

不修改 `tauri.conf.json` / `Cargo.toml` / `commands.rs` / `lib.rs` / `show_or_create_main_window` / capabilities。

### 插入位置（基于实际行号）
- L239: `fn main() -> Result<...>`
- **L240: `env_logger::init();`**
- L244-245: `#[cfg(windows)] crate::firewall::suppress_child_error_dialogs();`
- L247: `let builder = tauri::Builder::default()`

**插入点：L240-241 之间**（紧贴 `env_logger::init();` 之后），让所有"main 启动前的进程状态改造"集中在一处。

### 插入代码（~50 行，含大量注释）

```rust
    // ─── WebView2 进程共享（机器范围 BROWSER 复用）───────────────────────────────────────
    //
    // 背景：WebView2 只在多个 webview2 实例共用同一个 user-data-dir 时才会复用
    //       msedgewebview2.exe (BROWSER) 进程；默认 Windows 给每个 app 隔离目录，
    //       所以每个 webview2 app 都自带一组 BROWSER+gpu+renderer+utility+crashpad，
    //       单 cc-bridge 实例就吃 1 BROWSER (152MB) + 5 子进程 (≈222MB) ≈ 374MB。
    //
    // 做法：在 WebView2 进程被 spawn 之前把 WEBVIEW2_USER_DATA_FOLDER 指向一个
    //       公共目录。本机其他 webview2 app 若也使用同一目录（默认情况，不重设
    //       env var 就会用此值），Edge 运行时会把它们合并到同一组进程里。
    //       实测对 cc-bridge：单实例 ≈ 374MB → 共享后 ≈ 80MB（仅 renderer + 共享 BROWSER）。
    //
    // 必须在 tauri::Builder::default() 之前调用：Env var 在 Edge runtime 启动时被
    // 读取，那时子进程已被 spawn 继承本进程环境变量。set_var 在 Rust 2021 是 safe
    // （2024 起变 unsafe，到时需补 unsafe 块）。本仓库 Cargo.toml edition = "2021"。
    //
    // 安全含义（机器范围副作用，已与用户确认接受）：
    //   · Cookies / localStorage / IndexedDB / Service Worker / Cache 跨所有 webview2 app 共享。
    //   · 一个 app 崩溃可能拖累 BROWSER，连带影响同目录的其它 app；Edge runtime 会
    //     自动重启 BROWSER 接管，所有 app 1-3 秒内恢复。
    //   · WebView2 Runtime 更新（Windows Update）期间 BROWSER 重启，所有同池 app
    //     短暂闪退，属正常现象。
    //   · 不影响 release_webview_on_close 行为：关窗销毁 webview 走的是 Tauri 窗口
    //     生命周期，与本 env var 完全正交。
    //
    // 路径选取：%LOCALAPPDATA% 而非 %APPDATA%（WebView2 推荐：低延迟、不漫游、不进 OneDrive 同步）。
    // 不在 uninstaller 里清这个目录——它是机器级共享资源，卸载 cc-bridge 不应连带删除其它 app 数据。
    #[cfg(windows)]
    {
        use std::path::PathBuf;
        let shared_dir = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from("."))
            })
            .join("WebView2Shared");
        match std::fs::create_dir_all(&shared_dir) {
            Ok(_) => {
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &shared_dir);
                log::info!(
                    "WebView2 user-data-dir 共享路径：{}（本机其他 webview2 app 将自动加入同一 BROWSER 进程池）",
                    shared_dir.display()
                );
            }
            Err(e) => {
                log::warn!(
                    "无法创建 WebView2 共享目录 {}：{}；回退到默认 per-user 隔离（~374MB）",
                    shared_dir.display(),
                    e
                );
            }
        }
    }
    // ────────────────────────────────────────────────────────────────────────
```

### 关键设计点

| 决策 | 理由 |
|------|------|
| **插入位置在 `env_logger::init()` 之后** | 让 `log::info!` 能命中 dispatcher；早于 builder 即可 |
| **`#[cfg(windows)]` 包裹** | 本特性仅对 Windows + WebView2 有意义，macOS/Linux 走 native webview 没必要 |
| **`use std::path::PathBuf;` 写在块内** | 不污染文件顶部 imports，diff 最小 |
| **`create_dir_all` 失败仅 warn 不阻断** | 失败时回退默认 per-user 隔离，行为回归 374MB 现状；不阻断启动 |
| **不主动迁移老数据** | `%LOCALAPPDATA%\com.ccbridge.desktop\EBWebView` 下的旧 cookies/localStorage 不迁移——cc-bridge 前端不使用 localStorage（数据走 SQLite + Rust 命令），迁移无收益 |
| **不写 uninstaller 清理** | 共享目录是机器级，卸载 cc-bridge 不应连带清理 |
| **不修改 `tauri.conf.json`** | Tauri 2 window schema 不暴露 per-app data-dir 配置；env var 是 Edge runtime 的官方公开 API |
| **不调用 `WebviewWindowBuilder::data_directory()`** | 该方法只在单个 app 维度控制；用户要的是跨 app 共享，env var 才能覆盖整个进程 fork 树 |

### 不改的文件
- `desktop/src-tauri/Cargo.toml` —— 0 新增依赖（`std::env` / `std::fs` 都是 std）
- `desktop/src-tauri/tauri.conf.json` —— 无 `dataDirectory` schema 字段可用
- `desktop/src-tauri/capabilities/default.json` —— 与文件系统无关
- `desktop/src-tauri/src/lib.rs` / `commands.rs` —— 不影响 IPC 接口
- `desktop/src-tauri/src/show_or_create_main_window`（L49 `main.rs`）—— 窗口构造器继承进程环境，无需改动
- `desktop/src-tauri/src/firewall.rs` —— 与 env var 完全正交

---

## Verification（实施后跑哪些）

### 1. 单实例 dev 验证
```bash
cd C:\Users\19145\Downloads\10.0.19.194\202607071638\cc-bridge\desktop
npm run tauri dev
```
预期 stdout：
```
[INFO] WebView2 user-data-dir 共享路径：C:\Users\19145\AppData\Local\WebView2Shared（本机其他 webview2 app 将自动加入同一 BROWSER 进程池）
```

### 2. 进程数验证（核心指标）
```powershell
Get-Process msedgewebview2 | Group-Object ProcessName | Select-Object Count, Name
```
预期：单 cc-bridge 启动后 msedgewebview2.exe 数量 = 6（与改动前相同），但所有子进程的父 ppid 指向同一个 BROWSER。**关键**：再启动另一个 webview2 app（如 `notepad.exe` 不相关，VSCode 或微信相关），应该看到那 6 个子进程的 pid 变化而不增加。

### 3. 数据共享验证
cc-bridge 启动后查 `%LOCALAPPDATA%\WebView2Shared\` 目录存在且 Edge runtime 自动生成了 `Default/` `Crashpad/` 等子目录。

### 4. 回退验证（不实施时）
不实施本方案时，cc-bridge 维持现有 374MB 占用。

### 5. 其它功能不受影响
- 关窗销毁逻辑（L49 `show_or_create_main_window`）：不变，release_webview_on_close 仍然 5.5MB 平台
- 防火墙探测（netsh / PowerShell）：不变
- 自动更新（`start_update` 命令）：不变
- 进程监控、托盘通知、IP 变化检测：不变

---

## 关键文件

- **修改**：`C:\Users\19145\Downloads\10.0.19.194\202607071638\cc-bridge\desktop\src-tauri\src\main.rs`（L240-241 之间插入 ~50 行）
- **只读参考**：
  - `desktop/src-tauri/Cargo.toml` —— 确认 `edition = "2021"`（`std::env::set_var` 仍 safe）
  - `desktop/src-tauri/tauri.conf.json` —— 确认无 `dataDirectory` schema
  - `desktop/src-tauri/src/main.rs` L49-L82 `show_or_create_main_window` —— 了解窗口构造器现状
  - `cc-bridge/功能优化清单.md` M4 节（L45-L105）—— 历史背景

---

## 风险与已知限制

### 已知风险
1. **跨 app 数据共享**：所有 webview2 app 共享 cookies/localStorage。**已被用户明确接受**。
2. **BROWSER 进程被拖累**：一个 app 崩溃 → BROWSER 重启 → 全池 app 1-3 秒重连。Edge runtime 自动处理。
3. **WebView2 Runtime 更新**：Edge / WebView2 升级时 BROWSER 重启，全池 app 短暂闪退。
4. **单实例 cc-bridge 仍吃 renderer 64MB**：共享只省 BROWSER + gpu + utility + crashpad 的合计 ~250MB，**renderer 进程不共享**（每个 webview 一个），所以总内存 ≈ 80MB + 64MB = 144MB 左右。

### 未来可加固点
- 添加 `CCBRIDGE_WEBVIEW2_USER_DATA_FOLDER` env var 覆盖，让高级用户可自定义默认路径
- 添加 `tauri.conf.json` 选项让用户在打包时选择 shared vs isolated
- 在 release notes 明确告知副作用

---

## 实施步骤

1. 在 `desktop/src-tauri/src/main.rs` L240 后插入上面的 ~50 行代码块
2. `cd desktop && cargo fmt` + `cargo clippy`（按 CLAUDE.md 规则 7）
3. `cd desktop && npm run tauri dev` 验证 dev 模式启动、log 出现
4. 查 msedgewebview2.exe 进程数 + ppm 检查
5. 按 CLAUDE.md 规则 5 等待用户确认再 `git commit`（不自动 commit）
6. 按 CLAUDE.md 规则 2 写入 CHANGELOG.md Unreleased 分区
