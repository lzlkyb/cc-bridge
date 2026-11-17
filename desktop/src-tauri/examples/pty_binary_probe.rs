//! P1 探针：ConPTY 通道能否承载二进制协议（B 方案前置问题）。
//!
//! B 方案设想「借已认证会话讲 SFTP v3 协议」，而本项目唯一的已认证长会话是
//! helper（ConPTY + UTF-8 文本）。SFTP 帧是二进制。本探针实测三个场景：
//!   S1 输出方向·默认：slave 直接写全 256 字节 → master 读到什么
//!   S2 输出方向·raw：slave 先 `stty raw` 再写 → 能否绕过终端转换
//!   S3 输入方向·raw：slave 先 `stty raw` 再 read 回显 → master 写的字节能否原样抵达
//! 跑法：`cargo run --example pty_binary_probe`

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 场景 → slave 侧 python 脚本。
fn slave_script(scenario: &str) -> String {
    match scenario {
        // S1/S2：不读 stdin，直接输出全 256 字节（hex 前缀便于定位）。
        "s1" => "import sys;sys.stdout.buffer.write(bytes(range(256)));sys.stdout.buffer.flush()".into(),
        "s2" => "import sys,os;os.system('stty raw -echo');sys.stdout.buffer.write(bytes(range(256)));sys.stdout.buffer.flush()".into(),
        // S3：raw 后读 256 字节，用 hex 回替代原文（避免 <...> 标记定位被回显干扰）。
        "s3" => concat!(
            "import sys,os;os.system('stty raw -echo');",
            "d=sys.stdin.buffer.read(256);",
            "sys.stdout.buffer.write(b'LEN=' + str(len(d)).encode() + b'\\n');",
            "sys.stdout.buffer.write(d.hex().encode());",
            "sys.stdout.buffer.flush()"
        )
        .into(),
        _ => unreachable!(),
    }
}

fn main() {
    for scenario in ["s1", "s2", "s3"] {
        run_scenario(scenario);
    }
}

fn run_scenario(scenario: &str) {
    println!("\n================ 场景 {scenario} ================");
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 40,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let mut cmd = CommandBuilder::new("python");
    cmd.args(["-c", &slave_script(scenario)]);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn python");
    let mut writer = pair.master.take_writer().expect("writer");
    let mut reader = pair.master.try_clone_reader().expect("reader");

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // S3 需要 master 先写，S1/S2 由 slave 主动输出。
    if scenario == "s3" {
        let payload: Vec<u8> = (0..=255u8).collect();
        let n = writer.write(&payload).expect("write");
        let _ = writer.flush();
        println!("[master] wrote {n} bytes (00..ff)");
    }

    let start = Instant::now();
    let mut got: Vec<u8> = Vec::new();
    let mut last_data = Instant::now();
    while start.elapsed() < Duration::from_secs(4) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk) => {
                got.extend_from_slice(&chunk);
                last_data = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let exited = !matches!(child.try_wait(), Ok(None));
                if (exited || scenario != "s3") && last_data.elapsed() > Duration::from_millis(300)
                {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();

    println!("[master] received {} raw bytes", got.len());
    if scenario == "s3" {
        // 解析 LEN= 行与随后的一行 hex。
        let text = String::from_utf8_lossy(&got).replace('\r', "");
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("LEN=") {
                let n: usize = rest.parse().unwrap_or(0);
                println!("[slave ] read() returned {n} bytes (master wrote 256)");
                continue;
            }
            let hex = line.trim();
            if !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit()) && hex.len() >= 32 {
                let bytes: Vec<u8> = (0..hex.len() / 2)
                    .filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
                    .collect();
                report(
                    &format!("input  master→slave (raw, {} bytes)", bytes.len()),
                    &bytes,
                );
                return;
            }
        }
        println!(
            "!! 没抓到 hex 回显，原始输出：{}",
            String::from_utf8_lossy(&got[..got.len().min(160)])
        );
        return;
    }
    report(&format!("output slave→master ({} bytes)", got.len()), &got);
}

/// 对比收到的字节与原始 00..ff，报丢失/变形/控制字符/行尾膨胀。
fn report(label: &str, bytes: &[u8]) {
    println!("=== {label} ===");
    let mut missing = Vec::new();
    let mut altered = Vec::new();
    for (i, orig) in (0..=255u8).enumerate() {
        match bytes.get(i) {
            None => missing.push(orig),
            Some(&b) if b != orig => altered.push((orig, b)),
            _ => {}
        }
    }
    if bytes.len() < 256 {
        println!(
            "  缺失：{} 字节（只收到前 {} 个，序号错位即帧长错）",
            missing.len(),
            bytes.len()
        );
    }
    if !altered.is_empty() {
        let s: Vec<String> = altered
            .iter()
            .take(24)
            .map(|(a, b)| format!("{a:02x}->{b:02x}"))
            .collect();
        println!("  变形：{} 字节：{}", altered.len(), s.join(" "));
    }
    if missing.is_empty() && altered.is_empty() && bytes.len() == 256 {
        println!("  ✅ 与原始 00..ff 完全一致");
    }
    let ctrl: Vec<String> = bytes
        .iter()
        .enumerate()
        .filter(|(_, b)| **b < 0x20 && **b != b'\n' && **b != b'\r')
        .map(|(i, b)| format!("[{i}]{b:02x}"))
        .collect();
    if !ctrl.is_empty() {
        println!(
            "  仍存活的控制字符（<0x20 非 CR/LF）：{} 个：{}",
            ctrl.len(),
            ctrl.join(" ")
        );
    } else {
        println!("  控制字符（<0x20 非 CR/LF）全部消失");
    }
    let nl = bytes.iter().filter(|b| **b == b'\n').count();
    let cr = bytes.iter().filter(|b| **b == b'\r').count();
    println!("  0x0a 计数 {nl}，0x0d 计数 {cr}");
    // 高字节（>=0x80）存活率：SFTP 文件名/内容大量出现。
    let high = bytes.iter().filter(|b| **b >= 0x80).count();
    println!("  >=0x80 字节存活 {high} 个");
}
