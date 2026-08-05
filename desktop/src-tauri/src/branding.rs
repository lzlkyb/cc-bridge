//! 应用名的单一来源（显示层）。
//!
//! 为何需要这个文件：此前「cc-bridge」与「CC Bridge」两种写法在代码里各处硬编码、
//! 互不知情——界面顶部大标题写 `CC Bridge`，而托盘 tooltip、桌面通知标题、窗口标题
//! 写 `cc-bridge`，同一个应用两个名字。
//!
//! 名字分两层，边界必须清楚：
//!
//! - **显示层**（就是本文件）——只用于给人看的文案：托盘 tooltip、桌面通知标题、
//!   窗口标题（本应用 `decorations: false` 没有标题栏，但 Alt+Tab 与任务栏悬浮仍会显示它）。
//!
//! - **标识层**——仍是 `cc-bridge`，**不要动**。它决定 `productName`（进而决定安装目录、
//!   exe 名、开始菜单条目、mac `.app` 名与菜单栏名）、bundle identifier、Cargo/npm 包名、
//!   防火墙规则名、备份目录名、数据库文件名，以及 MCP 协议里的 `serverInfo.name`
//!   （远程执行 `claude mcp add cc-bridge` 用的就是它）。
//!
//! 为何不把 `productName` 一起改成 `CC Bridge` 图个彻底统一：那会把安装目录从
//! `cc-bridge\` 变成 `CC Bridge\`，而 NSIS 钩子里的防火墙放行规则是按
//! `$INSTDIR\cc-bridge.exe` 写死的（见 installer-hooks.nsh）——老用户升级后规则指向
//! 一个不存在的路径，防火墙不再放行，远程直接连不上。为了大小写付这个代价不值。
//!
//! 前端那侧对应 `src/lib/about.ts` 的 `APP_INFO.name`，是同一个字符串的第二份维护
//! （前端拿不到 Rust 常量，只能各存一份）。改这里请同步改那边。
pub const APP_DISPLAY_NAME: &str = "CC Bridge";

/// 托盘 tooltip 的三条文案。
///
/// 为何写成完整字面量、而不是在调用处 `format!("{APP_DISPLAY_NAME} · 服务运行中")`：
/// 调用处是 `if/else` 直接产出 `&str` 交给 `set_tooltip`，改成 `String` 会牵动
/// `refresh_tray` 的签名与三处所有权。收在这里已经达到「一处修改」的目的。
///
/// 注意：这几条里各自嵌着显示名，改 `APP_DISPLAY_NAME` 时编译器不会提醒你改它们。
pub const TRAY_TIP_RUNNING: &str = "CC Bridge · 服务运行中";
pub const TRAY_TIP_STOPPED: &str = "CC Bridge · 已停止";
pub const TRAY_TIP_IP_CHANGED: &str = "CC Bridge: 网络地址已变化，点击查看新连接命令";
