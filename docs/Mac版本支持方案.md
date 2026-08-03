# Mac 版本支持方案

> **方案 A：免费版（不签不公证）**
> 编写日期：2026-08-03
> 状态：草案，待实施

---

## 1. 目标与定位

让 cc-bridge **在 macOS 上能跑起来、能自动更新**，但不花 ¥688/年的 Apple Developer 账号、不做代码签名、不做公证。

**目标用户**：内部测试、朋友、尝鲜用户、早期 alpha 受众。

**不期望覆盖**：

- App Store 上架
- 路人用户一键安装（Gatekeeper 弹窗会让 90% 用户放弃）
- 企业内部分发（需要 Developer ID）

**升级触发条件**（什么时候切到付费方案）：

1. 主动反馈"想要 Mac 版"的真实用户 ≥ 10 人
2. 或需要上架 App Store / 接受企业采购
3. 或 GitHub Issues 里 Gatekeeper 相关问题成为主要抱怨

---

## 2. 核心限制与代价

### 用户视角

| 步骤 | 操作 |
|---|---|
| 1 | 下载 `cc-bridge_X.Y.Z_macOS_universal.zip` |
| 2 | 解压得到 `cc-bridge.app` |
| 3 | 拖入 `/Applications/` |
| 4 | 双击 → ❌ 弹"无法打开，因为它来自身份不明的开发者" |
| 5 | 右键 `cc-bridge.app` → 打开 → 新弹窗点「打开」（一次性） |
| 6 | 之后双击正常 |

或用终端一次性绕过：
```bash
xattr -dr com.apple.quarantine /Applications/cc-bridge.app
```

### 项目视角

| 项 | 值 |
|---|---|
| Apple Developer 账号 | **不需要** |
| 代码签名（p12 证书） | **不需要** |
| 公证（Notarization） | **不需要** |
| Staple | **不需要** |
| GitHub Secrets 新增 | **0 个** |
| GitHub Actions 时间 | macos-14 runner ~10 分钟/次（开源项目免费额度内） |

### 已知技术债

1. **每个用户首次打开都要手动绕 Gatekeeper**——分发体验差
2. **不能在 App Store 上架**——封闭渠道用户拿不到
3. **`.dmg` 也没签名**——部分用户对未签名 DMG 会更警惕（但 DMG 本身不强制要求签名，Gatekeeper 检查的是挂载后的 `.app`）
4. **autostart LaunchAgent 写入未在真实 Mac 上验证**——CI 跑不出
5. **kqueue EVFILT_NETDEV 在不同 macOS 版本上行为差异未实测**——首次实现后需真机回归

### 2.2 自动更新陷阱（必须提前告知用户）

A 方案下，**自动更新能跑但体验有坑**——这是选 A 方案必须接受的代价。Tauri updater 和 Apple Gatekeeper 是两套独立机制，必须拆开看：

#### 自动更新流程拆解

```
启动 → 检查更新 → 拉 updater.json → 应用内验签 → 下载 .tar.gz
     → 替换 .app（或失败）→ 重启应用
```

| 环节 | 受影响？ | 说明 |
|---|---|---|
| Tauri 应用内验签 | ✅ 不受影响 | 用项目自己的 `pubkey`（已配在 `tauri.conf.json`），跟 Apple 代码签名完全无关。未签名 `.app` 照样能验签 |
| `updater.json` 多平台 | ✅ 不受影响 | Tauri 自动给 `darwin-universal` 平台生成 manifest 条目，**不用改** |
| 下载新版本 | ✅ 不受影响 | 走现有双端点（ghproxy + GitHub） |
| 替换 `.app` | ⚠️ **取决于安装路径** | 见下表 |
| 更新后首次启动 | ⚠️ **被 Gatekeeper 拦一次** | 见下文 |

#### 坑 1：路径权限 — 装哪儿决定能不能更新

Tauri updater 替换 `.app` 时需要**写权限**：

| 安装路径 | 写权限 | updater 能否替换 |
|---|---|---|
| `/Applications/cc-bridge.app`（系统级，拖拽默认） | ❌ 需要 sudo | ❌ 静默失败 |
| `~/Applications/cc-bridge.app`（用户级） | ✅ | ✅ |
| `~/Library/Application Support/...` | ✅ | ✅ |

**这就是 Apple 签名能解的真正痛点**：签名后应用可以在 `/Applications/` 正常工作并自动更新。我们不签的话，**必须让用户装到用户级目录**。

#### 坑 2：Gatekeeper 二次拦截 — 每次更新都要重新绕

**最严重的问题**：

```
用户首次安装 → 右键 → 打开 → 跑了 3 个月
3 个月后自动更新到 v2.5.0 → 重启应用
                                    ↓
                          ❌ Gatekeeper 再次拦截！
                          "无法打开，因为它来自身份不明的开发者"
```

新版本 `.app` 跟旧版本一样没签名，**每次更新后首次启动都要重新右键**。这个体验比首次安装更糟糕——用户会觉得"我都已经绕过了，怎么又来了？"

> **注**：macOS 13+ 在「右键 → 打开」授权过一次后，确实会"记住"该应用。但只对**同一路径同一 bundle id** 有效；如果新版本下载到临时目录再 mv 覆盖，bundle id 不变但路径 inode 变了，部分 macOS 版本会重新拦截。

#### 综合评估

| 维度 | 影响 |
|---|---|
| 机制上能不能更新 | ✅ 能 |
| 更新流程会不会出错 | ⚠️ 取决于安装路径（用户级 OK，系统级失败） |
| 更新后能不能正常启动 | ⚠️ 能启动但要被 Gatekeeper 拦一次 |
| 用户感受 | 🟡 "能用，但每次更新都得手动" |

#### 应对方案（推荐 α，立即可做）

**方案 α：文档引导用户装到用户级目录**

README 写：

> **重要**：请将 `cc-bridge.app` 拖入 `~/Applications/`（你的用户级应用文件夹），而不是系统级的 `/Applications/`。
>
> 原因：本应用未做 Apple 代码签名，装到 `/Applications/` 会导致自动更新需要管理员权限而失败。
> 装到 `~/Applications/` 则自动更新完全无感。

- 代价：0
- 缺点：Mac 老用户习惯 `/Applications/`，会忽略

**方案 β：DMG 加引导脚本（中等代价）**

`.dmg` 内附一个 AppleScript 或 shell 脚本，弹窗告知：

> "检测到你要装到 `/Applications/`，但 cc-bridge 是未签名应用，建议改装到 `~/Applications/` 才能正常自动更新。"

- 代价：0.5 人日（DMG 加 step）
- 缺点：DMG 制作增加 CI 步骤复杂度

**方案 γ：硬扛 + 等真实用户反馈**

接受"装 `/Applications/` 的用户失去自动更新"，文档说明清楚。

#### 升级到付费方案后此节变化

买 Apple Developer 账号并启用 codesign + notarize 后：

- 路径权限坑 → ✅ 消失（Apple 签名应用可在 `/Applications/` 写自己的更新 helper，updater helper 提权无需 sudo）
- Gatekeeper 二次拦截 → ✅ 消失（每次更新后 `.app` 仍然是签名+staple 状态，Gatekeeper 直接放行）
- 升级触发条件见 [后续路线 §8.2](#82-中期用户基数--50)

---

## 3. 技术架构决策

### 3.1 跨平台代码层

以下模块**已经跨平台**，不需要改：

| 模块 | 状态 |
|---|---|
| 前端（React + Vite + Tauri invoke） | ✅ |
| Tauri 2 框架（window/tray/menu/clipboard/opener/process/notification） | ✅ |
| `lib.rs` 主入口 | ✅ |
| MCP HTTP server（axum + tokio + rusqlite） | ✅ |
| `security/path.rs` + `security/auth.rs` | ✅ |
| `db.rs` / `audit.rs` / `config.rs` / `state.rs` | ✅ |
| `commands.rs`（除 browse） | ✅ |
| `browse.rs`（已有 `#[cfg(not(windows))]` 降级到 `/`） | ✅ |
| `tauri-plugin-autostart::MacosLauncher::LaunchAgent` | ✅（已支持 Mac） |

### 3.2 需要适配的部分

| 文件 | Windows 实现 | Mac 实现 | 复杂度 |
|---|---|---|---|
| `src-tauri/src/ip_watch.rs` | iphlpapi `NotifyAddrChange` FFI | kqueue on route socket 监听 RTM_NEWADDR/RTM_DELADDR | 🟡 中 |
| `src-tauri/src/firewall.rs` | `netsh advfirewall` + PowerShell NetSecurity | **直接 disable**，返回 `(None, None)` | 🟢 低 |
| `src-tauri/src/run_command.rs` | process-wrap `JobObject` (`start_kill`) | 验证 process-wrap 在 Mac 上自动 fallback 到 setpgid+kill(-pgid, SIGTERM) | 🟡 中 |
| `src-tauri/src/mcp/tools/shell.rs` | bash / cmd / powershell | bash / zsh / sh（已支持） | 🟢 低 |
| `desktop/src-tauri/tauri.conf.json` | NSIS only | 加 `bundle.macOS` 段 + targets `["app"]` | 🟢 低 |
| `desktop/src-tauri/icons/` | PNG only | 加 `icon.icns` | 🟢 低 |
| 前端 firewall 页面 | netsh 引导 | Mac 引导文案内联到"系统设置 → 网络 → 防火墙" | 🟢 低 |

### 3.3 构建产物

| 产物 | 命令 | 用途 |
|---|---|---|
| `.app`（`bundle/macos/`） | Tauri 自动 | 用户安装介质 |
| `.app.tar.gz` + `.sig` | Tauri 自动 | Tauri updater 用 |
| `.zip`（ditto 打包） | `ditto -c -k --sequesterRsrc --keepParent` | GitHub Release 分发 |

**架构**：单一 `universal-apple-darwin` target，**一份二进制同时覆盖 Intel + Apple Silicon**——跟 cc-switch 同款做法，避免双架构编译 + 用户下载选错。

---

## 4. 实施步骤

按依赖顺序排列，每步独立可验证：

### 步骤 1：Rust 平台分支（最高风险，必须先做）

#### 1.1 `ip_watch.rs` — 加 Mac 实现

**策略**：kqueue on route socket。BSD 传统做法，零新 crate 依赖。

**伪代码**：
```rust
#[cfg(target_os = "macos")]
mod imp {
    use std::os::unix::io::RawFd;
    use tokio::sync::mpsc;

    /// 监听 RTM_NEWADDR / RTM_DELADDR 路由消息（macOS 内核通知网卡地址变化）
    pub fn spawn(tx: mpsc::UnboundedSender<()>) {
        std::thread::spawn(move || {
            // 1. 创建路由 socket（PF_ROUTE, SOCK_RAW）
            let fd = unsafe { libc::socket(libc::PF_ROUTE, libc::SOCK_RAW, 0) };
            if fd < 0 { return; }

            // 2. kqueue 注册 EVFILT_READ
            let kq = unsafe { libc::kqueue() };
            let mut ev = libc::kevent {
                ident: fd as usize,
                filter: libc::EVFILT_READ,
                flags: libc::EV_ADD | libc::EV_CLEAR,
                fflags: 0,
                data: 0,
                udata: 0,
            };
            loop {
                unsafe { libc::kevent(kq, &mut ev, 1, &mut ev, 1, std::ptr::null()) };
                // 3. 每收到一次路由变化事件，向上层 channel 发送（上层做 600ms 防抖）
                let _ = tx.send(());
                if tx.is_closed() { break; }
            }
        });
    }
}
```

**Cargo.toml** 加 `libc = "0.2"` 到 dependencies（如果还没有）。

#### 1.2 `firewall.rs` — Mac disable

```rust
#[cfg(any(not(windows), target_os = "macos"))]
pub fn query_firewall_state(_port: u16) -> FirewallState {
    (None, None)
}

#[cfg(target_os = "macos")]
pub fn probe_available() -> bool {
    false  // Mac 上不探测，前端直接展示手动放行引导
}
```

#### 1.3 `run_command.rs` — 验证 process-wrap 跨平台

不需要改代码。先在 macos-14 runner 跑 `cargo build` 看是否成功，再跑 `cargo test` 看测试是否全绿。如果有 Mac 专属问题再加 cfg 分支。

### 步骤 2：tauri.conf.json + 图标

```json
{
  "bundle": {
    "targets": ["nsis", "app"],   // + "app"
    "icon": [
      "icons/icon.icns",            // + 新增
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png"
    ],
    "macOS": {                      // + 新增
      "minimumSystemVersion": "10.15"
    }
  }
}
```

**图标生成**（一次性）：
```bash
cd desktop
cargo tauri icon src-tauri/icons/icon.png
# 自动生成 .icns + 全套 PNG（含 macOS 圆角变体）
```

### 步骤 3：前端 Mac 分支

**位置**：`desktop/src/components/tabs/SecurityTab.tsx`（假设防火墙 UI 在这里）

```tsx
const isMac = await invoke<string>("get_platform");
// 或前端用 window.__TAURI__.os.platform()

{isMac ? (
  <div className="text-sm">
    <p>macOS 用户请手动添加 cc-bridge：</p>
    <ol>
      <li>打开 <b>系统设置 → 网络 → 防火墙</b></li>
      <li>点击「选项…」→ 找到 cc-bridge → 设为「允许传入连接」</li>
    </ol>
  </div>
) : (
  /* Windows 的一键放行按钮 */
)}
```

### 步骤 4：CI 新增 macos-14 job

在 `.github/workflows/build.yml` 加：

```yaml
build-macos:
  name: Build macOS .app (universal)
  if: startsWith(github.ref, 'refs/tags/v')
  runs-on: macos-14
  permissions:
    contents: write
  steps:
    - uses: actions/checkout@v5
    - uses: actions/setup-node@v5
      with:
        node-version: '22'
        cache: 'npm'
        cache-dependency-path: desktop/package-lock.json
    - uses: dtolnay/rust-toolchain@stable
    - uses: mozilla/sccache-action@v0.0.10
    - uses: Swatinem/rust-cache@v2
      with:
        workspaces: desktop/src-tauri
    - run: npm ci
      working-directory: desktop
    - name: cargo test (release)
      run: cargo test --release --no-default-features
      working-directory: desktop/src-tauri
    - name: Build Tauri .app（不签不公证）
      shell: bash
      run: |
        # Workaround: npm 可选原生绑定在 fresh runner 上不被装
        npm install @tauri-apps/cli-darwin-universal --no-save
        npm run prebuild
        npx tauri build --target universal-apple-darwin
      working-directory: desktop
    - name: 打包 zip
      shell: bash
      run: |
        VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
        cd desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos
        ditto -c -k --sequesterRsrc --keepParent "cc-bridge.app" \
          "../../../../../../cc-bridge_${VERSION}_macOS_universal.zip"
    - name: 收集产物 + 上传 Release
      uses: softprops/action-gh-release@v3
      with:
        files: |
          desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/*.tar.gz
          desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/*.tar.gz.sig
          cc-bridge_*.zip
        fail_on_unmatched_files: false
```

**关键点**：
- **不导入 .p12、不跑 codesign、不跑 notarytool、不跑 stapler**——按 A 方案
- `--target universal-apple-darwin` 一份 binary 覆盖 Intel + Apple Silicon
- cc-bridge 的 `predev` / `prebuild` 钩子（`sync-version.mjs` + `gen-changelog.mjs`）跟 Windows job 共用，无需修改
- cc-bridge 的 Gitee 镜像步骤**不需要在 Mac job 重复**（ghproxy/Gitee 都跨平台）

### 步骤 5：README 加 Mac 章节

```markdown
### macOS 安装（未签名 — 首次需手动绕过 Gatekeeper）

1. 在 [Releases](https://github.com/lzlkyb/cc-bridge/releases) 下载最新版的
   `cc-bridge_X.Y.Z_macOS_universal.zip`
2. 解压得到 `cc-bridge.app`，拖入 `/Applications/`
3. **首次打开**会弹"无法打开，因为它来自身份不明的开发者"——
   - 图形界面：右键 `cc-bridge.app` → 打开 → 新弹窗里点「打开」（一次性）
   - 终端：`xattr -dr com.apple.quarantine /Applications/cc-bridge.app`
4. 之后双击正常运行

> 为什么这么麻烦？因为本项目未购买 Apple Developer 账号（¥688/年），
> 没有给应用做代码签名和公证。等用户基数起来后再说。
```

### 步骤 6：CHANGELOG 占位

按规则 2，**Mac 支持不立即发版**，先写到 `## [Unreleased]`：

```markdown
## [Unreleased]

### 新增
- macOS 基础支持：可在 Intel 和 Apple Silicon 上运行，自动更新走 GitHub Releases。
  ⚠️ 未做代码签名和公证，首次打开需右键 → 打开绕过 Gatekeeper。

### 技术细节
- ip_watch 在 macOS 上用 kqueue on route socket 监听 RTM_NEWADDR/RTM_DELADDR（替换 Windows 上的 iphlpapi NotifyAddrChange）
- firewall 模块在 macOS 上 disable，改为前端引导用户在"系统设置 → 网络 → 防火墙"手动添加 cc-bridge
- CI 新增 build-macos job，universal-apple-darwin 单 target 覆盖双架构
```

---

## 5. 验证计划

### 5.1 本机验证（本环境是 Windows，能做的）

- [ ] `cargo fmt` + `cargo clippy` 在 `desktop/src-tauri/` 下零警告
- [ ] `cargo test --no-default-features` 全绿（共用现有 161 测试）
- [ ] 前端 `tsc --noEmit` 零错误
- [ ] pre-push 钩子全绿

### 5.2 CI 验证（push 后看 GitHub Actions）

- [ ] 临时 tag `v2.4.0-mac-test` 触发 build-macos job
- [ ] job 输出含 `Finished release` 且无 error
- [ ] 产物含 `.tar.gz` + `.tar.gz.sig` + `.zip`
- [ ] **删掉临时 tag**（不在 release 列表里留垃圾）

### 5.3 真机验证（必须有 Mac 设备）

- [ ] 下载 `.zip` → 解压 → 拖入 `/Applications/`
- [ ] 右键打开绕过 Gatekeeper → 应用启动
- [ ] 托盘图标显示正常
- [ ] MCP 服务能启动、监听端口
- [ ] 白名单文件浏览能跨平台（macOS 路径 `/Users/...`）
- [ ] `run_command` 跑 `echo hello` → 拿到 stdout
- [ ] `run_command` 跑 `ls -la` → bash 分发正确
- [ ] 后台命令 kill 干净（process-wrap 在 Mac 上行为符合预期）
- [ ] autostart 关闭/开启 → LaunchAgent plist 在 `~/Library/LaunchAgents/` 创建/删除
- [ ] 切换 Wi-Fi 网络 → ip_watch 事件触发 → 托盘提示新连接命令
- [ ] 防火墙诊断页 → 显示「Mac 请在系统设置手动放行」
- [ ] 自动更新检查 → GitHub Releases 拿到新版本 → 下载 + 重启

### 5.4 回滚触发

如果 Mac build 失败：
- `build-macos` job 不影响 `build-windows` job（独立 step）
- Windows 用户完全无感
- Mac job 失败 → tag 不阻塞 Windows release（CI 步骤间无依赖）

---

## 6. 工作量与时间线

| 步骤 | 估算 | 依赖 |
|---|---|---|
| 1. Rust 平台分支 | 0.5 人日 | 无 |
| 2. tauri.conf.json + 图标 | 0.1 人日 | 无 |
| 3. 前端 Mac 分支 | 0.2 人日 | 无（可并行 1） |
| 4. CI 新 job | 0.2 人日 | 1, 2 完成（要 cargo test/build 通） |
| 5. README | 0.1 人日 | 4 完成（有产物路径） |
| 6. CHANGELOG 占位 | 0.05 人日 | 无 |
| **合计** | **~1.2 人日** | — |

**建议 PR 拆分**：

| PR | 内容 | 验证 |
|---|---|---|
| PR 1 | 步骤 1 + 2 + 3 | 本地 fmt/clippy/test + Windows CI 绿 |
| PR 2 | 步骤 4（CI job） | 临时 tag 触发 → 删 tag |
| PR 3 | 步骤 5 + 6（文档） | review |

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| process-wrap 在 macOS 上 panic / 测试失败 | 🟡 中 | 高（阻塞整个 Mac 版本） | 早验证：PR 1 合后立刻在临时 Mac tag 跑 test |
| kqueue 在某 macOS 版本触发不灵敏 | 🟢 低 | 中（IP 变化检测失效） | 已有 5s 轮询兜底（main.rs main 函数内 `poll` task） |
| universal binary 编译时间 > 10 分钟 | 🟢 低 | 低（CI 慢） | 不优化，先跑通再说 |
| 用户报告 Gatekeeper 体验差劝退 | 🟡 中 | 中 | README 显眼提示 + 提供 `xattr` 命令 |
| Apple Silicon 上 Tauri WebView 性能差 | 🟢 低 | 低（不是项目能控制的） | 监控 GitHub Issues |
| Apple Developer 账号涨价 | 🟢 低 | 无（暂不签） | — |

---

## 8. 后续路线

### 8.1 短期（实施完成后）

- 收集 Mac 用户反馈（GitHub Issues / Discussions）
- 监控 macOS 各版本兼容性（10.15 / 11 / 12 / 13 / 14 / 15）
- 优化 CI 缓存减少 build 时间（universal 编译 5-8 分钟 → 3-4 分钟）

### 8.2 中期（用户基数 ≥ 50）

- **购买 Apple Developer 账号**（¥688/年）
- 申请 Developer ID Application 证书
- 加 6 个 GitHub Secrets：
  - `APPLE_CERTIFICATE`（.p12 base64）
  - `APPLE_CERTIFICATE_PASSWORD`
  - `KEYCHAIN_PASSWORD`
  - `APPLE_ID`
  - `APPLE_PASSWORD`（app-specific password）
  - `APPLE_TEAM_ID`
- `tauri.conf.json` 的 `bundle.macOS.signingIdentity` 设成从 env 读
- 改 CI job 加 codesign + notarytool + stapler 步骤（参考 cc-switch release.yml）
- README 删除「首次打开需右键绕过」段落

### 8.3 长期（用户基数 ≥ 500 + 商业需求）

- Mac App Store 上架
- 沙盒化（App Sandbox entitlement）
- notarize 自动化（已含在 8.2）

---

## 9. 参考资料

- [farion1231/cc-switch release.yml](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml) — 同款 Tauri 2 + universal-apple-darwin + 不签/全签两套做法的参考实现
- [Tauri 2 macOS 打包文档](https://v2.tauri.app/distribute/sign/macos/) — Apple 签名+公证的官方流程
- [Apple Notarization 文档](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [kqueue(2) man page](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html) — Mac 地址变化监听 API

---

**版本**：v1（草案）
**下次更新**：实施过程中遇到的新决策点