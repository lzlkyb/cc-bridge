//! 按 xterm 解析回执限流。最小化时解析可能变慢，不能把原生事件队列当无限缓冲。
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
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
            let c = guard.consumer.as_mut()?;
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
}

#[cfg(test)]
mod tests;
