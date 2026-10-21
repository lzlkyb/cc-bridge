use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db;

/// 一个白名单「配置组」（按项目切换用）。只是**存档**：当前生效的集合永远是
/// `BridgeConfig::allowed_roots`，组不参与任何路径校验。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootProfile {
    pub name: String,
    pub roots: Vec<String>,
    /// 本组的排除规则存档（glob：`*` / `**` / `?`，相对根目录匹配）。
    /// 切换组 = roots 与 exclude_patterns 一起写进生效字段。`#[serde(default)]`
    /// 保证老配置 JSON（缺此字段）反序列化不失败——与 BridgeConfig 容器级
    /// default 同一个兼容动机（import_config 老配置导入）。
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
}

/// 一条 SSH 连接配置（面板内终端，首版密码登录）。
///
/// 🔴 安全边界（S1）：凭据只经 Tauri IPC 写入本机，明文绝不走 MCP 暴露给远程 Claude Code。
/// `encrypted_password` 是 aes-gcm 密文（base64），密钥存 `data_dir/ssh_key.bin`，
/// 不在结构体里保留任何明文密码字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SshConnection {
    /// 稳定 id（前端连接列表 key），新建时由前端/后端生成 uuid。
    pub id: String,
    /// 展示名（连接列表左侧）。
    pub name: String,
    /// 远程主机（域名或 IP）。
    pub host: String,
    /// SSH 端口，默认 22。
    pub port: u16,
    /// 登录用户名。
    pub username: String,
    /// 认证方式：`"password"`（密码）/ `"key"`（私钥 + 可选密码短语）。
    #[serde(rename = "authType")]
    pub auth_type: String,
    /// 是否记住密码（记住时 `encrypted_password` 非空）。
    #[serde(rename = "rememberPassword")]
    pub remember_password: bool,
    /// aes-gcm 密文（base64，格式 nonce(12B)+ciphertext），仅当 `remember_password` 为 true 时有效。
    #[serde(rename = "encryptedPassword")]
    pub encrypted_password: String,
    /// 私钥路径（`auth_type == "key"` 时有效）。明文存：路径非机密，
    /// 密钥文件本身由 OS 文件权限 +（可选）密码短语保护。
    #[serde(rename = "keyPath", default)]
    pub key_path: String,
    /// 是否记住密钥密码短语（记住时 `encrypted_passphrase` 非空，仅 key 认证有意义）。
    #[serde(rename = "rememberPassphrase", default)]
    pub remember_passphrase: bool,
    /// aes-gcm 密文（base64），仅当 `remember_passphrase` 为 true 时有效。
    #[serde(rename = "encryptedPassphrase", default)]
    pub encrypted_passphrase: String,
    /// 跳板机：另一条 SSH 连接的 `id`；空 = 直连。
    ///
    /// 存 id 而不是内嵌一套 host/port/user/key + 独立密文，是为了**不扩大凭据落盘面**：
    /// 跳板机的密码/密钥复用被引用连接自己那份加密存储，多台目标机共用一个堡垒机时
    /// 改密码也只改一处。
    ///
    /// **只支持一跳**：被引用的连接自身必须是直连（`ssh_save_connection` 会校验）。
    /// 这样规则一句话说得清，也不必做环检测。
    #[serde(rename = "proxyJumpId", default)]
    pub proxy_jump_id: String,
}

impl Default for SshConnection {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_type: "password".into(),
            remember_password: false,
            encrypted_password: String::new(),
            key_path: String::new(),
            remember_passphrase: false,
            encrypted_passphrase: String::new(),
            proxy_jump_id: String::new(),
        }
    }
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
    /// 白名单**排除规则**（.mcpignore 式，当前生效集合）。glob：`*`（单层）/
    /// `**`（跨层）/ `?`（单字符），相对命中的白名单根目录匹配；不含 `/` 的
    /// 模式对任意一层的段名生效（如 `*.key` 拦所有 .key 文件）。命中 = 拒绝，
    /// 只收紧、不放宽：根外路径本来就被拒，不受排除影响。
    /// 🔴 安全语义：经 `resolve_safe_path_cached` 强制，远程 MCP 全部文件类工具生效。
    /// 存档在 `root_profiles[].exclude_patterns`，切换组时一起换入。
    pub exclude_patterns: Vec<String>,
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
    /// 用户在连接页选定的接入工具（"claude-code"（默认）/ "workbuddy" / "codex" / "generic"）。
    /// 决定托盘「复制连接命令」与两处「原地更新 IP」命令的形态：Claude Code 出 CLI 命令、
    /// 其余工具出配置片段 / 各自配置文件的 sed。None = 旧配置（本字段之前不存在），按 claude-code 处理。
    pub connect_client: Option<String>,
    /// 首次接入完成标记：**首次复制连接命令成功**时由前端经 save_config 置 true，
    /// 只增不减（后端仅接受 true，false 请求被忽略；无 UI 开关）。
    ///
    /// 用于区分「真新用户」（连接页「接入步骤」默认展开）与「升级上来的老用户」——
    /// 旧方案用 localStorage 标记，无法区分两者且会被首启副作用污染，故判定权交给后端。
    ///
    /// 兼容语义见 `load_config`：老配置库缺这个键时按「已接入」处理（true），
    /// 只有全新安装才从 false 起步。
    pub has_onboarded: bool,
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
    /// SSH 终端总开关（面板内交互终端）。默认关——遵循「默认关 + 多层闸」，
    /// 首次进「终端」Tab 需用户显式启用（见前端启用闸）。
    pub ssh_enabled: bool,
    /// SSH 连接列表（首版密码登录）。
    ///
    /// 🔴 只经 Tauri IPC 修改（前端 save_config patch），绝不走 MCP（对齐 external_mcp_servers 注释）。
    /// 凭据以加密形式存于每条连接的 `encrypted_password`，明文密码不经此结构。
    pub ssh_connections: Vec<SshConnection>,
    /// 终端拖拽即选：在 xterm 内按住左键移动超阈值即自动进选择态。
    /// 默认开（对齐主流终端习惯）；关闭后仍可按 Shift 或点「选择模式」进入选择态。
    pub ssh_drag_select_enabled: bool,
    /// 终端选中即复制：选择手势结束（松手）时自动把选中文字写入剪贴板。默认开。
    ///
    /// 与 `ssh_drag_select_enabled` **正交**：那一项决定「能不能裸拖选」，这一项决定
    /// 「松手要不要自动写剪贴板」。关掉后拖选照常建选区，复制改走右键菜单 / 工具栏 / 快捷键。
    pub ssh_copy_on_select_enabled: bool,
    /// P1 远程访问：HTTPS（自签证书）serve 总开关。**默认关**——HTTP 路径行为不变，
    /// 开启后 MCP 监听整体切换为 TLS（单端口，无并存）。
    pub remote_tls_enabled: bool,
    /// P1 远程访问：401 连续失败封禁开关。默认开（仅 0.0.0.0 绑定时实际生效）。
    pub remote_ban_enabled: bool,
    /// P1 封禁阈值：连续 401 次数达该值即封禁该 IP。默认 5。
    pub remote_ban_threshold: u32,
    /// P1 封禁窗口（分钟）：封禁持续时长，窗口过期自动解封。默认 15。
    pub remote_ban_window_min: u32,
    /// 本机设备身份尾号（4 位小写十六进制，首启生成持久化，见 main.rs 启动补齐）。
    /// 多设备模式的主键：接入条目名 `cc-bridge-<device_id>`、身份卡展示、导出聚合
    /// 都靠它区分设备。空串 = 尚未生成。与 `multi_device_mode` 正交——多设备模式
    /// 关闭时本字段静默存在，不产生任何 UI（兼容性契约）。
    pub device_id: String,
    /// 多设备接入模式总开关（opt-in，连接页写入，默认关）。
    /// 🔴 兼容性契约（2026-10-17 用户拍板）：**关闭时产品行为与引入前逐字一致**——
    /// 接入命令保持 sed 形态、冲突文案维持两分支、确认弹窗维持现有文案、无任何
    /// 「本机身份」UI。开启后接入命令变为条目级并出现身份卡 / 三分支文案。
    pub multi_device_mode: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            allowed_roots: vec![],
            exclude_patterns: vec![],
            root_profiles: vec![],
            external_mcp_enabled: false,
            external_mcp_servers: vec![],
            active_profile: String::new(),
            token: String::new(),
            // 🔴 默认白名单必须覆盖「工具对外承诺能处理的东西」。MCP instructions 明确写
            // 「需要传 pptx、xlsx、pdf、图片、压缩包时优先用 prepare_upload/prepare_download」，
            // `notebook_edit` 又专治 .ipynb——这些默认缺席等于新用户照着 instructions 操作
            // 必然撞墙（2026-10-21 真机测试实测）。`view_image` 曾经踩过同一个坑，当时用
            // 「独立内置清单」绕开，本处改为从根上把默认值补齐（内置清单仍保留作存量兜底）。
            //
            // ⚠️ 只加「数据/文档/图片」类。可执行与脚本投放类（.exe/.dll/.bat/.ps1/.cmd/
            // .vbs/.msi/.scr/.jar/.lnk）**永不进默认**，由 `default_extensions_tests` 守门。
            allowed_extensions: vec![
                // —— 源码 / 配置（原始 30 项，内容一律不动，避免存量配置对比噪声）——
                ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".py", ".java", ".go", ".rs",
                ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".yml", ".yaml",
                ".toml", ".ini", ".md", ".txt", ".html", ".css", ".scss", ".sql", ".xml",
                // —— Notebook（notebook_edit 的唯一目标格式）与办公文档 / PDF ——
                ".ipynb", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf",
                // —— 压缩包（直传最常见的载荷）——
                ".zip", ".tar", ".gz", ".7z", ".rar",
                // —— 图片（与 view_image 的 IMAGE_EXTENSIONS 对齐）——
                ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
                // —— 表格 / 日志（analyze_file 与 search_files 的常见输入）——
                ".csv", ".tsv", ".log",
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
            connect_client: None,
            has_onboarded: false,
            command_allowlist_enabled: false,
            command_allowlist: vec![],
            notify_command_complete: true,
            notify_task_complete: true,
            release_webview_on_close: true,
            ssh_enabled: false,
            ssh_connections: vec![],
            ssh_drag_select_enabled: true,
            ssh_copy_on_select_enabled: true,
            remote_tls_enabled: false,
            remote_ban_enabled: true,
            remote_ban_threshold: 5,
            remote_ban_window_min: 15,
            device_id: String::new(),
            multi_device_mode: false,
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
            "exclude_patterns" => config.exclude_patterns = parse_or_warn(key, value, vec![]),
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
            // 🔴 曾漏读（审查 B1 的另一半）：只写了 save 通道、load 里没有这一支，
            // 于是「切到 Codex」当场生效、重启又变回 claude-code。save/load 必须成对。
            "connect_client" => config.connect_client = parse_or_warn(key, value, None),
            "has_onboarded" => config.has_onboarded = parse_or_warn(key, value, false),
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
            "ssh_enabled" => config.ssh_enabled = parse_or_warn(key, value, false),
            "ssh_connections" => config.ssh_connections = parse_or_warn(key, value, vec![]),
            "ssh_drag_select_enabled" => {
                config.ssh_drag_select_enabled = parse_or_warn(key, value, true)
            }
            "ssh_copy_on_select_enabled" => {
                config.ssh_copy_on_select_enabled = parse_or_warn(key, value, true)
            }
            "remote_tls_enabled" => config.remote_tls_enabled = parse_or_warn(key, value, false),
            "remote_ban_enabled" => config.remote_ban_enabled = parse_or_warn(key, value, true),
            "remote_ban_threshold" => config.remote_ban_threshold = parse_or_warn(key, value, 5u32),
            "remote_ban_window_min" => {
                config.remote_ban_window_min = parse_or_warn(key, value, 15u32)
            }
            "device_id" => config.device_id = parse_or_warn(key, value, String::new()),
            "multi_device_mode" => config.multi_device_mode = parse_or_warn(key, value, false),
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

    // has_onboarded 的**老库隐式迁移**：容器级 serde(default) 只能给出 false（新安装语义），
    // 但「配置库里已有任意键、唯独缺 has_onboarded」说明这是一个升级上来的老用户——
    // 它们早已接入（甚至只是用过一段时间），绝不能被误判成新用户而在升级后第一次
    // 打开连接页时看到「接入步骤」自动展开。反之 rows 为空 = 全新安装，保持 false。
    // 局限（有意接受）：新安装后、首次复制前若先写过其它配置键（改过设置），会被
    // 当作老用户折叠处理——此时用户已在主动使用应用，折叠反而是对的。
    // import_config 不走此路径：导入老版本导出的配置时该键缺省为 false，最多多展开
    // 一次向导，无功能影响。
    if !rows.is_empty() && !rows.iter().any(|(k, _)| k == "has_onboarded") {
        config.has_onboarded = true;
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
            exclude_patterns: config.exclude_patterns.clone(),
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

/// 排除规则入库名一化：去空白、丢空串、去重（保序）。save_config / 导入 /
/// 组切换共用，保证库存的模式永远可直接参与匹配。
pub(crate) fn normalize_patterns(patterns: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in patterns {
        let t = p.trim().to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
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
                    exclude_patterns: vec![],
                },
                RootProfile {
                    name: "B".into(),
                    roots: vec![],
                    exclude_patterns: vec![],
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
                exclude_patterns: vec![],
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
        "exclude_patterns",
        &to_value(&config.exclude_patterns).unwrap(),
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
    // SSH 终端配置。漏写的后果与 external_mcp_servers 同：内存领先于 DB，重启后丢失。
    save_config_field(conn, "ssh_enabled", &to_value(config.ssh_enabled).unwrap())?;
    save_config_field(
        conn,
        "ssh_connections",
        &to_value(&config.ssh_connections).unwrap(),
    )?;
    save_config_field(
        conn,
        "ssh_drag_select_enabled",
        &to_value(config.ssh_drag_select_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "ssh_copy_on_select_enabled",
        &to_value(config.ssh_copy_on_select_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "remote_tls_enabled",
        &to_value(config.remote_tls_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "remote_ban_enabled",
        &to_value(config.remote_ban_enabled).unwrap(),
    )?;
    save_config_field(
        conn,
        "remote_ban_threshold",
        &to_value(config.remote_ban_threshold).unwrap(),
    )?;
    save_config_field(
        conn,
        "remote_ban_window_min",
        &to_value(config.remote_ban_window_min).unwrap(),
    )?;
    save_config_field(conn, "device_id", &to_value(&config.device_id).unwrap())?;
    save_config_field(
        conn,
        "multi_device_mode",
        &to_value(config.multi_device_mode).unwrap(),
    )?;
    // 🔴 这两个键曾漏写（审查 B7）：`import_config_inner` 是「先落库再整体替换内存」，
    // 漏写即造成内存领先于 DB——导入后界面按新配置跑、重启又变回旧值；`has_onboarded`
    // 丢失还会让老用户重新看到引导。字段清单必须与 `ConfigPatch` 的 apply_field!
    // 分支保持同步，`save_full_config_roundtrip_preserves_every_patchable_field` 守这条。
    save_config_field(
        conn,
        "connect_client",
        &to_value(&config.connect_client).unwrap(),
    )?;
    save_config_field(
        conn,
        "has_onboarded",
        &to_value(config.has_onboarded).unwrap(),
    )?;
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

/// 生成本机设备身份尾号：4 位小写十六进制。只取 4 位是刻意的——它要被人读、
/// 被人抄进条目名（`cc-bridge-<id>`），碰撞概率 1/65536 对「同一个用户的两三台
/// 设备」足够；全局唯一性不是目标（那才需要 uuid，但没人愿意抄 36 位进终端）。
pub fn generate_device_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..4)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect()
}

/// 本机机器名（跨平台兜底）：Windows 取 COMPUTERNAME，类 Unix 取 HOSTNAME，
/// 都没有时回落 "PC"。仅用于多设备模式身份卡的展示，不参与任何协议/判定。
pub fn device_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "PC".into())
}

#[cfg(test)]
mod device_identity_tests {
    use super::*;

    #[test]
    fn device_id_is_four_lowercase_hex() {
        for _ in 0..32 {
            let id = generate_device_id();
            assert_eq!(id.len(), 4, "应为 4 位：{id}");
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "应为小写十六进制：{id}"
            );
        }
    }

    #[test]
    fn multi_device_mode_defaults_off() {
        // 兼容性契约的兜底断言：缺字段（老配置库）时必须是关。
        assert!(!BridgeConfig::default().multi_device_mode);
        assert!(BridgeConfig::default().device_id.is_empty());
    }
}

/// 默认扩展名白名单的守门测试（2026-10-21 真机测试教训）。
///
/// 背景：`notebook_edit` 在默认配置下 100% 不可用——默认 30 项里没有 `.ipynb`，而
/// `http.rs::test_config` 当时用一行 `ext.push(".ipynb")` 私自补上，于是单测永久绿、
/// 真机必红。这类「默认值与工具能力脱节」的洞，只能靠直接断言默认值本身来堵。
#[cfg(test)]
mod default_extensions_tests {
    use super::*;

    fn defaults() -> Vec<String> {
        BridgeConfig::default().allowed_extensions
    }

    fn lower() -> Vec<String> {
        defaults().iter().map(|e| e.to_lowercase()).collect()
    }

    /// 默认白名单必须覆盖「工具 / MCP instructions 明确承诺能处理」的格式。
    /// 缺一个 = 用户照着文档操作必然撞墙，且单测不会红（这正是上面说的洞）。
    #[test]
    fn covers_documented_capabilities() {
        let ext = lower();
        let required = [
            ".ipynb", // notebook_edit 的唯一目标格式
            ".pptx",  // ↓ instructions 点名的直传格式
            ".xlsx",  //
            ".docx",  //
            ".pdf",   //
            ".zip",   // 「压缩包」
            ".png",   // 「图片」
            ".jpg",   //
        ];
        for r in required {
            assert!(
                ext.iter().any(|e| e == r),
                "默认白名单缺 {r}：依赖它的能力在默认配置下不可用"
            );
        }
    }

    /// 可执行 / 脚本投放类**永不进默认**。默认值会自我传播（新装用户全量继承），
    /// 一次误加等于把所有人置于风险中。
    ///
    /// 注：`.sh` / `.bash` 是早期遗留（与其它源码扩展名同批），不在本断言范围内——
    /// 把它们摘掉属于安全语义变更，需要单独评估，不混在这一笔里。
    #[test]
    fn excludes_executable_payloads() {
        let ext = lower();
        for banned in [
            ".exe", ".dll", ".sys", ".msi", ".scr", ".com", ".bat", ".cmd", ".ps1", ".vbs", ".vbe",
            ".wsf", ".wsh", ".hta", ".jar", ".lnk", ".reg",
        ] {
            assert!(
                !ext.iter().any(|e| e == banned),
                "{banned} 不能进默认白名单"
            );
        }
    }

    /// 形状守门：一律点开头、小写、非空、无重复。写错了（如 `"ipynb"` 少点、
    /// `".PNG"` 大写）会让 `assert_extension_allowed` 的精确比较永远不命中。
    #[test]
    fn every_default_entry_is_well_formed() {
        let ext = defaults();
        for e in &ext {
            assert!(e.starts_with('.'), "扩展名必须以点开头：{e}");
            assert!(e.len() > 1, "扩展名不能只有点：{e}");
            assert_eq!(e.to_lowercase(), *e, "扩展名必须小写：{e}");
        }
        let mut uniq = ext.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), ext.len(), "默认白名单有重复项");
    }
}

/// save/load 成对性回归（审查 B1 / B7）。
///
/// 守的是同一条不变量：**`save_full_config` 写下去的每个键，`load_config` 都必须读回来**。
/// 历史上两次踩坑都在这里——`connect_client` 有 save 无 load、`has_onboarded` 有 load
/// 无 save，表现都是「界面已生效、重启后变回旧值」，而门禁全绿。这个测试把
/// 每个字段都设成与默认值不同的值，然后跑一遍 save→load，任一侧漏掉就红。
#[cfg(test)]
mod save_load_contract_tests {
    use super::*;
    use serde_json::json;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-mem db");
        conn.execute_batch(
            "CREATE TABLE config (
                key   TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
        )
        .expect("create config table");
        conn
    }

    #[test]
    fn save_full_config_roundtrip_preserves_every_field() {
        let conn = mem_conn();
        // 每个字段都设成非默认值，才能证明 save/load 两边键名与类型都没错位。
        // （用结构体字面量而非逐行 `c.x = …`：clippy 的 field_reassign_with_default。）
        let c = BridgeConfig {
            allowed_roots: vec!["D:\\proj".into()],
            exclude_patterns: vec!["**/node_modules/**".into()],
            root_profiles: vec![RootProfile {
                name: "工作".into(),
                roots: vec!["D:\\proj".into()],
                exclude_patterns: vec!["*.log".into()],
            }],
            active_profile: "工作".into(),
            token: "tok-roundtrip".into(),
            allowed_extensions: vec!["rs".into()],
            max_file_size_bytes: 1234,
            rate_limit_max_requests: 7,
            rate_limit_window_ms: 4321,
            backup_dir: ".bak-x".into(),
            backup_retention: 3,
            audit_retention_days: 9,
            command_cleanup_secs: 30,
            host: "192.168.1.9".into(),
            port: 7890,
            whitelist_enabled: false,
            readonly_mode: true,
            backup_enabled: false,
            audit_enabled: false,
            rate_limit_enabled: false,
            encoding_detect_enabled: true,
            shell_enabled: true,
            session_cwd_enabled: true,
            shell_type: "bash".into(),
            transport: "sse".into(),
            last_selected_ip: Some("192.168.1.9".into()),
            scope: Some("project".into()),
            project_path: Some("D:\\proj".into()),
            // 🔴 B1/B7 的核心两字段
            connect_client: Some("codex".into()),
            has_onboarded: true,
            command_allowlist_enabled: true,
            command_allowlist: vec!["git".into()],
            notify_command_complete: false,
            notify_task_complete: false,
            release_webview_on_close: false,
            ssh_enabled: true,
            ssh_drag_select_enabled: false,
            ssh_copy_on_select_enabled: false,
            remote_tls_enabled: true,
            remote_ban_enabled: false,
            remote_ban_threshold: 11,
            remote_ban_window_min: 42,
            device_id: "ab12".into(),
            multi_device_mode: true,
            external_mcp_enabled: true,
            ..Default::default()
        };

        save_full_config(&conn, &c).expect("save_full_config");
        let loaded = load_config(&conn).expect("load_config");

        assert_eq!(loaded.allowed_roots, c.allowed_roots);
        assert_eq!(loaded.exclude_patterns, c.exclude_patterns);
        assert_eq!(loaded.root_profiles.len(), 1);
        assert_eq!(loaded.root_profiles[0].exclude_patterns, vec!["*.log"]);
        assert_eq!(loaded.active_profile, "工作");
        assert_eq!(loaded.token, "tok-roundtrip");
        assert_eq!(loaded.allowed_extensions, c.allowed_extensions);
        assert_eq!(loaded.max_file_size_bytes, 1234);
        assert_eq!(loaded.rate_limit_max_requests, 7);
        assert_eq!(loaded.rate_limit_window_ms, 4321);
        assert_eq!(loaded.backup_dir, ".bak-x");
        assert_eq!(loaded.backup_retention, 3);
        assert_eq!(loaded.audit_retention_days, 9);
        assert_eq!(loaded.command_cleanup_secs, 30);
        assert_eq!(loaded.host, "192.168.1.9");
        assert_eq!(loaded.port, 7890);
        assert!(!loaded.whitelist_enabled);
        assert!(loaded.readonly_mode);
        assert!(!loaded.backup_enabled);
        assert!(!loaded.audit_enabled);
        assert!(!loaded.rate_limit_enabled);
        assert!(loaded.encoding_detect_enabled);
        assert!(loaded.shell_enabled);
        assert!(loaded.session_cwd_enabled, "session_cwd_enabled 必须往返");
        assert_eq!(loaded.shell_type, "bash");
        assert_eq!(loaded.transport, "sse");
        assert_eq!(loaded.last_selected_ip.as_deref(), Some("192.168.1.9"));
        assert_eq!(loaded.scope.as_deref(), Some("project"));
        assert_eq!(loaded.project_path.as_deref(), Some("D:\\proj"));
        assert_eq!(
            loaded.connect_client.as_deref(),
            Some("codex"),
            "connect_client 必须往返（B1：有 save 无 load 时重启回退 claude-code）"
        );
        assert!(loaded.has_onboarded, "has_onboarded 必须往返（B7）");
        assert!(loaded.command_allowlist_enabled);
        assert_eq!(loaded.command_allowlist, vec!["git"]);
        assert!(!loaded.notify_command_complete);
        assert!(!loaded.notify_task_complete);
        assert!(!loaded.release_webview_on_close);
        assert!(loaded.ssh_enabled);
        assert!(!loaded.ssh_drag_select_enabled);
        assert!(!loaded.ssh_copy_on_select_enabled);
        assert!(loaded.remote_tls_enabled);
        assert!(!loaded.remote_ban_enabled);
        assert_eq!(loaded.remote_ban_threshold, 11);
        assert_eq!(loaded.remote_ban_window_min, 42);
        assert_eq!(loaded.device_id, "ab12");
        assert!(loaded.multi_device_mode);
        assert!(loaded.external_mcp_enabled);
    }

    /// 空库（全新安装）语义：所有值取默认，且不得被 load 过程改写成奇怪的东西。
    #[test]
    fn load_config_on_empty_db_yields_defaults() {
        let conn = mem_conn();
        let loaded = load_config(&conn).expect("load_config");
        let default = BridgeConfig::default();
        assert_eq!(loaded.port, default.port);
        assert_eq!(loaded.host, default.host);
        assert_eq!(loaded.connect_client, None);
        assert!(!loaded.has_onboarded, "全新安装必须是新用户");
        assert!(!loaded.session_cwd_enabled);
    }

    /// `BridgeConfig` 的序列化键名是导入/导出的对外契约。这里锁住
    /// 「导出 JSON 里绝不出现密文」的脱敏不变量所需前提（字段名可枚举），
    /// 并顺带断言新增敏感字段时序列化名不会意外变形成带明文语义的名字。
    #[test]
    fn serialized_config_shape_is_stable() {
        let v = serde_json::to_value(BridgeConfig::default()).expect("serialize");
        let obj = v.as_object().expect("object");
        for key in [
            "connect_client",
            "session_cwd_enabled",
            "multi_device_mode",
            "ssh_connections",
        ] {
            assert!(obj.contains_key(key), "序列化缺键：{key}");
        }
        // 默认配置的 JSON 是可被自身反序列化回来的（导入路径的前提）。
        let round: BridgeConfig = serde_json::from_value(json!(v)).expect("deserialize back");
        assert_eq!(round.port, BridgeConfig::default().port);
    }
}
