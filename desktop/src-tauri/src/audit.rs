use std::io::{BufRead, Write};
use std::path::Path;

use chrono::Local;
use serde::Serialize;

#[derive(Debug, Serialize, serde::Deserialize)]
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
        .filter_map(|l| l.ok())
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

pub fn new_entry(
    tool: &str,
    params: &str,
    success: bool,
    error: Option<String>,
    source_ip: Option<String>,
    duration_ms: Option<u64>,
) -> AuditEntry {
    AuditEntry {
        timestamp: Local::now().to_rfc3339(),
        tool: tool.into(),
        params: params.into(),
        success,
        error,
        source_ip,
        duration_ms,
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
        .filter_map(|l| l.ok())
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
