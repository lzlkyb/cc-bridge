//! 地址变化通知 API 行为探针（一次性诊断工具，不进 Cargo 工程）。
//!
//! 背景：cc-bridge-desktop 曾有一个线程常驻 100% 单核。原因是 `ip_watch.rs` 用
//! winsock2 的 `SIO_ADDRESS_LIST_CHANGE`，并把 `-1 + WSAEFAULT(10014)` 当成「地址已变化」。
//! 本探针用于：
//! 1. 复现旧实现的缺陷（证明那个 ioctl 不阻塞）；
//! 2. 验证新实现用的 `NotifyAddrChange` 确实会阻塞（避免换个 API 又踩同一个坑）。
//!
//! 编译运行（注意 -o 用相对路径，给 /tmp/... 会被 link.exe 当成选项）：
//!   rustc ip_watch_probe.rs -O -o ip_watch_probe.exe && ./ip_watch_probe.exe
//!
//! 预期输出：ioctl 部分全部 ~0.000ms 返回 wsaerr=10014；
//! NotifyAddrChange 部分在无网络变动时一直不返回（靠外部 timeout 杀掉）。

use std::net::UdpSocket;
use std::os::windows::io::AsRawSocket;
use std::time::Instant;

const SIO_ADDRESS_LIST_CHANGE: u32 = 0x4800_0016;

#[link(name = "ws2_32")]
extern "system" {
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
    fn WSAGetLastError() -> i32;
}

#[link(name = "iphlpapi")]
extern "system" {
    fn NotifyAddrChange(handle: *mut usize, overlapped: *mut u8) -> u32;
}

fn probe_old_ioctl() {
    println!("[1] 旧实现：WSAIoctl(SIO_ADDRESS_LIST_CHANGE)，cbOutBuffer=0");
    let socket = UdpSocket::bind("0.0.0.0:0").expect("bind failed");
    let raw = socket.as_raw_socket() as usize;
    for i in 1..=5 {
        let mut bytes_returned = 0u32;
        let t0 = Instant::now();
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
        let err = if ret == 0 { 0 } else { unsafe { WSAGetLastError() } };
        let ms = t0.elapsed().as_micros() as f64 / 1000.0;
        println!("    #{i}: ret={ret} wsaerr={err} 耗时={ms:.3}ms");
        if ms > 1000.0 {
            println!("    → 该调用会阻塞（与历史结论不同，请重新评估）。");
            return;
        }
    }
    println!("    → 5 次全部立即返回：不阻塞。旧代码将其当事件 ⇒ 空转烧掉一个核。");
}

fn probe_new_notify() {
    println!();
    println!("[2] 新实现：NotifyAddrChange(NULL, NULL)（同步阻塞模式）");
    println!("    若接下来一直无输出、靠外部 timeout 结束 → 确认它真的在阻塞等（这是我们要的）。");
    println!("    若立即打印出耗时 → 它也不阻塞，新实现必须靠限流护栏兜底。");
    let t0 = Instant::now();
    let ret = unsafe { NotifyAddrChange(std::ptr::null_mut(), std::ptr::null_mut()) };
    let ms = t0.elapsed().as_micros() as f64 / 1000.0;
    println!("    返回：ret={ret} 耗时={ms:.3}ms");
    if ms < 50.0 {
        println!("    → 立即返回，不能单靠它阻塞！");
    } else {
        println!("    → 阻塞了 {ms:.0}ms 后返回（期间应有真实网络变动）。");
    }
}

fn main() {
    probe_old_ioctl();
    probe_new_notify();
}
