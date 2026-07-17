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
    /// 命令执行使用的 shell：`cmd`（默认，零外部依赖）或 `bash`（Git Bash，需安装
    /// Git for Windows）。仅影响 run_command/stop_command 的壳层；安全围栏
    /// （路径白名单/Bearer 鉴权/限流）与 shell 无关，bash 模式不削弱任何一条。
    pub shell_type: String,
    /// 后台命令结束后保留时长（秒）。默认 120（2 分钟），超时自动清理。0 表示立即清理。
    pub command_cleanup_secs: u64,
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
            shell_type: "cmd".into(),
            command_cleanup_secs: 120,
            last_selected_ip: None,
            scope: None,
        }
    }
}

/// E-P2-5: 反序列化失败时记日志，便于排查 DB 损坏等边缘情况
fn parse_or_warn<T: serde::de::DeserializeOwned>(key: &str, value: &str, fallback: T) -> T {
    serde_json::from_str(value).unwrap_or_else(|e| {
        log::warn!("配置字段「{}」反序列化失败，使用默认值：{e}", key);
        fallback
    })
}

pub fn load_config(conn: &Connection) -> Result<BridgeConfig, String> {
    let mut config = BridgeConfig::default();

    // E-P0-6: 单次 SELECT key,value FROM config 代替 22 次独立查询，启动 DB 耗时 -90%
    let mut stmt = conn
        .prepare("SELECT key, value FROM config")
        .map_err(|e| format!("查询配置失败：{e}"))?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("遍历配置失败：{e}"))?
        .filter_map(|r| r.ok())
        .collect();

    for (key, value) in &rows {
        match key.as_str() {
            "allowed_roots" => {
                let roots: Vec<String> = parse_or_warn(key, value, vec![]);
                config.allowed_roots = roots
                    .into_iter()
                    .map(|r| r.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(r))
                    .collect();
            }
            "token" => config.token = parse_or_warn(key, value, String::new()),
            "allowed_extensions" => config.allowed_extensions = parse_or_warn(key, value, vec![]),
            "max_file_size_bytes" => {
                config.max_file_size_bytes = parse_or_warn(key, value, 20_971_520u64)
            }
            "rate_limit_max_requests" => {
                config.rate_limit_max_requests = parse_or_warn(key, value, 100u32)
            }
            "rate_limit_window_ms" => {
                config.rate_limit_window_ms = parse_or_warn(key, value, 60_000u64)
            }
            "backup_dir" => {
                config.backup_dir = parse_or_warn(key, value, ".cc-bridge-backup".into())
            }
            "backup_retention" => config.backup_retention = parse_or_warn(key, value, 10u32),
            "audit_retention_days" => {
                config.audit_retention_days = parse_or_warn(key, value, 30u32)
            }
            "host" => config.host = parse_or_warn(key, value, "0.0.0.0".into()),
            "port" => config.port = parse_or_warn(key, value, 7823u16),
            "whitelist_enabled" => config.whitelist_enabled = parse_or_warn(key, value, true),
            "readonly_mode" => config.readonly_mode = parse_or_warn(key, value, false),
            "backup_enabled" => config.backup_enabled = parse_or_warn(key, value, true),
            "audit_enabled" => config.audit_enabled = parse_or_warn(key, value, true),
            "rate_limit_enabled" => config.rate_limit_enabled = parse_or_warn(key, value, true),
            "encoding_detect_enabled" => {
                config.encoding_detect_enabled = parse_or_warn(key, value, false)
            }
            "shell_enabled" => config.shell_enabled = parse_or_warn(key, value, false),
            "session_cwd_enabled" => config.session_cwd_enabled = parse_or_warn(key, value, false),
            "shell_type" => {
                let s = parse_or_warn::<String>(key, value, "cmd".into());
                // 仅接受 cmd / bash，其它值回退 cmd，避免未知壳层静默生效。
                config.shell_type = if s == "bash" {
                    "bash".into()
                } else {
                    "cmd".into()
                };
            }
            "command_cleanup_secs" => {
                config.command_cleanup_secs = parse_or_warn(key, value, 120u64)
            }
            "last_selected_ip" => config.last_selected_ip = parse_or_warn(key, value, None),
            "scope" => config.scope = parse_or_warn(key, value, None),
            _ => {}
        }
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

/// C8：一次性写回整个 BridgeConfig。供 import_config 使用，保持与 save_config 逐字段语义一致。
pub fn save_full_config(conn: &Connection, config: &BridgeConfig) -> Result<(), String> {
    use serde_json::to_value;

    // E-P1-5: 用事务包裹 22 次 INSERT，避免独立隐式事务 + fsync
    conn.execute("BEGIN", [])
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;

    save_config_field(
        conn,
        "allowed_roots",
        &to_value(&config.allowed_roots).unwrap(),
    )?;
    save_config_field(conn, "token", &to_value(&config.token).unwrap())?;
    save_config_field(
        conn,
        "allowed_extensions",
        &to_value(&config.allowed_extensions).unwrap(),
    )?;
    save_config_field(
        conn,
        "max_file_size_bytes",
        &to_value(config.max_file_size_bytes).unwrap(),
    )?;
    save_config_field(
        conn,
        "rate_limit_max_requests",
        &to_value(config.rate_limit_max_requests).unwrap(),
    )?;
    save_config_field(
        conn,
        "rate_limit_window_ms",
        &to_value(config.rate_limit_window_ms).unwrap(),
    )?;
    save_config_field(conn, "backup_dir", &to_value(&config.backup_dir).unwrap())?;
    save_config_field(
        conn,
        "backup_retention",
        &to_value(config.backup_retention).unwrap(),
    )?;
    save_config_field(
        conn,
        "audit_retention_days",
        &to_value(config.audit_retention_days).unwrap(),
    )?;
    save_config_field(conn, "host", &to_value(&config.host).unwrap())?;
    save_config_field(conn, "port", &to_value(config.port).unwrap())?;
    save_config_field(
        conn,
        "whitelist_enabled",
        &to_value(config.whitelist_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "readonly_mode",
        &to_value(config.readonly_mode).unwrap(),
    )?;
    save_config_field(
        conn,
        "backup_enabled",
        &to_value(config.backup_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "audit_enabled",
        &to_value(config.audit_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "rate_limit_enabled",
        &to_value(config.rate_limit_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "encoding_detect_enabled",
        &to_value(config.encoding_detect_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "shell_enabled",
        &to_value(config.shell_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "session_cwd_enabled",
        &to_value(config.session_cwd_enabled).unwrap(),
    )?;
    save_config_field(conn, "shell_type", &to_value(&config.shell_type).unwrap())?;

    save_config_field(
        conn,
        "command_cleanup_secs",
        &to_value(config.command_cleanup_secs).unwrap(),
    )?;

    save_config_field(
        conn,
        "last_selected_ip",
        &to_value(&config.last_selected_ip).unwrap(),
    )?;
    save_config_field(conn, "scope", &to_value(&config.scope).unwrap())?;

    conn.execute("COMMIT", [])
        .map_err(|e| format!("Failed to commit full config: {e}"))?;
    Ok(())
}
