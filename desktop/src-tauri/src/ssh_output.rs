//! 按 xterm 解析回执限流。最小化时解析可能变慢，不能把原生事件队列当无限缓冲。
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};

pub const OUTPUT_WINDOW: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputReceipt {
    pub stream_id: String,
    pub sequence: u64,
}

#[derive(Default)]
struct Consumer {
    id: String,
    sequence: u64,
    pending: VecDeque<(u64, usize)>,
    bytes: usize,
}

#[derive(Default)]
pub struct OutputFlow {
    state: Mutex<FlowState>,
    ready: Condvar,
    finished: AtomicBool,
    /// 无订阅者期间被丢弃的批次数 / 字节数。
    ///
    /// 丢弃是回执式背压的既有设计（detach 之后没有接收方，不可能无限缓冲），
    /// 但**静默丢弃不可观测**：现象是「终端少了一截输出」，日志里却什么都没有，
    /// 分不清「这次丢了」和「从来没丢过一直在丢」。计数器 + 限流 warn 让
    /// 「有没有在丢、丢了多少」可查。
    dropped_chunks: AtomicU64,
    dropped_bytes: AtomicU64,
}

pub struct PumpGuard<'a>(&'a OutputFlow);
impl Drop for PumpGuard<'_> {
    fn drop(&mut self) {
        self.0.finished.store(true, Ordering::Release);
    }
}

struct FlowState {
    consumer: Option<Consumer>,
    waiting_for_attach: bool,
}

impl Default for FlowState {
    fn default() -> Self {
        Self {
            consumer: None,
            waiting_for_attach: true,
        }
    }
}

impl OutputFlow {
    pub fn pump_guard(&self) -> PumpGuard<'_> {
        PumpGuard(self)
    }
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }

    pub fn attach(&self, id: String) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.waiting_for_attach = false;
        state.consumer = Some(Consumer {
            id,
            ..Default::default()
        });
        self.ready.notify_all();
    }

    /// 换订阅后旧组件的 cleanup 不能拆掉新订阅；关窗/断开则无条件解除等待。
    pub fn detach(&self, id: Option<&str>) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if id.is_none()
            || guard
                .consumer
                .as_ref()
                .is_some_and(|c| Some(c.id.as_str()) == id)
        {
            guard.consumer = None;
            guard.waiting_for_attach = false;
            self.ready.notify_all();
        }
    }

    pub fn reserve(&self, bytes: usize) -> Option<OutputReceipt> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            // 首屏也等监听器就位，避免高速输出在 attach 前绕过限流或丢失登录提示。
            if guard.waiting_for_attach {
                guard = self.ready.wait(guard).unwrap_or_else(|e| e.into_inner());
                continue;
            }
            let Some(c) = guard.consumer.as_mut() else {
                // 无订阅者（detach 之后、重新 attach 之前）：整批丢弃，但必须留痕。
                drop(guard);
                self.note_drop(bytes);
                return None;
            };
            if c.bytes + bytes <= OUTPUT_WINDOW {
                c.sequence += 1;
                c.bytes += bytes;
                c.pending.push_back((c.sequence, bytes));
                return Some(OutputReceipt {
                    stream_id: c.id.clone(),
                    sequence: c.sequence,
                });
            }
            // 不持有会话表/PTY 锁等待，ACK、断开和窗口销毁都能唤醒输出泵。
            guard = self.ready.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub fn ack(&self, id: &str, sequence: u64) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(c) = guard.consumer.as_mut() else {
            return;
        };
        if c.id != id || sequence > c.sequence {
            return;
        }
        while c.pending.front().is_some_and(|(s, _)| *s <= sequence) {
            c.bytes -= c.pending.pop_front().unwrap().1;
        }
        self.ready.notify_all();
    }

    /// 记一次「无订阅者」丢弃，并按频率限流打日志。
    ///
    /// 丢弃在长输出下是高频事件（每秒成百上千批），逐条 warn 会把日志盘写满。
    /// 首条必打（那是「开始丢」的信号），之后每 1000 批报一次进度——
    /// 要回答的是「有没有在丢、总量多少」，不是每一批。
    fn note_drop(&self, bytes: usize) {
        let chunks = self.dropped_chunks.fetch_add(1, Ordering::Relaxed) + 1;
        let total = self
            .dropped_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed)
            + bytes as u64;
        if chunks == 1 || chunks.is_multiple_of(1000) {
            ::log::warn!(
                "终端输出流：无订阅者期间已丢弃 {chunks} 批、共 {total} 字节\
                 （detach 之后未重新 attach，输出泵仍在写入）"
            );
        }
    }

    /// 丢弃统计（批次数, 字节数）。测试与排障用。
    pub fn dropped_stats(&self) -> (u64, u64) {
        (
            self.dropped_chunks.load(Ordering::Relaxed),
            self.dropped_bytes.load(Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests;
