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
    } else if lan_ips.iter().any(|x| x == host) {
        host.to_string()
    } else {
        // 配置的具体地址已不可用,回退到默认路由网卡
        lan_ips.first().cloned().unwrap_or_else(|| host.to_string())
    }
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
            let snippet = serde_json::json!({
                "mcpServers": {
                    "cc-bridge": {
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
        "codex" => format!(
            "# 写入 ~/.codex/config.toml（保存后重启 Codex）\n[mcp_servers.cc-bridge]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"Bearer {token}\" }}"
        ),
        // 通用工具没有约定的配置载体，给「事实清单」而不是假装这是一条命令。
        "generic" => format!("URL: {url}\nHeader: Authorization: Bearer {token}"),
        // 默认（含 None / 未知值）：Claude Code 的 CLI 命令。
        _ => format!(
            "claude mcp add --transport {} cc-bridge {url} --header \"Authorization: Bearer {token}\"",
            t.transport
        ),
    }
}

/// 生成「网络变动时原地更新 IP」的 sed 命令，**严格对齐前端 `IpChangedBanner.buildSed`**：
/// - Claude Code · user 级：`sed -i 's#...#...#g' ~/.claude.json`
/// - Claude Code · project 级 + 有项目路径：`cd "<path>" && sed -i 's#...#...#g' .mcp.json`
/// - Claude Code · project 级 + 无路径：`sed -i 's#...#...#g' .mcp.json`（提示在项目目录执行）
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
                    .map(|t| format!("cd \"{t}\" && "))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            (cfg.to_string(), cd)
        }
    };
    let scheme = if tls { "https" } else { "http" };
    format!(
        "{cd_prefix}sed -i 's#https\\?://[0-9.]*:{port}/mcp#{scheme}://{display_host}:{port}/mcp#g' {cfg_file}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(
            cmd.ends_with("~/.claude.json"),
            "user 级目标文件应为 ~/.claude.json"
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
            cmd.ends_with(".mcp.json"),
            "project 级目标文件应为 .mcp.json"
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
            cmd.ends_with(".mcp.json"),
            "project 级目标文件应为 .mcp.json"
        );
    }

    /// 多客户端（身份转变后新增）：目标文件随 client 分流；generic 无约定路径 → 空串。
    #[test]
    fn build_ip_sed_command_multi_client() {
        let wb = build_ip_sed_command(7823, "192.168.1.100", "user", &None, false, "workbuddy");
        assert!(wb.ends_with("~/.workbuddy/mcp.json"), "WorkBuddy 目标文件");
        assert!(!wb.contains("cd "), "WorkBuddy 是全局配置，不应有 cd 前缀");

        let cx = build_ip_sed_command(7823, "192.168.1.100", "user", &None, true, "codex");
        assert!(cx.ends_with("~/.codex/config.toml"), "Codex 目标文件");
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
}
