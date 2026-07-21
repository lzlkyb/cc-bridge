# RFC：托盘图标闪烁修复（根因 B — 网络地址变化风暴）

> 状态：✅ 已实现（2026-07-21，质量门全过：clippy --no-default-features 零警告 + cargo test 110 单测 + 4 集成 0 失败）。未提交（规则 5）。
> 实施细化：`tray_icon()` 实为 `OnceLock` 缓存两个位图（非每次重建），故闪烁主因是重复调用 `set_icon` 本身；去重方案依然对症。三处调用点已全部走 `refresh_tray`，外部冗余 watcher 已移除，地址变化循环已加 600ms 防抖。
> 约束：Rust 后端改动；改动后须 `cargo fmt` + `cargo clippy --no-default-features` 零警告 + `cargo test` 通过（规则 7）；不自动 commit（规则 5）。
> 关联：用户反馈「托盘图标一直在闪」。诊断结论为根因 **B**——网络地址变化风暴驱动托盘高频重绘（非服务反复启停）。

## 一句话结论

闪烁不是动画 bug，而是 `main.rs` 里三处托盘刷新**无条件** `set_icon`/`set_tooltip`，在网卡高频变化（Wi-Fi 重连 / VPN 抖动 / DHCP 续租 / 双网卡）时反复重设图标位图所致。修复 = **托盘状态刷新去重**（核心，消灭同状态重复重绘）+ **IP watch 防抖**（合并 600ms 内的连续抖动）+ 顺手移除一处冗余 watcher。

## 现状与根因

托盘只有两种图标（运行绿 / 停止灰，由 `mcp_running` 决定），无闪烁动画。刷新逻辑共三处，**全部无条件执行**：

- `main.rs:453` 启动后初始刷新（一次，无害，但无 tooltip）。
- `main.rs:467-472` 监听 `mcp-status-changed` 事件 → 每次都 `set_icon` + `set_tooltip`。
- `main.rs:509-521` 「本机地址变化检测」循环 → **每次收到 OS 通知都 `set_icon` + `set_tooltip`**（闪烁主因）。

`ip_watch.rs` 本身是正确事件驱动（`WSAIoctl` 内核态阻塞等待，真实地址变化才通知，无变化不通知），不会自己产生风暴；但用户网络环境高频变化时，通知会频繁到达，而 `main.rs` 循环对每次通知都重设图标——`tray_icon()` 每次重新生成位图，Windows 托盘在高频 `set_icon`（即使同图）下表现为可见闪烁。

前端已确认无任何自动 start/stop 循环（`start_mcp_server` 等全是用户点击触发；`App.tsx` 的 `LinkStateWatcher` 只弹 Toast、不重启服务），排除根因 A（服务反复启停）。

## 设计

### 1. 托盘刷新去重（核心修复）

引入一个跨三处闭包共享的 `last_tray` 缓存，封装 `refresh_tray()` helper：仅当 `running` 或 `tip` 文本**真正变化**时才 `set_icon`/`set_tooltip`，否则跳过。

setup 闭包内、`tray` 构建前构造（紧接 `app_state` 取得之后）：

```rust
let last_tray = std::sync::Arc::new(std::sync::Mutex::new((false, String::new())));
```

模块级 helper（放在 `tray_icon()` 附近）：

```rust
/// 托盘状态刷新（带去重）：仅当 running 或 tooltip 文本真正变化时才重设图标/tooltip。
/// 消除网络抖动导致的高频 set_icon 在 Windows 上表现为的图标闪烁。
fn refresh_tray(
    tray: &tauri::tray::TrayIcon,
    running: bool,
    tip: &str,
    last: &std::sync::Arc<std::sync::Mutex<(bool, String)>>,
) {
    let mut g = last.lock().unwrap();
    if g.0 == running && g.1 == tip {
        return; // 无变化，跳过重设（防高频重绘闪烁）
    }
    let _ = tray.set_icon(Some(tray_icon(running)));
    let _ = tray.set_tooltip(Some(tip));
    *g = (running, tip.to_string());
}
```

> 临界区极短（比较 + set，不跨 `.await`），用 `std::sync::Mutex` 足够，无需引 `parking_lot`；`Arc` 闭包间 `clone()` 共享。

### 2. 三处调用点改造

**初始刷新（原 449-454）：**

```rust
if let Some(tray) = app.handle().tray_by_id("main-tray") {
    let running = app_state.mcp_running.load(std::sync::atomic::Ordering::Relaxed);
    refresh_tray(
        tray,
        running,
        if running { "cc-bridge · 服务运行中" } else { "cc-bridge · 已停止" },
        &last_tray,
    );
}
```

**状态事件监听（原 459-475）：** 闭包开头加 `let last_tray = last_tray.clone();`（因 `move`），循环体改为：

```rust
if let Some(tray) = h.tray_by_id("main-tray") {
    let tip = if running { "cc-bridge · 服务运行中" } else { "cc-bridge · 已停止" };
    refresh_tray(tray, running, tip, &last_tray);
}
```

**地址变化循环（原 509-521）：** 闭包开头加 `let last_tray = last_tray.clone();`，循环体改为：

```rust
if let Some(tray) = handle.tray_by_id("main-tray") {
    let tip = if changed {
        "cc-bridge: 网络地址已变化，点击查看新连接命令"
    } else if running {
        "cc-bridge · 服务运行中"
    } else {
        "cc-bridge · 已停止"
    };
    refresh_tray(tray, running, tip, &last_tray);
}
```

### 3. IP watch 防抖（合并风暴）

原 `let _ = rx.recv().await;`（原 497）改为 600ms 固定窗口防抖，合并连续抖动、降低重扫网卡频率：

```rust
loop {
    // 防抖：收到首个地址变化通知后，在 600ms 窗口内合并后续通知，只处理一次。
    let _ = rx.recv().await;
    while tokio::time::timeout(std::time::Duration::from_millis(600), rx.recv())
        .await
        .is_ok()
    {
        // 窗口内仍有变化，继续吸收（合并网络抖动）
    }
    // —— 以下为原处理（refresh_lan_ips / changed 判断 / refresh_tray / 通知）——
    let ips = watch_state.refresh_lan_ips();
    // ...（unchanged）
}
```

> 与去重互补：去重消灭「同状态重复 set」，防抖消灭「风暴期间的无效重扫与状态抖动」。`changed` 若在窗口内反复跳，防抖合并到一次处理、以最终状态为准，闪烁大幅降低。

### 4. 附带清理（建议）

`main.rs:485-486` 在循环外有一段冗余 `spawn_ip_watch`（`(tx, _rx)` 中 `_rx` 被丢弃，通知永不被消费，等于僵尸 watcher 线程 + 占一个 socket）。真正的 watcher 在循环内 `491-492` 已 spawn。建议移除外部这段（含其注释），避免僵尸 watcher。

```rust
// 删除这两行（及上方说明注释）：
// let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
// let _watcher_socket = crate::ip_watch::spawn(tx);
```

## 测试

- 既有托盘逻辑无专门单测（依赖 OS 托盘），以 `cargo test` 全量不退化为准（无新增可单测单元；helper 纯逻辑，可加一个最小 `#[cfg(test)]` 验证去重：构造假 tray mock 不便，故以编译 + clippy 零警告 + 现有测试全过覆盖）。
- 手动验证（用户侧 / dev 环境）：制造网络抖动（开关 Wi-Fi / 连断 VPN），观察托盘不再持续闪烁；tooltip 在稳定后停于「服务运行中」；地址真变化仍弹一次通知。

## 成本与风险

- **成本**：低（约 30 行改造 + 1 个 helper，零新依赖）。
- **风险**：低。
  - `Mutex` 临界区不跨 `.await`，无死锁风险；`Arc<Mutex<(bool,String)>>` 跨闭包共享安全。
  - 去重不改变「状态真变时必刷新」语义——初始态 `(false,"")` 保证首次必 set，不遗漏。
  - 防抖 600ms 窗口对「地址真变化需及时提示」影响可忽略（用户感知阈值 > 600ms）。
  - 移除外部冗余 watcher 不影响主 watcher（循环内已重建）。

## 落地顺序

1. 加 `last_tray` + `refresh_tray` helper（含模块级函数）。
2. 改三处调用点走 `refresh_tray`，各自 `clone()` 共享 `last_tray`。
3. 地址变化循环加 600ms 防抖。
4. 移除外部冗余 `spawn_ip_watch`。
5. `cargo fmt` + `cargo clippy --no-default-features` + `cargo test` → 零警告、全过。
6. 合一个 `fix:` commit（规则 5 待用户确认提交）。
