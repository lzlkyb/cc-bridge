//! Windows 本机地址变化事件监听（事件驱动，替代 15s 轮询）。
//!
//! 用 iphlpapi 的 `NotifyAddrChange`：两个参数都传 NULL 时它是**同步阻塞**调用，
//! 一直等到本机地址列表发生变化才返回 `NO_ERROR`。纯 raw FFI，零额外 crate 依赖。
//!
//! ## 历史坑（别改回去）
//!
//! 曾用 winsock2 的 `SIO_ADDRESS_LIST_CHANGE` ioctl，并把 `-1 + WSAEFAULT(10014)`
//! 当作「地址已变化 / 有数据准备好」。实机探针测得（`wsaioctl_probe.rs`）：
//! 该调用在 `cbOutBuffer = 0` 时 **0.000ms 立即返回 WSAEFAULT**。WSAEFAULT 的真实含义
//! 是「输出缓冲区参数无效」——即 ioctl 直接失败、通知压根没挂上，而不是有事件。
//!
//! 后果是两个 bug套在一起：
//! 1. 该 `loop` 每秒空转数百万次 → 一个线程常驻 100% 单核（实测 101.3%）；
//! 2. 往 unbounded channel 狂发假事件 → 下游防抖的吸收循环永不退出 →
//!    `refresh_lan_ips` 与托盘提示从来没执行过，IP 变化检测实际上是死的。
//!
//! 所以这里除了换 API，还加了两道护栏：**非预期返回必退避**、
//! **事件频率硬限流**。即使将来通知 API 又出现「立即返回」行为，最坏也只会
//! 退化成每 200ms 一次，不会再烧掉一个核。

use std::time::Duration;

/// 两次事件之间的最小间隔（硬限流护栏，≤ 5 次/秒）。
pub const MIN_EVENT_INTERVAL: Duration = Duration::from_millis(200);

/// 通知 API 返回非预期值时的退避时长。宁可暂时失去事件能力（有 5s 轮询兜底），
/// 也绝不空转。
// 仅 Windows 版 `imp` 使用（NotifyAddrChange 返回非预期值时强制退避）；
// 非 Windows 的 `imp` 是空实现，故限定平台，否则 mac 上是 dead_code。
// 对比：MIN_EVENT_INTERVAL 是 `pub const`，pub 项不触发 dead_code，无需 cfg。
#[cfg(windows)]
const ERROR_BACKOFF: Duration = Duration::from_secs(2);

#[cfg(windows)]
mod imp {
    use std::thread;
    use std::time::Instant;
    use tokio::sync::mpsc;

    use super::{ERROR_BACKOFF, MIN_EVENT_INTERVAL};

    /// `NO_ERROR`：地址列表已变化。
    const NO_ERROR: u32 = 0;

    #[link(name = "iphlpapi")]
    extern "system" {
        /// iphlpapi `NotifyAddrChange`。两参均为 NULL 时同步阻塞，直到地址列表变化
        /// 才返回 `NO_ERROR`。不需要 handle，也不需要 overlapped。
        fn NotifyAddrChange(handle: *mut usize, overlapped: *mut u8) -> u32;
    }

    /// 启动一个阻塞线程监听本机地址变化，通过 channel 通知 async 端。
    ///
    /// 线程退出时机：`tx.send` 失败（接收端已 drop，即 app 退出或上层自愈重建）。
    /// 注意阻塞中的 `NotifyAddrChange` 无法从外部中断，因此旧线程会在下一次地址变化
    /// 时才发现 channel 已断并退出——这是可接受的：它全程阻塞不吃 CPU，进程退出时随之消亡。
    pub fn spawn(tx: mpsc::UnboundedSender<()>) {
        thread::spawn(move || {
            // 初始值减去一个间隔，使首次事件不被限流延迟。
            let mut last_event = Instant::now() - MIN_EVENT_INTERVAL;
            loop {
                // SAFETY: 两个指针参数均传 NULL（同步模式），不涉及任何缓冲区读写。
                let ret = unsafe { NotifyAddrChange(std::ptr::null_mut(), std::ptr::null_mut()) };
                if ret != NO_ERROR {
                    // 非预期返回：退避后重试。这条分支就是当年那个 bug 的直接防御——
                    // 任何「说不清的返回值」都不得当成事件，也不得立即重试。
                    thread::sleep(ERROR_BACKOFF);
                    continue;
                }
                // 硬限流：不丢事件，只把间隔拉到 MIN_EVENT_INTERVAL 以上。
                let since = last_event.elapsed();
                if since < MIN_EVENT_INTERVAL {
                    thread::sleep(MIN_EVENT_INTERVAL - since);
                }
                last_event = Instant::now();
                if tx.send(()).is_err() {
                    break;
                }
            }
        });
    }
}

#[cfg(not(windows))]
mod imp {
    use tokio::sync::mpsc;

    /// 非 Windows 平台无此能力：不启线程，地址变化完全交由上层 5s 轮询兜底。
    ///
    /// ⚠️ **对消费端的契约（别忽略）**：`_tx` 一进本函数就被 drop，所以接收端的
    /// `recv()` 会**立即且永远**返回 `None`。消费端必须把 `None` 当作“退出”处理，
    /// 否则它的 `loop` 会变成以 CPU 极限速度转的热循环。
    ///
    /// 这不是假设——`main.rs` 的消费循环曾写成 `let _ = rx.recv().await;`（丢掉 None），
    /// 于是 **mac 用户从 v2.4.0 首个 mac 版起就是 100% 单核占用**，而且每轮还去枚举一遍网卡。
    /// 与本文件头那个 Windows 的 WSAEFAULT 空转 bug 是同一类错误：
    /// **把“说不清的/表示结束的返回值”当成了事件。**
    pub fn spawn(_tx: mpsc::UnboundedSender<()>) {}
}

pub use imp::spawn;

#[cfg(test)]
mod tests {
    use super::*;

    /// 钉住「通道已关闭」与「窗口内又来了一条」的区别。
    ///
    /// 为何值得一条测试：`main.rs` 的防抖窗口曾写成
    /// `timeout(600ms, rx.recv()).await.is_ok()`——而 `timeout` 包着一个**立即完成**的
    /// future 时返回的是 `Ok(None)`，`.is_ok()` 对它是 **true**。于是“通道已关闭”
    /// 被误判成“还有事件”。这几条断言就是防止有人改回 `.is_ok()`。
    #[tokio::test]
    async fn closed_channel_is_ok_but_not_some() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        drop(tx); // 模拟非 Windows 的 spawn(_tx)：收下就丢

        let r = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await;

        assert!(
            r.is_ok(),
            "通道关闭时 timeout 返回 Ok(None)，is_ok() 必为 true——这正是那个坑"
        );
        assert!(
            !matches!(r, Ok(Some(()))),
            "通道已关闭，不得被当成收到了事件"
        );
        assert!(matches!(r, Ok(None)), "关闭后应为 Ok(None)");
    }

    /// 非 Windows 上 `spawn` 收下 sender 就 drop——消费端必须据此退出。
    /// 这条只在 mac / Linux 上跑（CI 的 macos-latest 作业会跑到）。
    #[cfg(not(windows))]
    #[tokio::test]
    async fn non_windows_spawn_closes_channel_immediately() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        spawn(tx);
        assert!(
            rx.recv().await.is_none(),
            "非 Windows 的 spawn 不启线程、不持有 sender，通道必须立即关闭"
        );
    }
}
