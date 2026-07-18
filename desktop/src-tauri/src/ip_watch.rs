//! Windows 本机地址变化事件监听（事件驱动，替代 15s 轮询）。
//!
//! 使用 winsock2 `SIO_ADDRESS_LIST_CHANGE` ioctl：在专用阻塞线程上等待 OS 通知。
//! 纯 raw FFI 调用，零额外 crate 依赖，不触发 windows-rs 的 Winsock 初始化
//! （避免 GUI 子系统下 DLL 加载期分配控制台导致启动闪黑窗）。

/// SIO_ADDRESS_LIST_CHANGE control code
const SIO_ADDRESS_LIST_CHANGE: u32 = 0x4800_0016;

extern "system" {
    /// winsock2 WSAIoctl — 阻塞等待地址列表变化
    fn WSAIoctl(
        s: usize,
        dw_io_control_code: u32,
        lpv_in_buffer: *const u8,
        cb_in_buffer: u32,
        lpv_out_buffer: *mut u8,
        cb_out_buffer: u32,
        lpcb_bytes_returned: *mut u32,
        lp_overlapped: *mut u8,
        lp_completion_routine: usize,
    ) -> i32;
}

#[cfg(windows)]
mod imp {
    use std::net::UdpSocket;
    use std::os::windows::io::AsRawSocket;
    use std::thread;
    use tokio::sync::mpsc;

    use super::{WSAIoctl, SIO_ADDRESS_LIST_CHANGE};

    /// 启动一个阻塞线程监听本机地址变化，通过 channel 通知 async 端。
    /// 传出的 `UdpSocket` 供调用方持有：drop 时关闭 socket → 阻塞的 WSAIoctl 返回错误 → 线程退出。
    pub fn spawn(tx: mpsc::UnboundedSender<()>) -> UdpSocket {
        let socket = UdpSocket::bind("0.0.0.0:0").expect("ip-watch: bind failed");
        let raw = socket.as_raw_socket() as usize;

        thread::spawn(move || loop {
            let mut bytes_returned = 0u32;
            // SAFETY: raw 是当前线程持有的 UdpSocket 的 SOCKET 句柄；
            // 所有指针参数为 null/零长度，不涉及缓冲区越界。
            let ret = unsafe {
                WSAIoctl(
                    raw,
                    SIO_ADDRESS_LIST_CHANGE,
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut bytes_returned,
                    std::ptr::null_mut(),
                    0,
                )
            };
            // 返回 0 表示成功（地址变化），SOCKET_ERROR(-1) + WSAEFAULT(10014) 也是
            // 正常返回码（无 output buffer 时 ioctl 用它表示"有数据准备好"）。
            // 其他错误（如 socket 关闭 = WSAENOTSOCK 10038）→ 线程退出。
            if ret == 0 || ret == -1 {
                let _ = tx.send(());
            } else {
                break;
            }
        });

        socket
    }
}

#[cfg(not(windows))]
mod imp {
    use std::net::UdpSocket;
    use tokio::sync::mpsc;

    pub fn spawn(_tx: mpsc::UnboundedSender<()>) -> UdpSocket {
        UdpSocket::bind("0.0.0.0:0").expect("ip-watch: bind failed")
    }
}

pub use imp::spawn;
