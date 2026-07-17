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
) -> String {
    let display_host = resolve_display_host(host, lan_ips, selected_ip);

    format!(
        "claude mcp add --transport http cc-bridge http://{}:{}/mcp --header \"Authorization: Bearer {}\"",
        display_host, port, token
    )
}

/// 生成「网络变动时原地更新 IP」的 sed 命令（用户级 `~/.claude.json`）。
///
/// 与前端 `IpChangedBanner.buildSed("user")` 等价：用 `[0-9.]*` 匹配任意旧 IP，幂等可重跑，
/// 不动 Bearer、不 remove+add，保留 server 条目与授权状态，远端无需重新 approve。
///
/// WHY（托盘项）：托盘右键「复制 IP 替换命令」在 Rust 端生成、直接写剪贴板（不依赖 webview 焦点）。
/// 托盘项无 projectPath 上下文，故固定输出用户级（`~/.claude.json`）；
/// 项目级（`.mcp.json`，需 `cd <projectPath>`）替换请在连接页 `IpChangedBanner` 复制带 cd 的精确命令。
pub fn build_ip_sed_command(port: u16, display_host: &str) -> String {
    format!(
        "sed -i 's#http://[0-9.]*:{}#/mcp#http://{}:{}#/mcp#g' ~/.claude.json",
        port, display_host, port
    )
}
