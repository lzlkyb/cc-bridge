//! O1 结构化耗时拆解的 I/O 计时器。
//!
//! 设计要点：每个 `tools/call` 在 `with_io_timer` 作用域内执行；各工具的
//! 关键 fs 调用处调用 [`record_io`] 累加耗时；作用域结束前（必须在内部）调用
//! [`take_io`] 取走累计值写入审计。
//!
//! 注意：`task_local` 仅在发起调用的 tokio 任务内有效。跨线程的任务（如
//! `search_files` 把 I/O 丢进 rayon 线程池）穿透不到，需改用 `Arc<AtomicU64>`
//! 累加，再回到原任务调 [`record_io`]（见 `mcp/tools/search_files.rs`）。

use std::cell::Cell;
use std::time::Duration;

use tokio::task_local;

task_local! {
    static IO_MS: Cell<u64>;
}

/// 包裹一次 `tools/call` 的整个处理，使内部所有 [`record_io`] 累加进本任务计时器。
pub async fn with_io_timer<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    IO_MS.scope(Cell::new(0), fut).await
}

/// 在工具的关键 fs 调用处调用：累加本次 I/O 耗时（毫秒）。
///
/// 若当前未处于 [`with_io_timer`] 作用域内（如单元测试直接调 handler），
/// 静默跳过而非 panic——计时是 best-effort，不应影响工具自身逻辑。
pub fn record_io(dur: Duration) {
    let _ = IO_MS.try_with(|c| c.set(c.get() + dur.as_millis() as u64));
}

/// 取走累积值并清零。必须在 [`with_io_timer`] 作用域内部调用才有意义；
/// 作用域外返回 `None`（静默跳过，不 panic）。
pub fn take_io() -> Option<u64> {
    IO_MS
        .try_with(|c| {
            let v = c.get();
            c.set(0);
            if v == 0 {
                None
            } else {
                Some(v)
            }
        })
        .unwrap_or(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn record_and_take_accumulates() {
        with_io_timer(async {
            record_io(Duration::from_millis(5));
            record_io(Duration::from_millis(3));
            assert_eq!(take_io(), Some(8));
            // take 后清零
            assert_eq!(take_io(), None);
        })
        .await;
    }

    #[tokio::test]
    async fn take_returns_none_when_zero() {
        with_io_timer(async {
            assert_eq!(take_io(), None);
        })
        .await;
    }

    #[tokio::test]
    async fn scopes_are_isolated() {
        // 作用域 A 累加 10ms
        with_io_timer(async {
            record_io(Duration::from_millis(10));
            assert_eq!(take_io(), Some(10));
        })
        .await;
        // 新作用域 B 应重新从 0 开始，不受 A 影响
        with_io_timer(async {
            assert_eq!(take_io(), None);
        })
        .await;
    }
}
