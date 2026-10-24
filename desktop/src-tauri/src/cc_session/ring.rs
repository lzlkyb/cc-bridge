//! 事件环形缓冲：让「切页回来」不丢内容。
//!
//! ## 为什么要它
//!
//! `App.tsx` 的 `TabsContent value="ccgui"` 没有 `keepMounted`（终端页有），切走
//! 组件就卸载，React 里那份消息列表随之蒸发。而进程和 session_id 在 Rust 侧活着 ——
//! 所以只要 Rust 留一份**事件流水**，前端回来时重放就能把界面原样拼出来。
//!
//! 这也顺带解决第二件事：**SSH 断线重连**。连接断掉时前端收不到任何东西，
//! 重连后同样靠重放接上。
//!
//! ## 为什么是「事件」而不是「渲染后的消息列表」
//!
//! 渲染后的列表是前端格式，存进 Rust 就得在 Rust 里再写一套 UI 模型，两边必然漂移。
//! 存事件则前端 reducer 只有一份逻辑：**实时收到的**和**重放的**走同一条路径，
//! 不存在「重连后长得不一样」这类只有用户能发现的 bug。
//!
//! ## 有上限，且上限会说实话
//!
//! 一轮对话几千条事件很正常（流式碎片）。超过 `capacity` 就丢最老的，并置
//! `dropped`。**不能静默丢**：丢了就意味着重放出来的界面缺开头，得让前端知道
//! 「这里有洞」，而不是假装完整。

use std::collections::VecDeque;
use std::sync::Mutex;

use super::proto::CcEvent;

/// 默认容量。一轮 200 条工具调用 × 每条 3~6 个事件 ≈ 1200，留 3 倍余量。
pub const DEFAULT_CAPACITY: usize = 4096;

#[derive(Default)]
struct Inner {
    /// 下一个事件的序号（从 0 开始）。前端拿它做增量游标。
    next_seq: u64,
    /// 丢了多少个最老的事件。`> 0` 表示重放不完整。
    dropped: u64,
    items: VecDeque<CcEvent>,
}

/// 线程安全的事件流水。
pub struct EventRing {
    capacity: usize,
    inner: Mutex<Inner>,
}

/// 一次快照：重放所需的一切。
#[derive(Debug, Clone)]
pub struct RingSnapshot {
    /// 已缓冲的事件，按发生顺序。
    pub events: Vec<CcEvent>,
    /// 下一个事件的序号。前端订阅时带上它，用来发现漏收。
    pub next_seq: u64,
    /// 被丢掉的老事件数。`> 0` ⇒ 界面开头缺内容，必须提示。
    pub dropped: u64,
}

impl EventRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            inner: Mutex::new(Inner::default()),
        }
    }

    /// 记一条，返回它的序号。
    ///
    /// 锁中毒时返回 `None` 而**不 panic**：这只是历史回放，丢一条比把整个
    /// 对话进程带崩要好得多。
    pub fn push(&self, event: CcEvent) -> Option<u64> {
        let mut inner = self.inner.lock().ok()?;
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.items.push_back(event);
        while inner.items.len() > self.capacity {
            inner.items.pop_front();
            inner.dropped += 1;
        }
        Some(seq)
    }

    /// 全量快照，用于「切页回来 / 重连」。
    pub fn snapshot(&self) -> RingSnapshot {
        let Ok(inner) = self.inner.lock() else {
            return RingSnapshot {
                events: Vec::new(),
                next_seq: 0,
                dropped: 0,
            };
        };
        RingSnapshot {
            events: inner.items.iter().cloned().collect(),
            next_seq: inner.next_seq,
            dropped: inner.dropped,
        }
    }

    /// 只取 `since` 之后的事件。前端已经有一份状态时用它做补漏。
    ///
    /// `dropped` 的语义在这里比 `snapshot` 窄：**指调用方缺了多少条**。
    /// 前端游标落在窗口之前（`since < base`）时，`[since, base)` 那段已经滚掉了，
    /// 缺的条数就是 `base - since`；游标在窗口内则一条不缺。
    pub fn since(&self, since: u64) -> RingSnapshot {
        let Ok(inner) = self.inner.lock() else {
            return RingSnapshot {
                events: Vec::new(),
                next_seq: 0,
                dropped: 0,
            };
        };
        let base = inner.next_seq - inner.items.len() as u64;
        let skip = since.saturating_sub(base) as usize;
        RingSnapshot {
            events: inner.items.iter().skip(skip).cloned().collect(),
            next_seq: inner.next_seq,
            dropped: base.saturating_sub(since),
        }
    }

    pub fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            *inner = Inner::default();
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|i| i.items.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for EventRing {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit(code: i32) -> CcEvent {
        CcEvent::Exit { code: Some(code) }
    }

    fn code_of(e: &CcEvent) -> i32 {
        match e {
            CcEvent::Exit { code } => code.unwrap_or(-1),
            other => panic!("不是 Exit：{other:?}"),
        }
    }

    #[test]
    fn seq_starts_at_zero_and_increments() {
        let ring = EventRing::new(8);
        assert_eq!(ring.push(exit(1)), Some(0));
        assert_eq!(ring.push(exit(2)), Some(1));
    }

    /// 超容量丢最老的，并且**说实话**。
    #[test]
    fn overflow_drops_oldest_and_reports() {
        let ring = EventRing::new(3);
        for i in 0..5 {
            ring.push(exit(i));
        }
        let snap = ring.snapshot();
        let codes: Vec<i32> = snap.events.iter().map(code_of).collect();
        assert_eq!(codes, vec![2, 3, 4], "应只剩后三条");
        assert_eq!(snap.dropped, 2, "丢了 2 条必须报出来");
        assert_eq!(snap.next_seq, 5, "序号是单调的，不受丢弃影响");
    }

    #[test]
    fn since_returns_only_newer() {
        let ring = EventRing::new(8);
        for i in 0..4 {
            ring.push(exit(i));
        }
        let snap = ring.since(2);
        let codes: Vec<i32> = snap.events.iter().map(code_of).collect();
        assert_eq!(codes, vec![2, 3]);
        assert_eq!(snap.dropped, 0);
    }

    /// `since` 早于缓冲区起点（那段时间被丢了）⇒ 必须报洞。
    #[test]
    fn since_behind_window_reports_gap() {
        let ring = EventRing::new(3);
        for i in 0..10 {
            ring.push(exit(i));
        }
        let snap = ring.since(0);
        assert_eq!(snap.events.len(), 3);
        assert!(snap.dropped > 0, "落进已丢弃区间必须报洞：{snap:?}");
    }

    /// `since` 在未来（前端游标比 Rust 大）不能 panic，也不能回吐旧数据。
    #[test]
    fn since_beyond_head_is_empty() {
        let ring = EventRing::new(8);
        ring.push(exit(1));
        let snap = ring.since(99);
        assert!(snap.events.is_empty(), "{snap:?}");
    }

    #[test]
    fn clear_resets_everything() {
        let ring = EventRing::new(8);
        ring.push(exit(1));
        ring.clear();
        let snap = ring.snapshot();
        assert!(snap.events.is_empty());
        assert_eq!(snap.next_seq, 0);
        assert_eq!(snap.dropped, 0);
        assert_eq!(ring.push(exit(9)), Some(0), "clear 后序号从头开始");
    }

    /// 容量 0 也要能活（构造时钳到 1）。
    #[test]
    fn zero_capacity_is_clamped() {
        let ring = EventRing::new(0);
        ring.push(exit(1));
        ring.push(exit(2));
        let snap = ring.snapshot();
        assert_eq!(snap.events.len(), 1);
        assert_eq!(code_of(&snap.events[0]), 2);
    }
}
