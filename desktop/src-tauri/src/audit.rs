use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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
    /// O1：审计写盘耗时（以序列化开销为代理测量）。
    #[serde(rename = "auditMs", skip_serializing_if = "Option::is_none")]
    pub audit_ms: Option<u64>,
    /// O1：网络往返估算（O1-b 探针填；本次恒 None）。
    #[serde(rename = "netMs", skip_serializing_if = "Option::is_none")]
    pub net_ms: Option<u64>,
    /// O1：派生量 = serverMs − durationMs − auditMs（请求解析 + 响应序列化 + gzip + 线缆传输）。
    #[serde(rename = "overheadMs", skip_serializing_if = "Option::is_none")]
    pub overhead_ms: Option<u64>,
    /// 会话级 cwd 持久化的 handle（run_command 开启会话时记录，便于审计追溯）。
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// E-P0-7: 共享审计日志写句柄，避免每次写都 open 文件（高频批量调用下省 1000 open/s）。
/// 以 data_dir 为键惰性打开，写后 flush；日志被轮换（cleanup/clear）时由
/// `close_audit_writer` 释放句柄，避免 Windows 下文件被占用导致 rename 失败。
type AuditWriter = Option<(PathBuf, BufWriter<std::fs::File>)>;
static AUDIT_WRITER: OnceLock<Mutex<AuditWriter>> = OnceLock::new();

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

pub fn read_recent_entries(data_dir: &Path, limit: usize) -> Result<Vec<AuditEntry>, String> {
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        return Ok(vec![]);
    }

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;

    // E-P2-2: 用固定容量 VecDeque 避免整文件进内存，只保留最后 limit 行
    let mut deque: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(limit);
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        if deque.len() >= limit {
            deque.pop_front();
        }
        deque.push_back(line);
    }

    let entries: Vec<AuditEntry> = deque
        .iter()
        .rev()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    Ok(entries)
}

/// 清空全部审计日志（删除 audit.log）。用户在日志页手动触发。
pub fn clear_all(data_dir: &Path) -> Result<(), String> {
    close_audit_writer();
    let log_path = data_dir.join("audit.log");
    if log_path.exists() {
        std::fs::remove_file(&log_path).map_err(|e| format!("Failed to clear audit log: {e}"))?;
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
    audit_ms: Option<u64>,
    net_ms: Option<u64>,
    session_id: Option<String>,
) -> AuditEntry {
    // overhead = server − dispatch调度 − audit写盘；缺任一分量则留 None。
    let overhead_ms = match (server_ms, duration_ms, audit_ms) {
        (Some(s), Some(d), Some(a)) => Some(s.saturating_sub(d + a)),
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
            Some(2),
            None,
            None,
        );
        assert_eq!(e.server_ms, Some(20));
        assert_eq!(e.io_ms, Some(4));
        assert_eq!(e.audit_ms, Some(2));
        // overhead = 20 − 10 − 2 = 8
        assert_eq!(e.overhead_ms, Some(8));
    }
}
