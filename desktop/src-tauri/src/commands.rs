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
/// CC 对话（Claude Code 图形客户端的数据源；名字带 `_cmds` 同 `ssh_cmds`）。
mod cc_cmds;
/// 历史对话：扫 CLI 自己的转录、列表、打开。
mod cc_history_cmds;
/// 会话内的改动还原（批 4-2）：备份清单 + 反向补丁。
mod cc_revert_cmds;
mod cc_steer_cmds;
/// 会话用量账：对话侧真实 token / 成本，按 session id 读。
mod cc_usage_cmds;
mod config_cmds;
mod firewall_cmds;
mod forward_context_cmds;
mod forward_takeover;
/// 外挂 MCP 桥（名字带 `_cmds`：`crate::mcp::bridge` 下已有同名概念）。
mod mcp_bridge_cmds;
/// 模型中转（P0 探测：保住 release 里的流式转发代码路径，见 `docs/模型中转内置方案`）。
mod relay_cmds;
mod relay_deploy_cmds;
mod relay_tunnel_cmds;
mod remote_cmds;
mod running;
mod server;
mod service_control;
/// SSH 终端（面板内交互终端，首版密码登录）。
/// SSH 批量文件传输（多源 scp 合并，按目录分组 + 临时目录原子落地）。
mod ssh_batch_cmds;
/// SSH 终端（面板内交互终端，首版密码登录）。
mod ssh_cmds;
/// SSH 远程文件读/写/本机编辑器打开（A+C 方案，复用 ssh_cmds 的 helper 与 scp 通道）。
mod ssh_file_cmds;
mod ssh_output_cmds;
/// D 方案：文件面板的内置 russh 长连接（列目录/读写/传输零握手）。
/// 旧 helper / scp 路径**保留作降级**，调用方一律先试本模块、失败自动回退。
mod ssh_russh_cmds;
/// D 方案：russh 长连接上的文件操作层（列目录/读写/传输）。
mod ssh_russh_file;
/// SSH 端口转发（-L / -R / -D）。
mod ssh_tunnel_cmds;
mod ssh_tunnel_process;
mod stable_connect_cmds;
mod stable_connect_run;
mod stable_discovery_cmds;
mod status;
mod system;
mod update;
mod update_policy;
mod update_safety;

pub use audit_cmds::*;
pub use backup_cmds::*;
pub use cc_cmds::*;
pub use cc_history_cmds::*;
pub use cc_revert_cmds::*;
pub use cc_steer_cmds::*;
pub use cc_usage_cmds::*;
pub use config_cmds::*;
pub use firewall_cmds::*;
pub use forward_context_cmds::*;
pub use mcp_bridge_cmds::*;
pub use relay_cmds::*;
pub use relay_deploy_cmds::*;
pub use relay_tunnel_cmds::*;
pub use remote_cmds::*;
pub use running::*;
pub use server::*;
pub use service_control::*;
pub use ssh_batch_cmds::*;
pub use ssh_cmds::*;
pub use ssh_file_cmds::*;
pub use ssh_output_cmds::*;
// `ssh_russh_file` 全是 pub(super)，glob 重导出不了任何东西，只声明模块即可；
// 调用方（ssh_file_cmds / ssh_cmds）用 `super::ssh_russh_file::xxx` 访问。
pub use ssh_russh_cmds::*;
pub use ssh_tunnel_cmds::*;
pub use stable_connect_cmds::*;
pub use stable_discovery_cmds::*;
pub use status::*;
pub use system::*;
pub use update::*;
pub use update_policy::*;
pub use update_safety::*;
