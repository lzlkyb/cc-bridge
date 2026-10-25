//! CC 对话功能：把 `claude` CLI 的 stream-json 协议接成界面的数据源。
//!
//! ## 模块划分
//!
//! | 文件 | 职责 |
//! |---|---|
//! | `proto.rs` | NDJSON 一行 → 归一化 `CcEvent`。**纯函数**，可用录制样本回归 |
//! | `channel.rs` | 「在哪跑、跑什么」→ 一条可执行命令（本机直跑 / SSH base64 引导） |
//! | `session.rs` | 一轮进程的生死、stdin 写入、stdout 泵 |
//! | `ring.rs` | 事件流水（切页回来 / 断线重连靠它重放） |
//! | `store.rs` | 会话落盘（关掉 app 再打开还能看到上次那条） |
//! | `usage.rs` | 会话用量账（`modelUsage` 累计值按 session id 落库） |
//! | `manager.rs` | 唯一持有当前轮次的地方 + Tauri 事件出口 |
//! | `autoapprove.rs` | 审批自动放行规则匹配（**纯函数**，命中才代替用户回 allow） |
//!
//! ## 一条贯穿全模块的架构决定
//!
//! **一个进程跑多轮，进程死了才 `--resume`**。
//!
//! 上游的说法是「一轮一进程」，P0 探针（2026-10-24）推翻了：CLI 收到 `result`
//! 后不会退出，它继续等 stdin。所以复用是常态、重启是兜底 ——
//! 判据细节见 `session.rs` 模块文档与 `manager::snapshot_running`。
//!
//! 依赖 CLI 自己持久化的 `~/.claude/projects/<proj>/<id>.jsonl` 做跨进程续接
//! （红线：不改它）；我们自己的 `cc_sessions` 只存界面需要的事件快照。
//!
//! ## 与 `mcp/bridge` 的关系
//!
//! 进程封装（JobObject / CREATE_NO_WINDOW / 进程组）**复用** `mcp::bridge::spawn`，
//! 不抄第二份 —— 那些 wrap 顺序的坑（`JobObject` 会重设 creation_flags）踩一次就够了。

pub mod autoapprove;
pub mod channel;
pub mod context_tax;
pub mod manager;
pub mod proto;
pub mod ring;
pub mod session;
pub mod store;
pub mod usage;

pub use manager::{CcSession, CcSessions, Shared, SnapshotDto, CC_EVENT};
pub use proto::CcEvent;
pub use session::Verdict;
pub use store::SessionFacts;
