use std::io::{BufRead, Write};
use std::path::Path;

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
}

pub fn write_audit_log(data_dir: &Path, entry: &AuditEntry) -> Result<(), String> {
    let log_path = data_dir.join("audit.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open audit log: {e}"))?;

    let line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize audit entry: {e}"))?;

    writeln!(file, "{}", line).map_err(|e| format!("Failed to write audit log: {e}"))?;

    Ok(())
}

pub fn read_recent_entries(data_dir: &Path, limit: usize) -> Result<Vec<AuditEntry>, String> {
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        return Ok(vec![]);
    }

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;

    let lines: Vec<String> = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .collect();

    let entries: Vec<AuditEntry> = lines
        .iter()
        .rev()
        .take(limit)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    Ok(entries)
}

/// 清空全部审计日志（删除 audit.log）。用户在日志页手动触发。
pub fn clear_all(data_dir: &Path) -> Result<(), String> {
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
    }
}

/// Remove audit entries older than `retention_days`. A value of 0 disables cleanup
/// (keep everything). Rewrites audit.log in place keeping only recent lines.
pub fn cleanup_old_entries(data_dir: &Path, retention_days: u32) -> Result<(), String> {
    if retention_days == 0 {
        return Ok(());
    }

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
        );
        assert_eq!(e.server_ms, Some(20));
        assert_eq!(e.io_ms, Some(4));
        assert_eq!(e.audit_ms, Some(2));
        // overhead = 20 − 10 − 2 = 8
        assert_eq!(e.overhead_ms, Some(8));
    }
}
