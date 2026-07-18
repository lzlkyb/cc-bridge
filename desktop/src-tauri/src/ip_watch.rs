//! Windows 本机地址变化事件监听（事件驱动，替代 15s 轮询）。
//!
//! 使用 winsock2 `SIO_ADDRESS_LIST_CHANGE` ioctl：在专用线程上阻塞等待，
//! 操作系统在 IP 地址增加/删除/变化时唤醒。相比 `get_lan_ips()` 轮询：
//! - 零 CPU 开销（线程在 OS 内核态休眠，不占调度片）
//! - 即时感知（IP 变化即刻通知，轮询最多 15s 延迟）
//! - 不影响体积红线（复用已有的 windows 0.56 绑定，无新增依赖）

#[cfg(windows)]
mod imp {
    use std::net::UdpSocket;
    use std::os::windows::io::AsRawSocket;
    use std::thread;
    use tokio::sync::mpsc;
    use windows::Win32::Networking::WinSock::{
        WSAIoctl, SIO_ADDRESS_LIST_CHANGE, SOCKET, WSAEFAULT,
    };

    /// 启动一个阻塞线程监听本机地址变化，通过 channel 通知 async 端。
    /// 传出的 `UdpSocket` 用于关闭时中断阻塞的 `WSAIoctl`。
    pub fn spawn(tx: mpsc::UnboundedSender<()>) -> UdpSocket {
        let socket = UdpSocket::bind("0.0.0.0:0").expect("ip-watch: bind failed");
        let raw = socket.as_raw_socket();
        let sock = SOCKET(raw as _);

        thread::spawn(move || {
            loop {
                let mut bytes_returned = 0u32;
                let result = unsafe {
                    WSAIoctl(
                        sock,
                        SIO_ADDRESS_LIST_CHANGE,
                        None,
                        0,
                        None,
                        0,
                        &mut bytes_returned,
                        None,
                        None,
                    )
                };

                // SIO_ADDRESS_LIST_CHANGE: 返回 0 或 WSAEFAULT 均表示地址变化（后者是
                // ioctl 无 output buffer 时的正常返回码，意为"有数据准备好"）。
                if result == 0 || result == WSAEFAULT.0 as i32 {
                    let _ = tx.send(());
                } else {
                    // socket 被关闭（shutdown）或其他不可恢复错误 → 退出线程
                    break;
                }
            }
        });

        socket
    }
}

#[cfg(not(windows))]
mod imp {
    use std::net::UdpSocket;
    use tokio::sync::mpsc;

    /// 非 Windows：fallback 不启动监听（仍由调用方按需轮询）。
    pub fn spawn(_tx: mpsc::UnboundedSender<()>) -> UdpSocket {
        UdpSocket::bind("0.0.0.0:0").expect("ip-watch: bind failed")
    }
}

pub use imp::spawn;
