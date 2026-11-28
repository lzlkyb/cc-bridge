//! 界面侧异常上报。
//!
//! ## 为什么需要
//!
//! release 版没有 devtools，前端 `console.error` 等于抛进虚空。而「白屏」到底属于
//! **代码 bug**（某个渲染路径抛错）还是**渲染进程崩了**（WebView2 层），两者修法
//! 完全不同：前者要改代码，后者要动内存/重建 webview。没有前端侧的证据就只能猜。
//!
//! 所以开一条最小的通道：`window.onerror` / `unhandledrejection` / ErrorBoundary
//! 捕获到的东西，写进与后端同一份日志（见 [`crate::logging`]）。
//!
//! ## 为什么必须限流
//!
//! 渲染层出事时往往一次刷几百条（同一异常在每帧重复抛）。不限流会在几秒内把 2MB 的
//! 日志整份冲掉——恰好把最需要的「第一次出错前后」挤没了。这里按分钟给额度，超出的
//! 只计数，额度恢复后在第一条里补一句「期间丢弃 N 条」。

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 每个窗口最多写多少条。
const BUDGET: u32 = 30;

/// 额度窗口长度。
const WINDOW: Duration = Duration::from_secs(60);

/// 单字段最大长度（**字节**）。堆栈动辄上百行，截断后才能保证真正有用的头部不被滚动冲走。
const MAX_FIELD: usize = 2000;

struct Budget {
    start: Instant,
    used: u32,
    dropped: u32,
}

/// 进程级额度。`Mutex<Option<_>>` 而不是 `OnceLock`：窗口到期要整体重置。
static STATE: Mutex<Option<Budget>> = Mutex::new(None);

/// 额度判定，纯逻辑便于测试。
///
/// 返回 `Some(dropped)` 表示放行，`dropped` 是被压掉的条数（调用方补一条汇总）；
/// 返回 `None` 表示本次丢弃。
fn admit(state: &mut Option<Budget>, now: Instant) -> Option<u32> {
    let slot = state.get_or_insert(Budget {
        start: now,
        used: 0,
        dropped: 0,
    });
    // 窗口到期：重新计时，但把上一窗口压掉的条数带过来交代一次。
    // （直接清零会让「刚才丢了 5 条」永远没人知道。）
    let carried = if now.saturating_duration_since(slot.start) >= WINDOW {
        let carried = slot.dropped;
        *slot = Budget {
            start: now,
            used: 0,
            dropped: 0,
        };
        carried
    } else {
        0
    };
    if slot.used < BUDGET {
        slot.used += 1;
        // 被压掉的条数只报一次，否则每个放行条目都会重复一句同样的话。
        return Some(carried + std::mem::take(&mut slot.dropped));
    }
    slot.dropped = slot.dropped.saturating_add(1);
    None
}

/// 去掉换行与控制字符：日志是一行一条，混进换行会让上下文错位、也便于伪造。
fn sanitize(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_FIELD));
    for ch in raw.chars() {
        if out.len() >= MAX_FIELD {
            out.push_str("…（已截断）");
            break;
        }
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// 前端上报一条界面异常。
///
/// 刻意返回 `()`：上报是尽力而为，前端不该为了「日志写没写进去」再写一层错误处理。
///
/// 为什么是 `async`：同步命令在 webview 的 IPC 线程上执行，而这里要落盘 + flush。
/// 频率虽低，但磁盘偶尔会慢（机械盘、被安全软件扫），不该让界面等一次写文件。
#[tauri::command]
pub async fn report_ui_error(source: String, message: String, detail: Option<String>) {
    let source = sanitize(&source);
    let message = sanitize(&message);
    let dropped = {
        let mut guard = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
        admit(&mut guard, Instant::now())
    };
    let Some(dropped) = dropped else {
        return;
    };
    if dropped > 0 {
        log::warn!("[ui] 前一分钟内另有 {dropped} 条界面异常被限流丢弃");
        crate::logging::note_ui(
            "WARN",
            &format!("前一分钟内另有 {dropped} 条界面异常被限流丢弃"),
        );
    }
    log::error!("[ui:{source}] {message}");
    crate::logging::note_ui("ERROR", &format!("[{source}] {message}"));
    if let Some(detail) = detail {
        let detail = sanitize(&detail);
        if !detail.is_empty() {
            log::error!("[ui:{source}] {detail}");
            crate::logging::note_ui("ERROR", &format!("[{source}] {detail}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_up_to_the_budget_then_drops_and_reports_once() {
        let start = Instant::now();
        let mut state = None;
        for _ in 0..BUDGET {
            assert_eq!(admit(&mut state, start), Some(0), "额度内必须全部放行");
        }
        // 超额：只计数，不写日志。
        for _ in 0..5 {
            assert_eq!(admit(&mut state, start), None, "超额必须丢弃");
        }
        // 窗口到期后第一条要带上「刚才压掉了 5 条」。
        let later = start + WINDOW + Duration::from_secs(1);
        assert_eq!(
            admit(&mut state, later),
            Some(5),
            "额度恢复的第一条必须交代被压掉的条数"
        );
        // 交代过之后不能重复交代，否则每个放行条目都重复同一句话。
        assert_eq!(admit(&mut state, later), Some(0));
    }

    #[test]
    fn sanitize_flattens_newlines_and_caps_length() {
        assert_eq!(sanitize("a\nb\rc\td"), "a\\nb\\rc d");

        let long = "x".repeat(MAX_FIELD * 2);
        let out = sanitize(&long);
        assert!(
            out.len() <= MAX_FIELD + "…（已截断）".len(),
            "超长字段必须截断，实际 {} 字节",
            out.len()
        );
        assert!(out.ends_with("（已截断）"), "截断必须留痕");
    }

    #[test]
    fn sanitize_keeps_chinese_and_drops_control_chars() {
        assert_eq!(sanitize("渲染失败\u{0007}：空指针"), "渲染失败：空指针");
    }
}
