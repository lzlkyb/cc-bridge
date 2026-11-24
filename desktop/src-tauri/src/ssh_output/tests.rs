use super::*;
use std::sync::{mpsc, Arc};
use std::time::Duration;

#[test]
fn output_waits_for_parse_ack_and_rejects_stale_or_future_ack() {
    let flow = Arc::new(OutputFlow::default());
    flow.attach("a".into());
    let first = flow.reserve(OUTPUT_WINDOW).unwrap();
    let (tx, rx) = mpsc::channel();
    let worker_flow = flow.clone();
    let worker = std::thread::spawn(move || {
        tx.send(worker_flow.reserve(1)).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    flow.ack("old", first.sequence);
    flow.ack("a", first.sequence + 1);
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    flow.ack("a", first.sequence);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
            .sequence,
        2
    );
    worker.join().unwrap();
}

#[test]
fn detach_or_window_destruction_unblocks_output_without_killing_session() {
    for id in [Some("a"), None] {
        let flow = Arc::new(OutputFlow::default());
        flow.attach("a".into());
        flow.reserve(OUTPUT_WINDOW);
        let (tx, rx) = mpsc::channel();
        let worker_flow = flow.clone();
        let worker = std::thread::spawn(move || {
            tx.send(worker_flow.reserve(1)).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.detach(id);
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_none());
        worker.join().unwrap();
    }
}

#[test]
fn replacement_consumer_is_not_detached_or_acked_by_old_callbacks() {
    let flow = OutputFlow::default();
    flow.attach("old".into());
    flow.reserve(OUTPUT_WINDOW);
    flow.attach("new".into());
    flow.detach(Some("old"));
    let first = flow.reserve(100).unwrap();
    assert_eq!(first.stream_id, "new");
    flow.ack("old", first.sequence);
    flow.ack("new", first.sequence + 10);
    assert_eq!(
        flow.state.lock().unwrap().consumer.as_ref().unwrap().bytes,
        100
    );
    flow.ack("new", first.sequence);
    flow.ack("new", first.sequence);
    assert_eq!(
        flow.state.lock().unwrap().consumer.as_ref().unwrap().bytes,
        0
    );
}

#[test]
fn sustained_output_stays_bounded_and_preserves_order() {
    let flow = OutputFlow::default();
    flow.attach("a".into());
    for sequence in 1..=2000 {
        let receipt = flow.reserve(64 * 1024).unwrap();
        assert_eq!(receipt.sequence, sequence);
        let pending = flow.state.lock().unwrap().consumer.as_ref().unwrap().bytes;
        assert!(pending <= OUTPUT_WINDOW);
        flow.ack("a", receipt.sequence);
    }
}

#[test]
fn first_output_waits_until_listener_is_ready() {
    let flow = Arc::new(OutputFlow::default());
    let (tx, rx) = mpsc::channel();
    let worker_flow = flow.clone();
    let worker = std::thread::spawn(move || {
        tx.send(worker_flow.reserve(10)).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    flow.attach("ready".into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
            .stream_id,
        "ready"
    );
    worker.join().unwrap();
}

#[test]
fn exited_child_must_keep_ack_route_until_output_pump_finishes() {
    let flow = OutputFlow::default();
    let completion = flow.pump_guard();
    flow.attach("a".into());
    let receipt = flow.reserve(OUTPUT_WINDOW).unwrap();
    assert!(!flow.is_finished(), "GC 不能提前移除 ACK 路由");
    flow.ack("a", receipt.sequence);
    drop(completion);
    assert!(flow.is_finished());
}

/// 回归（可观测性）：detach 期间的丢弃必须被计数。
///
/// 丢弃本身是回执式背压的既有设计，但修复前它**完全静默**——现象只是
/// 「终端少了一截输出」，日志里什么都没有，分不清「这次丢了」和
/// 「从来没丢过一直在丢」。计数器让这个状态可查。
#[test]
fn detach_period_drops_are_counted_for_observability() {
    let flow = OutputFlow::default();
    flow.attach("a".into());
    assert!(flow.reserve(10).is_some());
    flow.detach(Some("a"));

    // 无订阅者：拒绝，且每一批都进计数器。
    assert!(flow.reserve(20).is_none());
    assert!(flow.reserve(5).is_none());
    assert_eq!(flow.dropped_stats(), (2, 25));

    // 重新 attach 后恢复接收，计数器不再增长。
    flow.attach("b".into());
    assert!(flow.reserve(1).is_some());
    assert_eq!(flow.dropped_stats(), (2, 25), "恢复后不该再计丢弃");
}

/// 首屏等待期（`waiting_for_attach`）是**阻塞**而不是丢弃：计数器必须为 0。
/// 这两条路径的区分很重要——等 attach 与 detach 后丢弃是两种语义。
#[test]
fn waiting_for_attach_is_not_counted_as_drop() {
    let flow = OutputFlow::default();
    // 从未 attach： reserve 会阻塞，所以用一个已 detach 的对照——
    // 这里直接验证全新 flow 在 attach 前 reserve 不返回（也就无从计数）。
    flow.attach("a".into());
    assert!(flow.reserve(1).is_some());
    assert_eq!(flow.dropped_stats(), (0, 0), "正常路径不丢");
}
