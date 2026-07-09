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

pub fn build_connect_command(host: &str, port: u16, token: &str) -> String {
    let display_host = if host == "0.0.0.0" {
        let lan_ips = get_lan_ips();
        lan_ips
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".into())
    } else {
        host.into()
    };

    format!(
        "claude mcp add --transport http cc-bridge http://{}:{}/mcp --header \"Authorization: Bearer {}\"",
        display_host, port, token
    )
}
