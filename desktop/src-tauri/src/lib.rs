pub mod audit;
pub mod backup;
pub mod branding;
pub mod browse;
/// 历史对话：扫 CLI 自己的 `~/.claude/projects/*.jsonl`，把任意旧会话读回来。
pub mod cc_history;
/// CC 对话（Claude Code 图形客户端）。协议解析 / 进程 / 事件流水 / 会话管理。
pub mod cc_session;
/// 带超时的子进程输出采集（powershell / netsh 这类可能久不返回的调用必须走它）。
pub mod child_proc;
pub mod commands;
pub mod config;
pub mod connection_access;
pub mod connection_tray;
pub mod db;
pub mod diff_utils;
pub mod encoding;
pub mod firewall;
pub mod firewall_diag;
pub mod forward_ownership;
pub mod ip_watch;
/// 变更日志（开放能力）：写类工具每改一个文件追加一条 JSONL 记录。
pub mod journal;
/// 主程序日志落盘（release 下没有控制台，日志必须自己写文件）。
pub mod logging;
pub mod mcp;
pub mod network;
/// 模型中转：上游 Anthropic 请求透传（P0 阶段只有探测骨架）。
pub mod relay;
pub mod security;
/// SSH 终端密码加密（S1 凭据加密落盘）。
pub mod ssh_crypto;
pub mod ssh_helper;
pub mod ssh_output;
/// 跳板机（ProxyJump）参数拼接与两段登录的凭据派发。
pub mod ssh_proxy;
/// 端口转发：规则校验、`-L/-R/-D` 参数、`ssh -v` 输出解析。
pub mod ssh_tunnel;
mod ssh_tunnel_guard;
pub mod stable_connect;
pub mod stable_discovery;
pub mod state;
pub mod storage_maintenance;
pub mod timing;
/// 托管隧道的本地转发中继：统计双向字节，供接入卡片展示实时流量。
mod tunnel_traffic;
pub mod utf8_stream;
