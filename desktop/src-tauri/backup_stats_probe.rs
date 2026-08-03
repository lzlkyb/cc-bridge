//! 独立诊断工具（不在 `src/` 下，不参与 Cargo 构建）。
//!
//! 目的：量 `backup::backup_stats()` 的真实耗时。它被 `get_status` 每 5s 调一次，
//! 而备份目录实测有 26MB / 1203 个文件，需要确认这是不是个真瓶颈。
//!
//! 关键问题：Windows 上 `DirEntry::metadata()` 可能复用 `FindNextFile` 已返回的
//! 文件属性（无额外 syscall），也可能每个文件都重新 stat 一次。两者成本差两个
//! 数量级，不能靠猜——所以这里用与生产代码**字字相同**的循环实测，
//! 并额外跑一个“不调 metadata”的对照组来拆分枚举成本与 stat 成本。
//!
//! 用法：
//! ```text
//! rustc backup_stats_probe.rs -O -o backup_stats_probe.exe
//! ./backup_stats_probe.exe "$APPDATA/com.ccbridge.desktop/.cc-bridge-backup"
//! ```

use std::path::Path;
use std::time::Instant;

/// 与 `backup::backup_stats()` 完全一致的实现（含 `entry.metadata()`）。
fn backup_stats(dir: &Path) -> (u32, u64) {
    let mut count = 0u32;
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("bak") {
                if let Ok(meta) = entry.metadata() {
                    count += 1;
                    total += meta.len();
                }
            }
        }
    }
    (count, total)
}

/// 对照组：只枚举不取 metadata，用来把“目录枚举”与“逐文件 stat”的成本拆开。
fn enumerate_only(dir: &Path) -> u32 {
    let mut count = 0u32;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("bak") {
                count += 1;
            }
        }
    }
    count
}

fn main() {
    let arg = std::env::args().nth(1).expect("usage: probe <backup_dir>");
    let dir = Path::new(&arg);
    println!("dir = {}", dir.display());

    // 先跑一轮热缓存，避免把首次冷启动的磁盘延迟算进稳态成本。
    let (c0, t0) = backup_stats(dir);
    println!("warmup: count={c0} total={t0} bytes\n");

    println!("-- backup_stats（含 metadata，生产代码路径）--");
    for round in 1..=5 {
        let t = Instant::now();
        let (c, _) = backup_stats(dir);
        println!("  round {round}: {:>8.3} ms   count={c}", t.elapsed().as_secs_f64() * 1000.0);
    }

    println!("-- enumerate_only（不取 metadata，对照组）--");
    for round in 1..=5 {
        let t = Instant::now();
        let c = enumerate_only(dir);
        println!("  round {round}: {:>8.3} ms   count={c}", t.elapsed().as_secs_f64() * 1000.0);
    }
}
