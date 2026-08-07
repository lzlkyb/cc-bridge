use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db;

/// 一个白名单「配置组」（按项目切换用）。只是**存档**：当前生效的集合永远是
/// `BridgeConfig::allowed_roots`，组不参与任何路径校验。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootProfile {
    pub name: String,
    pub roots: Vec<String>,
}

/// 隐式迁移时合成的组名（老配置库升级路径）。
pub const DEFAULT_PROFILE_NAME: &str = "默认";

/// 容器级 `serde(default)` 是**兼容历史**的关键：`import_config` 直接把 JSON
/// 反序列化成本结构体，而本结构体历史上一直在加字段。没有 default 时，
/// 旧版本导出的配置文件（缺了后来新增的字段）导入新版本会直接报
/// `missing field` 失败——例如 `notify_task_complete` 是后加的，那之前导出的
/// 配置就再也导不进来。加了以后：缺的字段取默认值，老配置文件都能导入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeConfig {
    pub allowed_roots: Vec<String>,
    /// 白名单配置组（存档）。与 `allowed_roots` 的关系：切换组 = 把该组 roots
    /// 写进 `allowed_roots`；在当前组里增删目录则反向同步回本字段。
    pub root_profiles: Vec<RootProfile>,
    /// 外挂 MCP server 总开关。**默认关**（决策 1）。
    ///
    /// 不能合并到 `shell_enabled`：那个开关的语义是“允许远程跑任意命令”，
    /// 而桥接是“允许远程调用**本机管理员预先指定的**几个程序”。合并会让两个开关都变模糊。
    pub external_mcp_enabled: bool,
    /// 外挂 MCP server 列表。
    ///
    /// 🔴 **只能通过 Tauri 命令（前端设置页）修改，绝不经由 MCP 写入**（方案 S1）：
    /// 里面写的是“要启动哪个可执行文件”，能改它 = 能以本机用户身份执行任意程序，
    /// 而桥接的 spawn 不走 `run_command` 那三道闸（shell_enabled / 危险命令拦截 / 命令白名单）。
    pub external_mcp_servers: Vec<crate::mcp::bridge::config::ExternalMcpServer>,
    /// 当前组名。**仅用于 UI 展示与存档归属**，不参与任何安全判定。
    pub active_profile: String,
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
    /// MCP 传输协议：`http`（默认，JSON-RPC）或 `sse`（流式，run_command 实时可见）。
    /// 仅影响连接命令生成（URL 后缀与 --transport 参数），服务端两端点共存。
    pub transport: String,
    /// 后台命令结束后保留时长（秒）。默认 120（2 分钟），超时自动清理。0 表示立即清理。
    pub command_cleanup_secs: u64,
    /// 用户上次在 Connect 页确认使用的本机 IP（多网卡场景）。用于检测网卡地址是否
    /// 发生变化（VPN 重连等）——不在 get_lan_ips() 结果里就说明已失效，需要提示用户换新地址。
    pub last_selected_ip: Option<String>,
    /// 用户上次在 Connect 页确认接入时使用的作用域（user=全局 ~/.claude.json / project=项目 .mcp.json）。
    /// 用于 IP 变化 / Token 重生成时生成精确匹配该作用域的 sed 命令，避免误改其它文件。
    /// None 表示旧数据从未落盘，此时前端兜底展示两条命令让用户自选。
    pub scope: Option<String>,
    /// 用户接入时确认的项目路径（项目级 scope 时用于 cd 前缀）。
    /// 跟随连接页选择，供托盘「复制 IP 替换命令」生成带 cd 的精确命令，与 IpChangedBanner 对齐。
    pub project_path: Option<String>,
    /// 命令白名单开关（Layer 2，opt-in，④P0-1）。默认关闭——开启后 run_command 的每个子命令
    /// 首 token 必须在 `command_allowlist` 内，否则被拦截。仅缩小可执行程序面、抬高地板；
    /// 不削弱 Layer 1（常开破坏性检测）与既有安全围栏（规则7）。注意 `shell_enabled` 已自承授予
    /// 远程调用方任意代码执行权限（RCE），白名单只是缩小面，并非沙箱。
    pub command_allowlist_enabled: bool,
    /// 命令白名单程序列表（Layer 2）。大小写不敏感按 basename 匹配（如 `git`、
    /// `C:\Windows\System32\cmd.exe`、绝对/相对路径均可）。仅在 `command_allowlist_enabled`
    /// 为 true 且列表非空时生效；空列表视为未启用，避免误锁死全部命令。
    pub command_allowlist: Vec<String>,
    /// 后台命令完成通知。默认开启——后台 run_command（background=true）结束后自动推 Windows
    /// toast，告知用户命令已结束及退出码。关闭后不再自动推送。
    pub notify_command_complete: bool,
    /// 任务完成通知（push_notification MCP 工具总开关）。默认开启——远程 AI 可主动调用
    /// push_notification 推桌面通知。关闭后 push_notification 静默忽略（不推通知，不报错）。
    pub notify_task_complete: bool,
    /// 关窗时释放界面内存。默认开启。
    ///
    /// 开（省内存）：关窗 = 销毁窗口与 webview，托盘常驻占用从约 **85MB 降到 5.5MB**
    /// （webview 的 BROWSER/gpu/renderer/utility 进程组实测约 80MB，`hide()` 不会释放）；
    /// 代价是下次打开窗口要重新加载前端，约 1~2 秒。
    ///
    /// 关（秒开）：关窗只隐藏，webview 常驻，再次打开瞬时显示，代价是那 80MB 一直挂着。
    ///
    /// 两种模式都不影响功能：MCP 服务、托盘、桌面通知（含 IP 变化提示）均为
    /// app 级，不依赖窗口存活。
    pub release_webview_on_close: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            allowed_roots: vec![],
            root_profiles: vec![],
            external_mcp_enabled: false,
            external_mcp_servers: vec![],
            active_profile: String::new(),
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
            transport: "http".into(),
            command_cleanup_secs: 120,
            last_selected_ip: None,
            scope: None,
            project_path: None,
            command_allowlist_enabled: false,
            command_allowlist: vec![],
            notify_command_complete: true,
            notify_task_complete: true,
            release_webview_on_close: true,
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
            "root_profiles" => config.root_profiles = parse_or_warn(key, value, vec![]),
            "external_mcp_enabled" => config.external_mcp_enabled = value == "true",
            "external_mcp_servers" => {
                config.external_mcp_servers = parse_or_warn(key, value, vec![])
            }
            "active_profile" => config.active_profile = parse_or_warn(key, value, String::new()),
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
            "project_path" => config.project_path = parse_or_warn(key, value, None),
            "command_allowlist_enabled" => {
                config.command_allowlist_enabled = parse_or_warn(key, value, false)
            }
            "command_allowlist" => config.command_allowlist = parse_or_warn(key, value, vec![]),
            "notify_command_complete" => {
                config.notify_command_complete = parse_or_warn(key, value, true)
            }
            "notify_task_complete" => config.notify_task_complete = parse_or_warn(key, value, true),
            "release_webview_on_close" => {
                config.release_webview_on_close = parse_or_warn(key, value, true)
            }
            "transport" => {
                let s = parse_or_warn::<String>(key, value, "http".into());
                config.transport = if s == "sse" {
                    "sse".into()
                } else {
                    "http".into()
                };
            }
            _ => {}
        }
    }

    normalize_profiles(&mut config);
    Ok(config)
}

/// 保证 `root_profiles` / `active_profile` 自洽，并完成老配置库的**隐式迁移**：
/// - profiles 为空（旧版升级上来，或全新安装）→ 用当前 `allowed_roots` 合成一个「默认」组；
/// - `active_profile` 不在 profiles 里（脏数据 / 手改过库）→ 回落到第一个组。
///
/// **关键：不动 `allowed_roots`。** 生效集合是唯一事实源，组只是存档——所以升级
/// 后的实际可访问范围与升级前**完全一致**，不会因为引入组而变宽或变窄。
///
/// 只在内存里补齐、不写库：纯读取路径不应有副作用，且重复启动幂等。
/// 真正落库交给用户操作组的那一刻（组命令 / save_config 的反向同步）。
pub(crate) fn normalize_profiles(config: &mut BridgeConfig) {
    if config.root_profiles.is_empty() {
        config.root_profiles = vec![RootProfile {
            name: DEFAULT_PROFILE_NAME.to_string(),
            roots: config.allowed_roots.clone(),
        }];
    }
    if !config
        .root_profiles
        .iter()
        .any(|p| p.name == config.active_profile)
    {
        config.active_profile = config.root_profiles[0].name.clone();
    }
}

// 故意把这组测试紧贴在 `normalize_profiles` 下方（而不是文件末尾）：它们验的是
// 上面那一个函数的兼容契约，放一起更容易跟着一同维护。
// 为此需要关掉 items_after_test_module（该 lint 要求 test mod 必须在最后）。
#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod profile_tests {
    use super::*;

    /// 隐式迁移（兼容历史）：老配置库没有 root_profiles，必须用当前生效集合
    /// 合成一个「默认」组，且**不能改动 allowed_roots**——升级后可访问范围
    /// 必须与升级前完全一致（变宽是安全事故，变窄是功能事故）。
    #[test]
    fn migrates_legacy_config_into_default_profile() {
        let mut c = BridgeConfig {
            allowed_roots: vec!["C:/work".into(), "D:/proj".into()],
            ..BridgeConfig::default()
        };
        normalize_profiles(&mut c);
        assert_eq!(c.root_profiles.len(), 1);
        assert_eq!(c.root_profiles[0].name, DEFAULT_PROFILE_NAME);
        assert_eq!(c.root_profiles[0].roots, vec!["C:/work", "D:/proj"]);
        assert_eq!(c.active_profile, DEFAULT_PROFILE_NAME);
        // 生效集合原封不动
        assert_eq!(c.allowed_roots, vec!["C:/work", "D:/proj"]);
    }

    /// active_profile 指向不存在的组（脏数据 / 手改过库）时回落到第一个组，
    /// 不能停在悬空指针上（否则 UI 会显示一个不存在的组名）。
    #[test]
    fn dangling_active_profile_falls_back() {
        let mut c = BridgeConfig {
            root_profiles: vec![
                RootProfile {
                    name: "A".into(),
                    roots: vec![],
                },
                RootProfile {
                    name: "B".into(),
                    roots: vec![],
                },
            ],
            active_profile: "已被删除的组".into(),
            ..BridgeConfig::default()
        };
        normalize_profiles(&mut c);
        assert_eq!(c.active_profile, "A");
    }

    /// 已有组时不得重复合成（幂等）：否则每次启动都会多出一个「默认」组。
    #[test]
    fn normalize_is_idempotent() {
        let mut c = BridgeConfig {
            root_profiles: vec![RootProfile {
                name: "X".into(),
                roots: vec!["/a".into()],
            }],
            active_profile: "X".into(),
            ..BridgeConfig::default()
        };
        normalize_profiles(&mut c);
        normalize_profiles(&mut c);
        assert_eq!(c.root_profiles.len(), 1);
        assert_eq!(c.active_profile, "X");
    }

    /// 兼容历史的关键一条：**旧版本导出的配置文件（大量字段缺失）必须能导入**。
    /// 这靠的是 BridgeConfig 容器级 `#[serde(default)]`；没有它时这里会报
    /// `missing field`——而那正是本次一并修掉的既有缺陷。
    #[test]
    fn legacy_export_without_new_fields_still_imports() {
        let legacy = r#"{"allowed_roots":["C:/old"],"token":"t","port":7823}"#;
        let c: BridgeConfig = serde_json::from_str(legacy).expect("老配置文件必须能导入");
        assert_eq!(c.allowed_roots, vec!["C:/old"]);
        assert_eq!(c.port, 7823);
        // 缺的字段取默认值，而不是报错
        assert!(c.root_profiles.is_empty());
        assert!(
            c.whitelist_enabled,
            "whitelist_enabled 默认应为 true（安全默认）"
        );
    }
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

    // E-P1-5: 用事务包裹 22 次 INSERT，避免独立隐式事务 + fsync。
    // 用 RAII 事务而非手写 BEGIN/COMMIT：任一 save_config_field 失败时 `?` 提前返回，
    // tx drop 时自动 ROLLBACK，不会像旧实现那样在连接上残留未结束事务（导致下次 BEGIN 报错）。
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;
    let conn = &tx;

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
    save_config_field(
        conn,
        "project_path",
        &to_value(&config.project_path).unwrap(),
    )?;
    save_config_field(
        conn,
        "command_allowlist_enabled",
        &to_value(config.command_allowlist_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "command_allowlist",
        &to_value(&config.command_allowlist).unwrap(),
    )?;
    save_config_field(
        conn,
        "notify_command_complete",
        &to_value(config.notify_command_complete).unwrap(),
    )?;
    save_config_field(
        conn,
        "root_profiles",
        &to_value(&config.root_profiles).unwrap(),
    )?;
    save_config_field(
        conn,
        "active_profile",
        &to_value(&config.active_profile).unwrap(),
    )?;
    save_config_field(
        conn,
        "release_webview_on_close",
        &to_value(config.release_webview_on_close).unwrap(),
    )?;
    save_config_field(
        conn,
        "notify_task_complete",
        &to_value(config.notify_task_complete).unwrap(),
    )?;
    save_config_field(conn, "transport", &to_value(&config.transport).unwrap())?;
    // 外挂 MCP 桥的两个键。漏写的后果不是“少存一个字段”：调用方（`import_config_inner`）
    // 是先落库再整体替换内存，漏一个就会造成内存领先于 DB——界面上已生效、
    // 重启后又变回去（已删的 server 复活）。
    save_config_field(
        conn,
        "external_mcp_enabled",
        &to_value(config.external_mcp_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "external_mcp_servers",
        &to_value(&config.external_mcp_servers).unwrap(),
    )?;

    tx.commit()
        .map_err(|e| format!("Failed to commit full config: {e}"))?;
    Ok(())
}
