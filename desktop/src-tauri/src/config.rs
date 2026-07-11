use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub allowed_roots: Vec<String>,
    pub token: String,
    pub allowed_extensions: Vec<String>,
    pub max_file_size_bytes: u64,
    pub rate_limit_max_requests: u32,
    pub rate_limit_window_ms: u64,
    pub backup_dir: String,
    pub backup_retention: u32,
    pub audit_retention_days: u32,
    pub host: String,
    pub port: u16,
    // ── 功能开关（v2.1）默认值保持 v2.0 行为，即安全约束全部生效 ──
    pub whitelist_enabled: bool,
    pub readonly_mode: bool,
    pub backup_enabled: bool,
    pub audit_enabled: bool,
    pub rate_limit_enabled: bool,
    /// read_files 编码自适应（GBK/GB18030 启发式探测）。默认关：关时按 UTF-8 读，
    /// 避免启发式误判；显式 `encoding` 参数不受此开关影响，始终优先。
    pub encoding_detect_enabled: bool,
    /// 命令执行（run_command/stop_command）总开关。默认关闭——开启等同于授予
    /// 远程调用方任意代码执行权限（RCE）；只读模式开启时对 run_command 无条件覆盖为禁止。
    pub shell_enabled: bool,
    /// 会话级 cwd 持久化（run_command 的 session_id handle）。默认关闭——开启后客户端可
    /// 在首次提供 cwd 时拿到 session_id，后续调用只传 session_id 即可沿用工作目录。每次使用
    /// 前仍重校验白名单（规则 7 不削弱）。关闭时 run_command 行为与旧版完全一致。
    pub session_cwd_enabled: bool,
    /// 用户上次在 Connect 页确认使用的本机 IP（多网卡场景）。用于检测网卡地址是否
    /// 发生变化（VPN 重连等）——不在 get_lan_ips() 结果里就说明已失效，需要提示用户换新地址。
    pub last_selected_ip: Option<String>,
    /// 用户上次在 Connect 页确认接入时使用的作用域（user=全局 ~/.claude.json / project=项目 .mcp.json）。
    /// 用于 IP 变化 / Token 重生成时生成精确匹配该作用域的 sed 命令，避免误改其它文件。
    /// None 表示旧数据从未落盘，此时前端兜底展示两条命令让用户自选。
    pub scope: Option<String>,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            allowed_roots: vec![],
            token: String::new(),
            allowed_extensions: vec![
                ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".py", ".java", ".go",
                ".rs", ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".yml",
                ".yaml", ".toml", ".ini", ".md", ".txt", ".html", ".css", ".scss", ".sql", ".xml",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            max_file_size_bytes: 20_971_520,
            rate_limit_max_requests: 100,
            rate_limit_window_ms: 60_000,
            backup_dir: ".cc-bridge-backup".into(),
            backup_retention: 10,
            audit_retention_days: 30,
            host: "0.0.0.0".into(),
            port: 7823,
            whitelist_enabled: true,
            readonly_mode: false,
            backup_enabled: true,
            audit_enabled: true,
            rate_limit_enabled: true,
            encoding_detect_enabled: false,
            shell_enabled: false,
            session_cwd_enabled: false,
            last_selected_ip: None,
            scope: None,
        }
    }
}

pub fn load_config(conn: &Connection) -> Result<BridgeConfig, String> {
    let mut config = BridgeConfig::default();

    if let Some(v) = db::get_config_value(conn, "allowed_roots") {
        let roots: Vec<String> = serde_json::from_str(&v).unwrap_or_default();
        // 兼容旧数据：剥掉早期 canonicalize 写入的 \\?\ 前缀，纯展示层归一化，匹配不受影响。
        config.allowed_roots = roots
            .into_iter()
            .map(|r| r.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(r))
            .collect();
    }
    if let Some(v) = db::get_config_value(conn, "token") {
        config.token = serde_json::from_str(&v).unwrap_or_default();
    }
    if let Some(v) = db::get_config_value(conn, "allowed_extensions") {
        config.allowed_extensions = serde_json::from_str(&v).unwrap_or_default();
    }
    if let Some(v) = db::get_config_value(conn, "max_file_size_bytes") {
        config.max_file_size_bytes = serde_json::from_str(&v).unwrap_or(20_971_520);
    }
    if let Some(v) = db::get_config_value(conn, "rate_limit_max_requests") {
        config.rate_limit_max_requests = serde_json::from_str(&v).unwrap_or(100);
    }
    if let Some(v) = db::get_config_value(conn, "rate_limit_window_ms") {
        config.rate_limit_window_ms = serde_json::from_str(&v).unwrap_or(60_000);
    }
    if let Some(v) = db::get_config_value(conn, "backup_dir") {
        config.backup_dir = serde_json::from_str(&v).unwrap_or_else(|_| ".cc-bridge-backup".into());
    }
    if let Some(v) = db::get_config_value(conn, "backup_retention") {
        config.backup_retention = serde_json::from_str(&v).unwrap_or(10);
    }
    if let Some(v) = db::get_config_value(conn, "audit_retention_days") {
        config.audit_retention_days = serde_json::from_str(&v).unwrap_or(30);
    }
    if let Some(v) = db::get_config_value(conn, "host") {
        config.host = serde_json::from_str(&v).unwrap_or_else(|_| "0.0.0.0".into());
    }
    if let Some(v) = db::get_config_value(conn, "port") {
        config.port = serde_json::from_str(&v).unwrap_or(7823);
    }
    // 功能开关：缺省沿用默认（安全约束全开），旧数据库无此键时回退到 default。
    if let Some(v) = db::get_config_value(conn, "whitelist_enabled") {
        config.whitelist_enabled = serde_json::from_str(&v).unwrap_or(true);
    }
    if let Some(v) = db::get_config_value(conn, "readonly_mode") {
        config.readonly_mode = serde_json::from_str(&v).unwrap_or(false);
    }
    if let Some(v) = db::get_config_value(conn, "backup_enabled") {
        config.backup_enabled = serde_json::from_str(&v).unwrap_or(true);
    }
    if let Some(v) = db::get_config_value(conn, "audit_enabled") {
        config.audit_enabled = serde_json::from_str(&v).unwrap_or(true);
    }
    if let Some(v) = db::get_config_value(conn, "rate_limit_enabled") {
        config.rate_limit_enabled = serde_json::from_str(&v).unwrap_or(true);
    }
    if let Some(v) = db::get_config_value(conn, "encoding_detect_enabled") {
        config.encoding_detect_enabled = serde_json::from_str(&v).unwrap_or(false);
    }
    if let Some(v) = db::get_config_value(conn, "shell_enabled") {
        config.shell_enabled = serde_json::from_str(&v).unwrap_or(false);
    }
    if let Some(v) = db::get_config_value(conn, "session_cwd_enabled") {
        config.session_cwd_enabled = serde_json::from_str(&v).unwrap_or(false);
    }
    if let Some(v) = db::get_config_value(conn, "last_selected_ip") {
        config.last_selected_ip = serde_json::from_str(&v).unwrap_or(None);
    }
    if let Some(v) = db::get_config_value(conn, "scope") {
        config.scope = serde_json::from_str(&v).unwrap_or(None);
    }

    Ok(config)
}

pub fn save_config_field(
    conn: &Connection,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let value_str =
        serde_json::to_string(value).map_err(|e| format!("Failed to serialize: {e}"))?;
    db::set_config_value(conn, key, &value_str)
}
