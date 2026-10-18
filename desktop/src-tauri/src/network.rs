use std::net::UdpSocket;

/// 返回本机所有可用于远程接入的 IPv4 地址。
///
/// WHY: 机器可能多网卡（VPN + 物理内网），远程 Linux 走哪条线只有用户知道。
/// 程序无法自动判断，所以枚举全部地址交给用户选。默认路由那个排第一（作推荐默认值）。
pub fn get_lan_ips() -> Vec<String> {
    let mut ips: Vec<String> = Vec::new();

    // 1. 默认路由 IP 排第一（UDP 探测，不实际发包）
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if is_usable_ipv4(&ip) {
                    ips.push(ip);
                }
            }
        }
    }

    // 2. 追加其余所有网卡的 IPv4（去重，排除回环/链路本地）
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                let ip = v4.to_string();
                if is_usable_ipv4(&ip) && !ips.contains(&ip) {
                    ips.push(ip);
                }
            }
        }
    }

    ips
}

/// 排除回环（127.）和链路本地自动配置地址（169.254.）。
fn is_usable_ipv4(ip: &str) -> bool {
    ip != "0.0.0.0" && !ip.starts_with("127.") && !ip.starts_with("169.254.")
}

/// 解析「远程客户端应当连接」的展示地址（也是可达性探针的目标地址）：
/// - host == "0.0.0.0"(监听全部):优先用用户已选 IP(last_selected_ip 且仍在本机网卡),
///   否则回退默认路由网卡(lan_ips[0]),避免给出用户没选的那个地址(P1)。
/// - 指定具体 host:若该地址仍在网卡则用它,否则回退默认路由网卡。
///
/// build_connect_command 与 get_status 的可达性探针共用此函数,
/// 确保「复制给用户的地址」与「探测的地址」完全一致(S1)。
pub fn resolve_display_host(host: &str, lan_ips: &[String], selected_ip: Option<&str>) -> String {
    if host == "0.0.0.0" {
        selected_ip
            .filter(|ip| lan_ips.iter().any(|x| x == ip))
            .map(|s| s.to_string())
            .or_else(|| lan_ips.first().cloned())
            .unwrap_or_else(|| "127.0.0.1".into())
    } else if is_loopback_host(host) {
        // 🔴 显式绑回环就**原样返回**（审查 P2）：服务只监听 127.0.0.1，
        // 而 `lan_ips` 明确排除了 127.*（见 `is_usable_ipv4`），所以「在网卡里」
        // 这条判据对它恒假 → 旧实现会回退到 LAN IP，托盘复制出一个**没在监听**的地址。
        // 前端同语义函数返回 127.0.0.1，这里必须一致（R11）。
        host.to_string()
    } else if lan_ips.iter().any(|x| x == host) {
        host.to_string()
    } else {
        // 配置的具体地址已不可用,回退到默认路由网卡
        lan_ips.first().cloned().unwrap_or_else(|| host.to_string())
    }
}

/// 是否指回环地址（`127.0.0.0/8`、`::1`、`localhost`，含 IPv6 方括号写法）。
///
/// 不能靠 `lan_ips.contains` 判断：`get_lan_ips` 本身就排除回环。
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    h.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// 构造给远程服务器粘贴的连接命令。
/// - host == "0.0.0.0"(监听全部):优先用用户已选 IP(last_selected_ip 且仍在本机网卡),
///   否则回退默认路由网卡(lan_ips[0]),避免给出用户没选的那个地址(P1)。
/// - 指定具体 host:若该地址已不在本机网卡(网卡宕掉),回退到默认路由网卡,
///   避免顶栏/托盘复制出死地址(O4)。
///
/// lan_ips 由调用方传入,避免重复枚举网卡(P3)。
///
/// **多客户端（身份转变后）**：产物形态按 `client` 分支——Claude Code 出 CLI 命令，
/// WorkBuddy / Codex / 通用工具出各自配置文件的片段（它们没有等价的 CLI 注册命令）。
///
/// 打包成结构体而非 8 个裸参数：这些字段本就描述同一件事（「给谁、用哪个地址、
/// 以什么形态生成接入内容」），且 8 参已触发 `clippy::too_many_arguments`——
/// 与其 `#[allow]`，不如让调用点显式写出字段名，读起来也清楚哪个值是哪个。
pub struct ConnectTarget<'a> {
    /// 监听地址；`"0.0.0.0"` 表示监听全部网卡。
    pub host: &'a str,
    pub port: u16,
    pub token: &'a str,
    /// `"http"` | `"sse"`（决定 URL 后缀）。
    pub transport: &'a str,
    /// 是否已开启 HTTPS（决定 scheme）。此前这里硬编码 `http://`，开了 HTTPS 的
    /// 用户从托盘复制到的命令是连不上的（前端一直 TLS 感知，只有托盘漏了）。
    pub tls: bool,
    /// 接入工具：`"claude-code"`（默认）/ `"workbuddy"` / `"codex"` / `"generic"`。
    pub client: &'a str,
    /// 本机可用 IPv4（由调用方传入，避免重复枚举网卡）。
    pub lan_ips: &'a [String],
    /// 用户上次确认的 IP（多网卡场景）。
    pub selected_ip: Option<&'a str>,
    /// 多设备模式开关（opt-in，批3-2）。true 且 device_id 非空时，WorkBuddy/Codex 的
    /// **手动接入片段**条目名带尾号（cc-bridge-<id>，与其它设备并存互不覆盖）。
    /// claude-code 不消费这两个字段——多设备 CLI 命令由调用方直接走
    /// `build_multi_device_command` 分流，此处 claude 分支保持单设备形态。
    pub multi_device: bool,
    /// 本机设备身份尾号（4 位 hex；空 = 单设备/未生成，条目名维持 cc-bridge）。
    pub device_id: &'a str,
}

/// 多设备条目名（单一拼装点）：尾号非空 → `cc-bridge-<id>`，空 → `cc-bridge`。
/// 🔴 前端 `lib/mcpClients.ts` 片段条目名与此语义一致（双端各一份，改一处同步另一处）。
fn entry_name(device_id: &str) -> String {
    if device_id.is_empty() {
        "cc-bridge".to_string()
    } else {
        format!("cc-bridge-{device_id}")
    }
}

pub fn build_connect_command(t: ConnectTarget<'_>) -> String {
    let display_host = resolve_display_host(t.host, t.lan_ips, t.selected_ip);
    let url_suffix = if t.transport == "sse" {
        "/mcp/sse"
    } else {
        "/mcp"
    };
    let scheme = if t.tls { "https" } else { "http" };
    let url = format!("{scheme}://{display_host}:{}{url_suffix}", t.port);
    let token = t.token;

    match t.client {
        "workbuddy" => {
            let entry = entry_name(if t.multi_device { t.device_id } else { "" });
            let snippet = serde_json::json!({
                "mcpServers": {
                    (entry): {
                        "url": url,
                        "headers": { "Authorization": format!("Bearer {token}") }
                    }
                }
            });
            format!(
                "// 写入 ~/.workbuddy/mcp.json（保存后重启 WorkBuddy）\n{}",
                serde_json::to_string_pretty(&snippet).unwrap_or_default()
            )
        }
        "codex" => {
            let entry = entry_name(if t.multi_device { t.device_id } else { "" });
            format!(
                "# 写入 ~/.codex/config.toml（保存后重启 Codex）\n[mcp_servers.{entry}]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"Bearer {token}\" }}"
            )
        }
        // 通用工具没有约定的配置载体，给「事实清单」而不是假装这是一条命令。
        "generic" => format!("URL: {url}\nHeader: Authorization: Bearer {token}"),
        // 默认（含 None / 未知值）：Claude Code 的 CLI 命令。
        _ => format!(
            "claude mcp add --transport {} cc-bridge {url} --header \"Authorization: Bearer {token}\"",
            t.transport
        ),
    }
}

/// 双引号内的 shell 转义：`\` `"` `` ` `` `$` 前加反斜杠。
///
/// 项目路径是用户输入（也来自系统路径），含这些字符时裸拼进 `cd "…"` 会截断字符串
/// 或触发命令替换（`$(…)` / 反引号）——审查 P2「network.rs:188 路径未转义」。
/// 🔴 前端 `lib/utils.ts escapeDoubleQuoted` 与此逐字一致。
pub fn escape_double_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        match c {
            // 🔴 双引号内 `\` **只**对 `\ " ` $` 与换行有转义意义。这里只在这几种情况下
            // 翻倍（外加末尾那个——它会吃掉收尾引号），其它保持原样。
            // 一律翻倍会把 `C:\My Project` 变成 `C:\\My Project`：语义等价但用户
            // 看到的路径和资源管理器里复制的不一样，排查时极易误判「命令被改坏了」。
            '\\' => {
                let next = chars.get(i + 1);
                if next.is_none() || matches!(next, Some('\\' | '"' | '`' | '$')) {
                    out.push('\\');
                }
                out.push('\\');
            }
            '"' | '`' | '$' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// 可移植的原地编辑：`sed -i.bak EXPR FILE && rm -f FILE.bak`。
///
/// 为什么不用 `sed -i`：GNU sed 的 `-i` 可省略后缀，而 **BSD/macOS 的 `-i` 必须跟
/// 备份后缀**，否则把下一个参数当后缀、报 `invalid command code`——远端是 macOS 时
/// 所有 IP/令牌修复命令都失效（审查 P2）。带 `.bak` 的写法 GNU/BSD/busybox 通吃，
/// 成功后顺手删掉备份，用户看不到多余文件；sed 失败时 `&&` 挡住 rm，备份留着可回滚。
/// 🔴 前端 `lib/utils.ts sedInPlace` 与此逐字一致。
fn sed_in_place(expr: &str, file: &str) -> String {
    format!("sed -i.bak '{expr}' {file} && rm -f {file}.bak")
}

/// 生成「网络变动时原地更新 IP」的 sed 命令，**严格对齐前端 `IpChangedBanner.buildSed`**：
/// - Claude Code · user 级：`sed -i.bak 's#...#...#g' ~/.claude.json && rm -f ~/.claude.json.bak`
/// - Claude Code · project 级 + 有项目路径：`cd "<path>" && sed -i.bak …`
/// - Claude Code · project 级 + 无路径：`sed -i.bak … .mcp.json`（提示在项目目录执行）
/// - WorkBuddy：`~/.workbuddy/mcp.json`；Codex：`~/.codex/config.toml`（两家的 url 都是文本，
///   同一条 sed 适用，无需重装 client）；**generic 返回空串**——没有约定路径，只能让用户手动改。
///
/// 作用域与项目路径**跟随用户在连接页的选择**（方案 A）：托盘读 `config.scope` / `config.project_path`。
/// 匹配段用 `https\?://` 同时覆盖 http/https 两种旧值、替换段按当前 TLS 状态生成 scheme——
/// 此前这里只匹配 `http://` 且替换成 `http://`，开了 HTTPS 的用户跑完命令等于没修。
pub fn build_ip_sed_command(
    port: u16,
    display_host: &str,
    scope: &str,
    project_path: &Option<String>,
    tls: bool,
    client: &str,
) -> String {
    let (cfg_file, cd_prefix) = match client {
        "workbuddy" => ("~/.workbuddy/mcp.json".to_string(), String::new()),
        "codex" => ("~/.codex/config.toml".to_string(), String::new()),
        // 通用工具没有约定配置文件 → 空串，由调用方改为「请手动更新」提示。
        "generic" => return String::new(),
        _ => {
            let cfg = if scope == "project" {
                ".mcp.json"
            } else {
                "~/.claude.json"
            };
            let cd = if scope == "project" {
                project_path
                    .as_ref()
                    .map(|p| p.trim())
                    .filter(|t| !t.is_empty())
                    .map(|t| format!("cd \"{}\" && ", escape_double_quoted(t)))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            (cfg.to_string(), cd)
        }
    };
    let scheme = if tls { "https" } else { "http" };
    let expr = format!("s#https\\?://[0-9.]*:{port}/mcp#{scheme}://{display_host}:{port}/mcp#g");
    format!("{cd_prefix}{}", sed_in_place(&expr, &cfg_file))
}

/// 多设备模式（opt-in）的接入/更新命令：条目级 remove + add，**幂等可重跑**。
/// 条目名 `cc-bridge-<device_id>` —— 两台机器生成的条目名不同，在远端配置中
/// 并存、互不覆盖，把「互踢」（sed 按 URL 全局替换的后写者赢）变成
/// 「并存 + 显式切换」。仅 user 作用域：多设备语义建立在全局条目上，
/// project 级配置跟随目录走、天然按机器隔离，没有互踢问题。
/// token 为明文内联——与单设备 `claude mcp add` 的既有形态一致。
/// 🔴 前端 `lib/utils.ts buildMultiDeviceCommand` 与此逐字一致（双端各生成一份，
/// 改一处必须同步另一处，同 buildIpSedCommand 的既有约定）。
pub fn build_multi_device_command(
    port: u16,
    display_host: &str,
    token: &str,
    transport: &str,
    tls: bool,
    device_id: &str,
) -> String {
    if device_id.is_empty() {
        return String::new();
    }
    let url_suffix = if transport == "sse" {
        "/mcp/sse"
    } else {
        "/mcp"
    };
    let scheme = if tls { "https" } else { "http" };
    let entry = format!("cc-bridge-{device_id}");
    format!(
        "claude mcp remove {entry} 2>/dev/null\nclaude mcp add {entry} -s user --transport {transport} --header \"Authorization: Bearer {token}\" {scheme}://{display_host}:{port}{url_suffix}"
    )
}

/// 条目锚定的 scoped sed（批3-2）：把「URL 全局替换」收窄到**单个条目块内**。
///
/// 为什么需要：多设备模式下远端配置可能同时存在 cc-bridge-<甲> 与 cc-bridge-<乙>
/// 两个条目（共用同一份配置的远程机/共享目录场景），原有 sed 按 URL 全局替换会
/// 把两台的条目一起改写——正是「互踢」的根因。scoped sed 用地址范围限定：
/// - Codex（TOML）：从 `[mcp_servers.cc-bridge-<id>]` 段头到下一个段头——段头
///   行首 `[` 是 TOML 规范保证的行锚点，最可靠；
/// - WorkBuddy（JSON）：从条目键行到 `"Authorization"` 行——依赖条目内 url 先于
///   headers 的规范序列化顺序（双端生成器都是这个顺序）。用户手工改乱格式时
///   范围失配 → **sed 无匹配 = 什么都不改**，失败是良性的（IP 没修上，横幅还在），
///   不会像全局替换那样改坏相邻条目。
///
/// 替换段与 `build_ip_sed_command` 逐字同款（`https\?` 双协议匹配 + 按当前 TLS 出目标）。
/// 🔴 前端 `lib/utils.ts buildIpSedCommand` 的多设备分支与此逐字一致。
pub fn build_scoped_sed_command(
    port: u16,
    display_host: &str,
    tls: bool,
    client: &str,
    device_id: &str,
) -> String {
    if device_id.is_empty() {
        return String::new();
    }
    let cfg_file = match client {
        "workbuddy" => "~/.workbuddy/mcp.json",
        "codex" => "~/.codex/config.toml",
        _ => return String::new(),
    };
    let entry = entry_name(device_id);
    // 🔴 WorkBuddy 的结束锚用「行首可空白的 `}`」而不是原来的 `"Authorization"`：
    // 后者在条目缺 headers 时**永不命中**，GNU sed 的地址范围会一路作用到文件末尾，
    // 把后面其它设备的 url 一起改写——正是 scoped sed 要防的互踢（审查 P2）。
    // JSON 里每个条目必然有闭合花括号，它比「可选内容」可靠。
    // 只要求「行首 }」而不是精确缩进：任何合法排版下都能收住，最坏是提前结束
    // （url 行在 headers 之前，替换照常发生），永远不会越界。
    //
    // 🔴 另：原实现写 `\\{{`（输出 `\{`），而 `\{` 在 BRE 里是区间量词的开始，
    // 单独出现时 GNU sed 直接 `Unmatched \{` 退出 1——**多设备 + WorkBuddy 的
    // IP 修复命令 100% 失败**（审查 B3）。裸 `{` 才是字面花括号。
    let range = match client {
        "codex" => format!("/^\\[mcp_servers\\.{entry}\\]/,/^\\[/"),
        _ => format!("/\"{entry}\": {{/,/^ *}}/"),
    };
    let scheme = if tls { "https" } else { "http" };
    let expr =
        format!("{range} s#https\\?://[0-9.]*:{port}/mcp#{scheme}://{display_host}:{port}/mcp#g");
    sed_in_place(&expr, cfg_file)
}

/// 当前配置 → 「原地更新接入」的命令 + 作用域标签（展示给用户的后缀说明）。
///
/// 托盘「复制IP替换命令」与 `get_ip_sed_command` 命令共用这里（单一真源）。
/// `cmd` 为空 = 通用 MCP 工具无约定路径，调用方给「手动更新」提示而不是复制空串。
///
/// 多设备模式（opt-in，仅 claude-code）：产物从 sed（URL 全局替换会改写双条目）
/// 换成条目级 remove+add；标签同步换「多设备模式 · 条目 cc-bridge-<id>」。
/// 关闭时走原 sed 路径，逐字与旧版一致。
pub struct IpUpdateTarget<'a> {
    pub host: &'a str,
    pub port: u16,
    pub token: &'a str,
    /// `"http"` | `"sse"`（多设备命令的 --transport 参数与 URL 后缀）。
    pub transport: &'a str,
    pub last_selected_ip: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub project_path: Option<&'a str>,
    pub tls: bool,
    pub client: &'a str,
    /// 多设备模式开关（opt-in）。true 且 device_id 非空时：claude-code 换条目级
    /// remove+add；codex/workbuddy 换条目锚定 scoped sed；generic 维持原路径。
    pub multi_device: bool,
    pub device_id: &'a str,
}

pub fn ip_update_command(t: IpUpdateTarget<'_>) -> (String, String) {
    let lan_ips = get_lan_ips();
    let display_host = resolve_display_host(t.host, &lan_ips, t.last_selected_ip);
    if t.multi_device && !t.device_id.is_empty() {
        match t.client {
            "claude-code" => {
                let cmd = build_multi_device_command(
                    t.port,
                    &display_host,
                    t.token,
                    t.transport,
                    t.tls,
                    t.device_id,
                );
                let label = if cmd.is_empty() {
                    String::new()
                } else {
                    format!("多设备模式 · 条目 cc-bridge-{}", t.device_id)
                };
                return (cmd, label);
            }
            // 批3-2：Codex/WorkBuddy 没有可靠的条目级 CLI（Codex CLI 令牌只能走环境
            // 变量、WorkBuddy CLI 写入路径与品牌路径分歧），IP 修复用条目锚定 scoped
            // sed——与 claude-code 的 CLI 形态同缺一不可的「只动自己条目」性质。
            "codex" | "workbuddy" => {
                let cmd =
                    build_scoped_sed_command(t.port, &display_host, t.tls, t.client, t.device_id);
                let label = if cmd.is_empty() {
                    String::new()
                } else {
                    format!("多设备模式 · 条目 cc-bridge-{}", t.device_id)
                };
                return (cmd, label);
            }
            _ => {}
        }
    }
    let scope_str = t.scope.unwrap_or("user");
    let project_path_owned = t.project_path.map(str::to_string);
    let cmd = build_ip_sed_command(
        t.port,
        &display_host,
        scope_str,
        &project_path_owned,
        t.tls,
        t.client,
    );
    // 目标文件随客户端而变（Claude Code 两档作用域 / WorkBuddy / Codex）。
    let scope_label = match t.client {
        "workbuddy" => "WorkBuddy ~/.workbuddy/mcp.json".to_string(),
        "codex" => "Codex ~/.codex/config.toml".to_string(),
        "generic" => String::new(),
        _ => {
            if scope_str == "project" {
                if t.project_path.map(str::trim).unwrap_or("").is_empty() {
                    "项目级 .mcp.json（请在项目目录下执行）".to_string()
                } else {
                    "项目级 .mcp.json".to_string()
                }
            } else {
                "用户级 ~/.claude.json".to_string()
            }
        }
    };
    (cmd, scope_label)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 回归（审查 P2）：显式绑回环时**不能**回退到 LAN IP。
    ///
    /// `get_lan_ips` 排除 127.*，所以旧实现里「host 在网卡里」这条恒假 →
    /// 托盘会复制出一个服务根本没在监听的地址。
    #[test]
    fn resolve_display_host_keeps_loopback() {
        let lan = vec!["192.168.1.20".to_string(), "10.0.0.5".to_string()];
        assert_eq!(
            resolve_display_host("127.0.0.1", &lan, None),
            "127.0.0.1",
            "绑回环时必须原样给出回环地址"
        );
        assert_eq!(resolve_display_host("[::1]", &lan, None), "[::1]");
        assert_eq!(resolve_display_host("localhost", &lan, None), "localhost");
        // 0.0.0.0 仍按原语义取 LAN 首选地址
        assert_eq!(resolve_display_host("0.0.0.0", &lan, None), "192.168.1.20");
        // 已失效的具体地址仍回退到首选网卡
        assert_eq!(
            resolve_display_host("192.168.9.9", &lan, None),
            "192.168.1.20"
        );
    }

    #[test]
    fn build_ip_sed_command_user_scope() {
        let cmd = build_ip_sed_command(7823, "192.168.1.100", "user", &None, false, "claude-code");
        // 合法 sed 分隔符 # 必须恰好 3 个（s#pat#rep#g），且 /mcp 应位于 pattern 与 replacement 内部。
        assert_eq!(cmd.matches('#').count(), 3, "sed 分隔符 # 应为 3 个");
        assert!(
            cmd.contains("https\\?://[0-9.]*:7823/mcp"),
            "pattern 应内嵌 /mcp，且用 https\\? 同时覆盖 http/https 旧值"
        );
        assert!(
            cmd.contains("http://192.168.1.100:7823/mcp"),
            "replacement 应内嵌 /mcp"
        );
        // 目标文件在命令尾部，但末尾还跟着便携式清理（`&& rm -f <file>.bak`），
        // 所以判据用 contains 而不是 ends_with。
        assert!(
            cmd.contains("sed -i.bak")
                && cmd.contains("~/.claude.json ")
                && cmd.contains("~/.claude.json.bak"),
            "user 级目标文件应为 ~/.claude.json（GNU/BSD 通用写法 + 清理备份）：{cmd}"
        );
        assert!(!cmd.contains("cd "), "user 级不应含 cd 前缀");
        assert!(
            !cmd.contains("#/mcp#"),
            "不应出现坏的分隔（/mcp 落在分隔符位置）"
        );
    }

    #[test]
    fn build_ip_sed_command_project_with_path() {
        let cmd = build_ip_sed_command(
            7823,
            "192.168.1.100",
            "project",
            &Some("/d/work/my-proj".into()),
            false,
            "claude-code",
        );
        assert!(
            cmd.starts_with("cd \"/d/work/my-proj\" && "),
            "project+路径应含 cd 前缀"
        );
        assert!(
            cmd.contains(".mcp.json ") && cmd.contains(".mcp.json.bak"),
            "project 级目标文件应为 .mcp.json：{cmd}"
        );
        assert_eq!(cmd.matches('#').count(), 3, "sed 分隔符 # 应为 3 个");
    }

    #[test]
    fn build_ip_sed_command_project_without_path() {
        let cmd = build_ip_sed_command(
            7823,
            "192.168.1.100",
            "project",
            &None,
            false,
            "claude-code",
        );
        assert!(!cmd.contains("cd "), "project+无路径不应含 cd 前缀");
        assert!(
            cmd.contains(".mcp.json ") && cmd.contains(".mcp.json.bak"),
            "project 级目标文件应为 .mcp.json：{cmd}"
        );
    }

    /// 多客户端（身份转变后新增）：目标文件随 client 分流；generic 无约定路径 → 空串。
    #[test]
    fn build_ip_sed_command_multi_client() {
        let wb = build_ip_sed_command(7823, "192.168.1.100", "user", &None, false, "workbuddy");
        assert!(
            wb.contains("~/.workbuddy/mcp.json ") && wb.contains("~/.workbuddy/mcp.json.bak"),
            "WorkBuddy 目标文件：{wb}"
        );
        assert!(!wb.contains("cd "), "WorkBuddy 是全局配置，不应有 cd 前缀");

        let cx = build_ip_sed_command(7823, "192.168.1.100", "user", &None, true, "codex");
        assert!(
            cx.contains("~/.codex/config.toml ") && cx.contains("~/.codex/config.toml.bak"),
            "Codex 目标文件：{cx}"
        );
        assert!(
            cx.contains("https://192.168.1.100:7823/mcp"),
            "TLS 开启时替换段应为 https（且 Codex 忽略 scope）"
        );

        assert_eq!(
            build_ip_sed_command(7823, "192.168.1.100", "user", &None, false, "generic"),
            "",
            "通用工具无约定配置文件 → 空串（调用方转成手动更新提示）"
        );
    }

    #[test]
    fn ip_sed_for_labels() {
        // 标签文案是展示层合同的一部分，跟命令一起随客户端/作用域变。
        let (_, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "t",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "claude-code",
            multi_device: false,
            device_id: "",
        });
        assert_eq!(label, "用户级 ~/.claude.json");

        let (_, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "t",
            transport: "http",
            last_selected_ip: None,
            scope: Some("project"),
            project_path: Some("  "), // 空白路径视同无路径
            tls: false,
            client: "claude-code",
            multi_device: false,
            device_id: "",
        });
        assert_eq!(label, "项目级 .mcp.json（请在项目目录下执行）");

        let (_, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "t",
            transport: "http",
            last_selected_ip: None,
            scope: Some("project"),
            project_path: Some("D:/proj"),
            tls: false,
            client: "claude-code",
            multi_device: false,
            device_id: "",
        });
        assert_eq!(label, "项目级 .mcp.json");

        let (_, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "t",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "workbuddy",
            multi_device: false,
            device_id: "",
        });
        assert_eq!(label, "WorkBuddy ~/.workbuddy/mcp.json");

        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "t",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "generic",
            multi_device: false,
            device_id: "",
        });
        assert_eq!(cmd, "");
        assert_eq!(label, "");
    }

    /// 多设备模式（opt-in）命令形态：条目级 remove+add，标签带条目名。
    #[test]
    fn multi_device_update_command() {
        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "tok",
            transport: "http",
            last_selected_ip: None,
            scope: Some("project"), // 多设备模式忽略 scope，固定 user 级
            project_path: Some("/d/proj"),
            tls: false,
            client: "claude-code",
            multi_device: true,
            device_id: "a3f2",
        });
        assert!(
            cmd.starts_with("claude mcp remove cc-bridge-a3f2 2>/dev/null\nclaude mcp add cc-bridge-a3f2 -s user --transport http"),
            "应为条目级 remove+add 且固定 user 级：{cmd}"
        );
        // 展示 IP 由 resolve_display_host 依真实网卡回退，测试机相关——只断言端口/路径结构。
        assert!(cmd.contains(":7823/mcp"), "URL 应含端口与 /mcp：{cmd}");
        assert!(cmd.contains("Bearer tok"), "token 应内联");
        assert!(
            !cmd.contains("sed -i"),
            "多设备模式不应再出 sed（会全局改写双条目）"
        );
        assert_eq!(label, "多设备模式 · 条目 cc-bridge-a3f2");
    }

    /// 兼容性契约：开关关闭时产物与旧版逐字一致（同入参走 sed 路径）。
    #[test]
    fn multi_device_off_keeps_sed() {
        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "tok",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "claude-code",
            multi_device: false,
            device_id: "a3f2",
        });
        assert!(cmd.starts_with("sed -i.bak '"), "关闭时必须仍是 sed：{cmd}");
        assert!(!cmd.contains("claude mcp"), "关闭时不得混入条目级命令");
        assert_eq!(label, "用户级 ~/.claude.json");
    }

    /// 开关开启但 device_id 尚未生成（遗留配置异常态）：回退原 sed 路径而不是出坏命令。
    /// 批3 起与前端 IpChangedBanner 的 fallback 语义对齐（此前 Rust 返空串、前端回退
    /// sed，双端不一致）——sed 对本机永远是正确的单设备命令，比空串有用。
    #[test]
    fn multi_device_without_device_id_falls_back_to_sed() {
        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "tok",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "claude-code",
            multi_device: true,
            device_id: "",
        });
        assert!(
            cmd.starts_with("sed -i.bak '"),
            "device_id 缺失应回退 sed：{cmd}"
        );
        assert!(!cmd.contains("claude mcp"), "不得出半截条目级命令：{cmd}");
        assert_eq!(label, "用户级 ~/.claude.json");
    }

    /// 多设备命令的 SSE/TLS 形态：URL 后缀与 --transport 跟随，scheme 跟随 TLS。
    #[test]
    fn multi_device_sse_tls_variants() {
        let sse = build_multi_device_command(7823, "10.0.0.5", "tok", "sse", false, "b7c1");
        assert!(sse.contains("--transport sse"), "{sse}");
        assert!(sse.contains("http://10.0.0.5:7823/mcp/sse"), "{sse}");
        let tls = build_multi_device_command(7823, "10.0.0.5", "tok", "http", true, "b7c1");
        assert!(tls.contains("https://10.0.0.5:7823/mcp"), "{tls}");
    }

    /// 批3-2：多设备模式下 Codex 的 IP 修复 = 条目锚定 scoped sed（TOML 段头行锚点）。
    #[test]
    fn multi_device_scoped_sed_codex() {
        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "tok",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "codex",
            multi_device: true,
            device_id: "a3f2",
        });
        // 地址范围：从本条目段头到下一个段头（TOML 规范保证段头行首 [）。
        assert!(
            cmd.starts_with(
                "sed -i.bak '/^\\[mcp_servers\\.cc-bridge-a3f2\\]/,/^\\[/ s#https\\?://[0-9.]*:7823/mcp#"
            ),
            "应为条目锚定的 scoped sed：{cmd}"
        );
        assert!(
            cmd.ends_with("' ~/.codex/config.toml && rm -f ~/.codex/config.toml.bak"),
            "目标文件与便携收尾：{cmd}"
        );
        assert!(!cmd.contains("sed -i 's#"), "不得退回全局替换形态：{cmd}");
        assert_eq!(label, "多设备模式 · 条目 cc-bridge-a3f2");
    }

    /// 批3-2：多设备模式下 WorkBuddy 的 IP 修复 = JSON 条目键锚定的 scoped sed。
    #[test]
    fn multi_device_scoped_sed_workbuddy() {
        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "tok",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: true,
            client: "workbuddy",
            multi_device: true,
            device_id: "b7c1",
        });
        // 🔴 回归断言（审查 B3）：输出里绝不能出现 `\{`。
        // `\{` 在 BRE 是区间量词的开始，单独出现时 GNU sed 直接 `Unmatched \{` 退出 1，
        // 曾让「多设备 + WorkBuddy」的 IP 修复命令 100% 失败。
        assert!(!cmd.contains("\\{"), "不得出现 \\{{（非法 BRE）：{cmd}");
        assert!(
            cmd.starts_with("sed -i.bak '/\"cc-bridge-b7c1\": {/,/^ *}/ s#"),
            "应为 JSON 条目键锚定 + 花括号收尾：{cmd}"
        );
        assert!(
            !cmd.contains("\"Authorization\""),
            "结束锚不得依赖可选的 Authorization 行（缺它时会一路作用到文件末尾）：{cmd}"
        );
        assert!(
            cmd.contains("#https://"),
            "TLS 开启时替换段应为 https：{cmd}"
        );
        assert!(
            cmd.ends_with("' ~/.workbuddy/mcp.json && rm -f ~/.workbuddy/mcp.json.bak"),
            "目标文件与便携收尾：{cmd}"
        );
        assert_eq!(label, "多设备模式 · 条目 cc-bridge-b7c1");
    }

    /// 回归（审查 P2）：路径含双引号 / `$()` / 反引号时必须转义，
    /// 否则 `cd "…"` 会被截断，甚至把 `$(…)` 当命令执行。
    #[test]
    fn ip_sed_escapes_project_path() {
        let cmd = build_ip_sed_command(
            7823,
            "10.0.0.8",
            "project",
            &Some("/tmp/a \"b\" $(whoami) `id`".to_string()),
            false,
            "claude-code",
        );
        assert!(
            cmd.starts_with("cd \"/tmp/a \\\"b\\\" \\$(whoami) \\`id\\`\" && "),
            "{cmd}"
        );
        assert!(cmd.contains(".mcp.json"), "{cmd}");
    }

    /// 回归（审查 P2）：原地编辑必须用 `-i.bak && rm -f` 形态，
    /// BSD/macOS 的 `sed -i` 不带后缀参数会直接报错。
    #[test]
    fn ip_sed_is_portable_across_gnu_and_bsd() {
        let cmd = build_ip_sed_command(7823, "10.0.0.8", "user", &None, false, "claude-code");
        assert!(cmd.contains("sed -i.bak '"), "{cmd}");
        assert!(
            cmd.ends_with("~/.claude.json && rm -f ~/.claude.json.bak"),
            "{cmd}"
        );
    }

    /// 批3-2：多设备但 device_id 为空（异常态）→ codex/workbuddy 退回原 sed，不出坏范围。
    #[test]
    fn multi_device_scoped_sed_without_device_id_falls_back() {
        let (cmd, label) = ip_update_command(IpUpdateTarget {
            host: "127.0.0.1",
            port: 7823,
            token: "tok",
            transport: "http",
            last_selected_ip: None,
            scope: None,
            project_path: None,
            tls: false,
            client: "codex",
            multi_device: true,
            device_id: "",
        });
        assert!(cmd.starts_with("sed -i.bak 's#"), "应退回全局 sed：{cmd}");
        assert_eq!(label, "Codex ~/.codex/config.toml");
    }

    /// 批3-2：多设备模式下接入片段的条目名带尾号（WorkBuddy JSON / Codex TOML）。
    #[test]
    fn connect_snippet_entry_suffix_in_multi_device() {
        let lan = vec!["192.168.1.100".to_string()];
        let wb = build_connect_command(ConnectTarget {
            host: "0.0.0.0",
            port: 7823,
            token: "tok",
            transport: "http",
            tls: false,
            client: "workbuddy",
            lan_ips: &lan,
            selected_ip: None,
            multi_device: true,
            device_id: "a3f2",
        });
        assert!(
            wb.contains("\"cc-bridge-a3f2\""),
            "WorkBuddy 条目名应带尾号：{wb}"
        );
        assert!(!wb.contains("\"cc-bridge\""), "不得残留无尾号条目名：{wb}");

        let cx = build_connect_command(ConnectTarget {
            host: "0.0.0.0",
            port: 7823,
            token: "tok",
            transport: "http",
            tls: false,
            client: "codex",
            lan_ips: &lan,
            selected_ip: None,
            multi_device: true,
            device_id: "a3f2",
        });
        assert!(
            cx.contains("[mcp_servers.cc-bridge-a3f2]"),
            "Codex 段头应带尾号：{cx}"
        );

        // 兼容性契约：开关关闭（或 device_id 空）→ 条目名维持 cc-bridge，逐字与旧版一致。
        let off = build_connect_command(ConnectTarget {
            host: "0.0.0.0",
            port: 7823,
            token: "tok",
            transport: "http",
            tls: false,
            client: "workbuddy",
            lan_ips: &lan,
            selected_ip: None,
            multi_device: false,
            device_id: "a3f2",
        });
        assert!(
            off.contains("\"cc-bridge\""),
            "关闭时条目名必须保持 cc-bridge：{off}"
        );
    }

    /// 批3-2：scoped sed 的裸函数边界——device_id 空/未知客户端返回空串。
    #[test]
    fn scoped_sed_edge_cases() {
        assert_eq!(
            build_scoped_sed_command(7823, "10.0.0.5", false, "codex", ""),
            ""
        );
        assert_eq!(
            build_scoped_sed_command(7823, "10.0.0.5", false, "claude-code", "a3f2"),
            "",
            "claude-code 不走 scoped sed（它有条目级 CLI）"
        );
    }
}
