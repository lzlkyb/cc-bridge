//! 前端 → 后端的 Tauri IPC 命令层。**本文件只做聚合，不含任何实现。**
//!
//! D19 拆分完成（方案 C，四批增量，每批一个 commit）：立项时 1556 行，动手时已长到
//! 2700 行 / 42 个命令，8 类关注点混在一处。现按域拆成下面 9 个子模块。
//!
//! ## 为什么用 `pub use` 而不是让调用方写全路径
//!
//! `main.rs` 的 `invoke_handler![...]` 列了 42 项 `commands::xxx`。靠这里的 `pub use`
//! 重导出，那 42 行**一个字都不用改**——拆分是内部结构调整，不该让调用方感知。
//! 这也是整轮重构唯一的硬约束：`main.rs` 全程零改动。
//!
//! ## 命名为什么带 `_cmds` 后缀
//!
//! `backup` / `firewall` / `audit` / `config` 这四个名字在 crate 根下**已经被占了**
//! （`src/backup.rs` 等），而各子模块内部又要 `use crate::backup;` 之类。子模块同名会
//! 与之冲突，所以带 `_cmds` 后缀区分「IPC 命令层」与「实现层」。
//! `status` / `server` / `system` / `running` / `update` 无冲突，保持原名。
//!
//! ## 等价性怎么保证
//!
//! 四批全是**纯搬动**：函数体逐字节未改。校验用 `tools/fingerprint.py`——它按「列 0 的
//! 顶层项」切块算 md5，搬动只改变块所在文件与顺序、不改内容，所以哈希集合必须逐字相同。
//! 这比跑测试可靠：`commands.rs` 原本只有 2 条测试（覆盖 42 个命令中的 2 个），
//! 「`cargo test` 全绿」根本证明不了命令没坏。

mod audit_cmds;
mod backup_cmds;
mod config_cmds;
mod firewall_cmds;
/// 外挂 MCP 桥（名字带 `_cmds`：`crate::mcp::bridge` 下已有同名概念）。
mod mcp_bridge_cmds;
mod running;
mod server;
mod status;
mod system;
mod update;

pub use audit_cmds::*;
pub use backup_cmds::*;
pub use config_cmds::*;
pub use firewall_cmds::*;
pub use mcp_bridge_cmds::*;
pub use running::*;
pub use server::*;
pub use status::*;
pub use system::*;
pub use update::*;
