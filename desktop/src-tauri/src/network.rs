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
pub fn build_connect_command(
    host: &str,
    port: u16,
    token: &str,
    lan_ips: &[String],
    selected_ip: Option<&str>,
    transport: &str,
) -> String {
    let display_host = resolve_display_host(host, lan_ips, selected_ip);
    let url_suffix = if transport == "sse" {
        "/mcp/sse"
    } else {
        "/mcp"
    };

    format!(
        "claude mcp add --transport {} cc-bridge http://{}:{}{} --header \"Authorization: Bearer {}\"",
        transport, display_host, port, url_suffix, token
    )
}

/// 生成「网络变动时原地更新 IP」的 sed 命令，**严格对齐前端 `IpChangedBanner.buildSed`**：
/// - user 级：`sed -i 's#...#...#g' ~/.claude.json`
/// - project 级 + 有项目路径：`cd "<path>" && sed -i 's#...#...#g' .mcp.json`
/// - project 级 + 无路径：`sed -i 's#...#...#g' .mcp.json`（提示在项目目录执行）
///
/// 作用域与项目路径**跟随用户在连接页的选择**（方案 A）：托盘读 `config.scope` / `config.project_path`，
/// 与连接页复制的命令逐字等价（含 cd 前缀），不再是固定用户级。
pub fn build_ip_sed_command(
    port: u16,
    display_host: &str,
    scope: &str,
    project_path: &Option<String>,
) -> String {
    let cfg_file = if scope == "project" {
        ".mcp.json"
    } else {
        "~/.claude.json"
    };
    let cd_prefix = if scope == "project" {
        if let Some(p) = project_path {
            let t = p.trim();
            if !t.is_empty() {
                format!("cd \"{t}\" && ")
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    format!(
        "{cd_prefix}sed -i 's#http://[0-9.]*:{port}/mcp#http://{display_host}:{port}/mcp#g' {cfg_file}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_ip_sed_command_user_scope() {
        let cmd = build_ip_sed_command(7823, "192.168.1.100", "user", &None);
        // 合法 sed 分隔符 # 必须恰好 3 个（s#pat#rep#g），且 /mcp 应位于 pattern 与 replacement 内部。
        assert_eq!(cmd.matches('#').count(), 3, "sed 分隔符 # 应为 3 个");
        assert!(
            cmd.contains("http://[0-9.]*:7823/mcp"),
            "pattern 应内嵌 /mcp"
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
        let cmd = build_ip_sed_command(7823, "192.168.1.100", "project", &None);
        assert!(!cmd.contains("cd "), "project+无路径不应含 cd 前缀");
        assert!(
            cmd.ends_with(".mcp.json"),
            "project 级目标文件应为 .mcp.json"
        );
    }
}
