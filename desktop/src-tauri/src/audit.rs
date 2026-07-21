use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio::task_local;

use chrono::Local;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub tool: String,
    pub params: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "sourceIp", skip_serializing_if = "Option::is_none")]
    pub source_ip: Option<String>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// O1（结构化耗时拆解）：服务端总墙钟 = t_sent − t_recv。
    #[serde(rename = "serverMs", skip_serializing_if = "Option::is_none")]
    pub server_ms: Option<u64>,
    /// O1：实际文件读写 / 备份 / 拷贝耗时（task_local 跨工具累加）。
    #[serde(rename = "ioMs", skip_serializing_if = "Option::is_none")]
    pub io_ms: Option<u64>,
    /// O1：审计写盘耗时（以序列化开销为代理测量）。带小数的毫秒（f64）——实测典型值在
    /// 微秒级（~6.8µs），若用整数毫秒会恒截断为 0 而被前端过滤隐藏（见 O1 耗时拆解面板“审计
    /// 写盘”一项长期不可见的问题）。
    #[serde(rename = "auditMs", skip_serializing_if = "Option::is_none")]
    pub audit_ms: Option<f64>,
    /// O1：网络往返估算（O1-b 探针填；本次恒 None）。
    #[serde(rename = "netMs", skip_serializing_if = "Option::is_none")]
    pub net_ms: Option<u64>,
    /// O1：派生量 = serverMs − durationMs − auditMs（请求解析 + 响应序列化 + gzip + 线缆传输）。
    /// 同样改为 f64：输入里的 auditMs 带小数，若继续用整数会丢精度、也容易截断成 0 被隐藏。
    #[serde(rename = "overheadMs", skip_serializing_if = "Option::is_none")]
    pub overhead_ms: Option<f64>,
    /// 会话级 cwd 持久化的 handle（run_command 开启会话时记录，便于审计追溯）。
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 关联备份：本操作执行前生成的 .bak 绝对路径（仅写/删类操作、且备份开启时存在）。
    /// 前端据此提供「一键回滚 / 变更 Diff」入口。旧日志无此字段，`skip_serializing_if` 兼容。
    #[serde(rename = "backupPath", skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    /// 关联备份：被备份/覆盖的目标文件绝对路径（同一次操作的原文件，用于回滚写回定位）。
    #[serde(rename = "targetPath", skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
}

/// 关联备份传递：在同一次工具调用（同一 async 任务）内，由写工具把本次生成的备份路径 +
/// 目标文件路径写入，再由 `write_audit_for_call` 在生成审计条目时取出并落盘。
/// 用 task_local 而非返回值穿透，避免改动 5 个工具 + dispatch_tool 的签名与返回类型。
/// 所有写工具的调用入口（http.rs 的 dispatch_tool、batch.rs 的子操作分发）都包裹在
/// `with_op_backup` 作用域内，故 `record_op_backup` / `take_op_backup` 一定处于作用域中。
use std::cell::RefCell;
task_local! {
    static OP_BACKUP: RefCell<Option<(Option<PathBuf>, Option<PathBuf>)>>;
    // 本次工具调用的来源 IP（供 batch 子操作补写 sourceIp；与 OP_BACKUP 同一任务作用域）。
    static SOURCE_IP: Option<String>;
}

/// 进入一次工具调用的来源 IP 作用域（包住 dispatch + 子操作分发）。
pub async fn with_source_ip<F>(ip: Option<String>, fut: F) -> F::Output
where
    F: std::future::Future,
{
    SOURCE_IP.scope(ip, fut).await
}

/// 读取当前工具调用的来源 IP；不在作用域内（如单元测试）时返回 None，不 panic。
pub fn current_source_ip() -> Option<String> {
    SOURCE_IP.try_with(|ip| ip.clone()).ok().flatten()
}

/// 进入一次工具调用的关联备份作用域，包裹 dispatch + 审计全过程（在 `handle_tools_call` 内）。
pub async fn with_op_backup<F>(fut: F) -> F::Output
where
    F: std::future::Future,
{
    let slot: RefCell<Option<(Option<PathBuf>, Option<PathBuf>)>> = RefCell::new(None);
    OP_BACKUP.scope(slot, fut).await
}

/// 工具内部调用：记录本次操作生成的备份路径与目标路径（供审计关联）。
/// 用 try_with 而非 with：作用域未建立（如单元测试直调 handle、或未来新的分发路径）时
/// 安全 no-op，而不是在写操作中途 panic（此时备份已生成、write_atomic 尚未执行）。
/// 生产路径下 dispatch 始终包在 with_op_backup 作用域内，关联仍正常生效。
pub fn record_op_backup(backup: Option<PathBuf>, target: Option<PathBuf>) {
    let _ = OP_BACKUP.try_with(|c| {
        *c.borrow_mut() = Some((backup, target));
    });
}

/// 审计写盘前调用：取出并清空关联备份信息（作用域缺失时返回 None，不 panic）。
pub fn take_op_backup() -> Option<(Option<PathBuf>, Option<PathBuf>)> {
    OP_BACKUP.try_with(|c| c.borrow_mut().take()).ok().flatten()
}

/// E-P0-7: 共享审计日志写句柄，避免每次写都 open 文件（高频批量调用下省 1000 open/s）。
/// 以 data_dir 为键惰性打开，写后 flush；日志被轮换（cleanup/clear）时由
/// `close_audit_writer` 释放句柄，避免 Windows 下文件被占用导致 rename 失败。
type AuditWriter = Option<(PathBuf, BufWriter<std::fs::File>)>;
static AUDIT_WRITER: OnceLock<Mutex<AuditWriter>> = OnceLock::new();

/// E-P4: 审计日志解析缓存。read_page 每 10s 被前端轮询，稳态下日志不再变化时全量
/// JSON 解析是纯浪费。以 (path, mtime, len) 为键值缓存整份解析结果，仅当文件被追加/
/// 轮换/清空（mtime 或 len 变化）时才重新解析。clear_all / cleanup_old_entries 在改写
/// 文件后主动失效，避免 stale。与 AUDIT_WRITER 同构（OnceLock<Mutex<…>>）。
type AuditCache = Option<(PathBuf, u64, u64, Vec<AuditEntry>)>;
static AUDIT_CACHE: OnceLock<Mutex<AuditCache>> = OnceLock::new();

pub fn write_audit_log(data_dir: &Path, entry: &AuditEntry) -> Result<(), String> {
    let line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize audit entry: {e}"))?;

    let lock = AUDIT_WRITER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().unwrap();
    // 重新打开条件：尚未打开，或目标目录变化（理论单目录，防御性）。
    let reopen = match guard.as_ref() {
        Some((p, _)) => p.as_path() != data_dir,
        None => true,
    };
    if reopen {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data_dir.join("audit.log"))
            .map_err(|e| format!("Failed to open audit log: {e}"))?;
        *guard = Some((data_dir.to_path_buf(), BufWriter::new(f)));
    }
    let (_, w) = guard.as_mut().unwrap();
    writeln!(w, "{}", line).map_err(|e| format!("Failed to write audit log: {e}"))?;
    w.flush()
        .map_err(|e| format!("Failed to flush audit log: {e}"))?;
    Ok(())
}

/// E-P0-7: 释放共享写句柄（审计日志轮换/清空前调用）。
pub fn close_audit_writer() {
    if let Some(m) = AUDIT_WRITER.get() {
        if let Ok(mut g) = m.lock() {
            if let Some((_, mut w)) = g.take() {
                let _ = w.flush();
            }
        }
    }
}

/// 分页读取结果（策略 A：页码分页）。前端依 `total` / `page_size` 计算总页数。
/// `entries` 已倒序（最新在前），`page` / `page_size` 回显请求值（已 clamp）。
#[derive(Debug, Clone, Serialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    /// 审计日志总条数（用于前端算总页数；不受当前页大小影响）
    pub total: usize,
    /// 当前页（≥1，已 clamp 到合法范围）
    pub page: usize,
    /// 每页条数（已 clamp 到 1..=500）
    #[serde(rename = "pageSize")]
    pub page_size: usize,
}

/// 全量读入 audit.log 并逐行解析为 `AuditEntry`。仅在缓存未命中（文件变更）时调用，
/// 平时 read_page 直接复用 AUDIT_CACHE 中的已解析结果，跳过本函数。
fn parse_all_entries(log_path: &Path) -> Result<Vec<AuditEntry>, String> {
    let file =
        std::fs::File::open(log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;
    Ok(std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect())
}

/// 分页读取审计日志（策略 A：页码分页）。
/// 读全 JSONL 文件 → `total = 行数` → 倒序（最新在前）→ `skip((page-1)*page_size).take(page_size)`。
/// 审计量受 30 天保留限制，全读可接受；返回结构供前端算总页数并渲染分页器。
///
/// E-P4 优化：以 (path, mtime, len) 为键值缓存整份解析结果。前端每 10s 轮询本函数，
/// 稳态下日志不再变化时直接复用缓存（零 JSON 解析）；仅当文件被追加/轮换/清空
/// （mtime 或 len 变化）时才重新全量解析。clear_all / cleanup_old_entries 在改写文件后
/// 主动失效缓存，避免返回 stale 数据。
pub fn read_page(data_dir: &Path, page: usize, page_size: usize) -> Result<AuditPage, String> {
    let page = page.max(1);
    let page_size = page_size.max(1);
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        // 文件不存在：清空缓存（避免 stale），返回空页。
        if let Some(m) = AUDIT_CACHE.get() {
            if let Ok(mut g) = m.lock() {
                *g = None;
            }
        }
        return Ok(AuditPage {
            entries: vec![],
            total: 0,
            page,
            page_size,
        });
    }

    let meta =
        std::fs::metadata(&log_path).map_err(|e| format!("Failed to stat audit log: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let len = meta.len();

    // 判定命中与克隆在同一次持锁内完成，避免 TOCTOU：旧实现先短锁判 hit 再释锁重锁
    // clone，两次之间若 clear_all/cleanup 把缓存置 None，`.as_ref().unwrap()` 会 panic 并在
    // 持锁时毒化互斥锁，导致后续所有 lock().unwrap() 跟着 panic。
    let cache = AUDIT_CACHE.get_or_init(|| Mutex::new(None));
    // 步一：持锁内一次性完成“判命中 + 克隆”（命中返回 Some(clone)，未命中返回 None），
    // 锁在本作用域末尾释放。
    let cached: Option<Vec<AuditEntry>> = {
        let g = cache.lock().unwrap();
        match g.as_ref() {
            Some((p, mt, ln, entries))
                if p.as_path() == log_path.as_path() && *mt == mtime && *ln == len =>
            {
                Some(entries.clone())
            }
            _ => None,
        }
    };
    // 步二：未命中才释锁后做 IO 解析，再重新上锁写回缓存。全程不存在旧实现那种
    // “判 hit 与 clone 分两次持锁”的 TOCTOU 窗口，也不再对 None 做 unwrap。
    let all: Vec<AuditEntry> = match cached {
        Some(entries) => entries,
        None => {
            let parsed = parse_all_entries(&log_path)?;
            let mut g = cache.lock().unwrap();
            *g = Some((log_path.clone(), mtime, len, parsed.clone()));
            parsed
        }
    };

    let total = all.len();
    let start = (page - 1) * page_size;
    // 倒序后取本页：最新条目在前，与 read_recent_entries 旧行为一致。
    let entries: Vec<AuditEntry> = all.into_iter().rev().skip(start).take(page_size).collect();

    Ok(AuditPage {
        entries,
        total,
        page,
        page_size,
    })
}

/// 清空全部审计日志（删除 audit.log）。用户在日志页手动触发。
pub fn clear_all(data_dir: &Path) -> Result<(), String> {
    close_audit_writer();
    let log_path = data_dir.join("audit.log");
    if log_path.exists() {
        std::fs::remove_file(&log_path).map_err(|e| format!("Failed to clear audit log: {e}"))?;
    }
    // E-P4: 文件已删，失效解析缓存（下次读取会重建或返回空）。
    if let Some(m) = AUDIT_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn new_entry(
    tool: &str,
    params: &str,
    success: bool,
    error: Option<String>,
    source_ip: Option<String>,
    duration_ms: Option<u64>,
    server_ms: Option<u64>,
    io_ms: Option<u64>,
    audit_ms: Option<f64>,
    net_ms: Option<u64>,
    session_id: Option<String>,
) -> AuditEntry {
    // overhead = server − dispatch调度 − audit写盘；缺任一分量则留 None。f64 运算，不再用
    // saturating_sub（那是整数语义），max(0.0) 处理负数四舍五入误差。
    let overhead_ms = match (server_ms, duration_ms, audit_ms) {
        (Some(s), Some(d), Some(a)) => Some((s as f64 - d as f64 - a).max(0.0)),
        _ => None,
    };
    AuditEntry {
        timestamp: Local::now().to_rfc3339(),
        tool: tool.into(),
        params: params.into(),
        success,
        error,
        source_ip,
        duration_ms,
        server_ms,
        io_ms,
        audit_ms,
        net_ms,
        overhead_ms,
        session_id,
        backup_path: None,
        target_path: None,
    }
}

/// Remove audit entries older than `retention_days`. A value of 0 disables cleanup
/// (keep everything). Rewrites audit.log in place keeping only recent lines.
pub fn cleanup_old_entries(data_dir: &Path, retention_days: u32) -> Result<(), String> {
    if retention_days == 0 {
        return Ok(());
    }

    // E-P0-7: 轮换前释放共享写句柄，避免 Windows 下 rename 因文件被占用而失败。
    close_audit_writer();
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        return Ok(());
    }

    let cutoff = Local::now() - chrono::Duration::days(retention_days as i64);

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;

    let kept: Vec<String> = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| {
            // Keep lines whose timestamp is newer than cutoff. Unparseable lines are kept.
            match serde_json::from_str::<AuditEntry>(line) {
                Ok(entry) => match chrono::DateTime::parse_from_rfc3339(&entry.timestamp) {
                    Ok(ts) => ts.with_timezone(&Local) >= cutoff,
                    Err(_) => true,
                },
                Err(_) => true,
            }
        })
        .collect();

    let tmp_path = data_dir.join("audit.log.tmp");
    {
        let mut tmp = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp audit log: {e}"))?;
        for line in &kept {
            writeln!(tmp, "{}", line)
                .map_err(|e| format!("Failed to write temp audit log: {e}"))?;
        }
    }
    std::fs::rename(&tmp_path, &log_path)
        .map_err(|e| format!("Failed to replace audit log: {e}"))?;

    // E-P4: 文件已被 rewrite，mtime/len 已变，失效解析缓存（下次读取会重建）。
    if let Some(m) = AUDIT_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O1 向后兼容：旧版 audit.log 行（无 serverMs/ioMs/auditMs/netMs/overheadMs）
    /// 必须能被新 AuditEntry 解析，且这些新字段全为 None，旧字段正常。
    #[test]
    fn old_log_line_parses_with_none_timing_fields() {
        let line = r#"{"timestamp":"2026-07-10T12:00:00+08:00","tool":"read_files","params":"{}","success":true,"sourceIp":"127.0.0.1","durationMs":3}"#;
        let entry: AuditEntry = serde_json::from_str(line).expect("旧格式应可解析");
        assert_eq!(entry.tool, "read_files");
        assert_eq!(entry.duration_ms, Some(3));
        assert_eq!(entry.server_ms, None);
        assert_eq!(entry.io_ms, None);
        assert_eq!(entry.audit_ms, None);
        assert_eq!(entry.net_ms, None);
        assert_eq!(entry.overhead_ms, None);
    }

    /// O1：new_entry 应正确派生 overheadMs = server − duration − audit。
    #[test]
    fn new_entry_derives_overhead() {
        let e = new_entry(
            "read_files",
            "{}",
            true,
            None,
            Some("1.2.3.4".into()),
            Some(10),
            Some(20),
            Some(4),
            Some(2.0),
            None,
            None,
        );
        assert_eq!(e.server_ms, Some(20));
        assert_eq!(e.io_ms, Some(4));
        assert_eq!(e.audit_ms, Some(2.0));
        // overhead = 20 − 10 − 2 = 8
        assert_eq!(e.overhead_ms, Some(8.0));
    }

    /// O1：修复前 auditMs/overheadMs 用整数毫秒会把微秒级实测值截断为 0，导致前端
    /// 过滤隐藏。f64 应能保留小数精度。
    #[test]
    fn new_entry_keeps_sub_millisecond_audit_precision() {
        let e = new_entry(
            "read_files",
            "{}",
            true,
            None,
            None,
            Some(1),
            Some(1),
            None,
            Some(0.0068),
            None,
            None,
        );
        assert_eq!(e.audit_ms, Some(0.0068));
        // overhead = 1 − 1 − 0.0068，clamp 到 0
        assert_eq!(e.overhead_ms, Some(0.0));
    }

    /// E-P4: 测试辅助——在系统临时目录下建一个唯一子目录作 data_dir。
    fn tmp_data_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccb_test_{}_{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// E-P4: read_page 倒序分页 + total 正确；且二次同参调用走缓存命中、结果一致。
    #[test]
    fn read_page_paginates_recent_first() {
        let dir = tmp_data_dir("paging");
        let _ = clear_all(&dir);
        for i in 0..5 {
            let e = new_entry(
                format!("tool_{i}").as_str(),
                "{}",
                true,
                None,
                None,
                Some(i as u64),
                Some(i as u64),
                None,
                None,
                None,
                None,
            );
            write_audit_log(&dir, &e).expect("write");
        }
        let page = read_page(&dir, 1, 50).expect("read");
        assert_eq!(page.total, 5);
        assert_eq!(page.entries.len(), 5);
        // 倒序：最新（tool_4）在前
        assert_eq!(page.entries[0].tool, "tool_4");
        assert_eq!(page.entries[4].tool, "tool_0");

        // 第二页：page_size=2 → 取 tool_4, tool_3（缓存命中路径）
        let p2 = read_page(&dir, 1, 2).expect("read2");
        assert_eq!(p2.entries.len(), 2);
        assert_eq!(p2.entries[0].tool, "tool_4");
        assert_eq!(p2.entries[1].tool, "tool_3");

        // 二次同参调用结果一致（缓存未失效）
        let again = read_page(&dir, 1, 50).expect("read again");
        assert_eq!(again.total, page.total);
        assert_eq!(again.entries[0].tool, page.entries[0].tool);
        let _ = clear_all(&dir);
    }

    /// E-P4: 无文件变更时两次 read_page 结果一致；追加后缓存失效、total 增加。
    #[test]
    fn read_page_cache_consistent_and_invalidates() {
        let dir = tmp_data_dir("cache");
        let _ = clear_all(&dir);
        for i in 0..3 {
            let e = new_entry(
                format!("t{i}").as_str(),
                "{}",
                true,
                None,
                None,
                Some(i as u64),
                Some(i as u64),
                None,
                None,
                None,
                None,
            );
            write_audit_log(&dir, &e).expect("write");
        }
        let a = read_page(&dir, 1, 50).expect("read a");
        let b = read_page(&dir, 1, 50).expect("read b");
        assert_eq!(a.entries.len(), b.entries.len());
        assert_eq!(a.total, b.total);
        assert_eq!(a.entries[0].tool, b.entries[0].tool);

        // 追加一条 → len 变化 → 缓存失效 → total 变为 4
        let e4 = new_entry(
            "t3",
            "{}",
            true,
            None,
            None,
            Some(3),
            Some(3),
            None,
            None,
            None,
            None,
        );
        write_audit_log(&dir, &e4).expect("write 4");
        let c = read_page(&dir, 1, 50).expect("read c");
        assert_eq!(c.total, 4);
        assert_eq!(c.entries[0].tool, "t3");
        let _ = clear_all(&dir);
    }
}
