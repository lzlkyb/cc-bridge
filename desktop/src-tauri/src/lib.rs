pub mod audit;
pub mod backup;
pub mod branding;
pub mod browse;
/// 历史对话：扫 CLI 自己的 `~/.claude/projects/*.jsonl`，把任意旧会话读回来。
pub mod cc_history;
/// CC 对话（Claude Code 图形客户端）。协议解析 / 进程 / 事件流水 / 会话管理。
pub mod cc_session;
pub mod commands;
pub mod config;
pub mod db;
pub mod diff_utils;
pub mod encoding;
pub mod firewall;
pub mod firewall_diag;
pub mod ip_watch;
pub mod mcp;
pub mod network;
pub mod security;
/// SSH 终端密码加密（S1 凭据加密落盘）。
pub mod ssh_crypto;
pub mod ssh_helper;
/// 跳板机（ProxyJump）参数拼接与两段登录的凭据派发。
pub mod ssh_proxy;
pub mod state;
pub mod timing;
pub mod utf8_stream;
