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
//! | `manager.rs` | 唯一持有当前轮次的地方 + Tauri 事件出口 |
//!
//! ## 一条贯穿全模块的架构决定
//!
//! **一轮一进程 + `--resume`**，不做长驻进程。长驻在 SSH 下「连接一断整场会话就死」，
//! 而一轮一进程只死当前这一轮。代价是每轮启动开销，以及依赖 CLI 自己持久化的
//! `~/.claude/projects/<proj>/<id>.jsonl`。
//!
//! ## 与 `mcp/bridge` 的关系
//!
//! 进程封装（JobObject / CREATE_NO_WINDOW / 进程组）**复用** `mcp::bridge::spawn`，
//! 不抄第二份 —— 那些 wrap 顺序的坑（`JobObject` 会重设 creation_flags）踩一次就够了。

pub mod channel;
pub mod manager;
pub mod proto;
pub mod ring;
pub mod session;

pub use manager::{CcSession, Shared, SnapshotDto, CC_EVENT};
pub use proto::CcEvent;
pub use session::Verdict;
