use std::path::Path;

use rusqlite::{params, Connection};

pub fn init_database(data_dir: &Path) -> Result<Connection, String> {
    let db_path = data_dir.join("cc-bridge.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {e}"))?;

    // E-P0-1: 性能 PRAGMA——WAL 写吞吐 2-5×，busy_timeout 防写冲突，synchronous=NORMAL 减 fsync
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA busy_timeout=5000;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;",
    )
    .map_err(|e| format!("Failed to set PRAGMA: {e}"))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to create config table: {e}"))?;

    // Migrate from config.json if it exists and the config table is empty
    let config_json_path = data_dir.join("config.json");
    if config_json_path.exists() {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM config", [], |row| row.get(0))
            .unwrap_or(0);

        if count == 0 {
            if let Ok(content) = std::fs::read_to_string(&config_json_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    migrate_from_json(&conn, &json)?;
                    let migrated_path = data_dir.join("config.json.migrated");
                    let _ = std::fs::rename(&config_json_path, &migrated_path);
                    log::info!(
                        "Migrated config.json to SQLite and renamed to config.json.migrated"
                    );
                }
            }
        }
    }

    // Ensure defaults exist
    ensure_defaults(&conn)?;

    Ok(conn)
}

fn migrate_from_json(conn: &Connection, json: &serde_json::Value) -> Result<(), String> {
    let mappings = [
        ("allowed_roots", json.get("allowedRoots")),
        ("token", json.get("token")),
        ("allowed_extensions", json.get("allowedExtensions")),
        ("max_file_size_bytes", json.get("maxFileSizeBytes")),
        (
            "rate_limit_max_requests",
            json.get("rateLimit").and_then(|r| r.get("maxRequests")),
        ),
        (
            "rate_limit_window_ms",
            json.get("rateLimit").and_then(|r| r.get("windowMs")),
        ),
        ("backup_dir", json.get("backupDir")),
        ("backup_retention", json.get("backupRetention")),
        ("host", json.get("host")),
        ("port", json.get("port")),
    ];

    for (key, value) in mappings {
        if let Some(v) = value {
            let value_str = serde_json::to_string(v)
                .map_err(|e| format!("Failed to serialize config value: {e}"))?;
            conn.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                params![key, value_str],
            )
            .map_err(|e| format!("Failed to insert config key {key}: {e}"))?;
        }
    }

    Ok(())
}

fn ensure_defaults(conn: &Connection) -> Result<(), String> {
    // D5 修复：默认值单源。数值/字符串全部取自 BridgeConfig::default()，消除 db.rs 与
    // config.rs 两处硬编码漂移隐患；仅 token 需随机生成。key 名与 config.rs::load_config
    // 的 get_config_value 对应，保持不变。
    let d = crate::config::BridgeConfig::default();
    let defaults: Vec<(&str, String)> = vec![
        (
            "allowed_roots",
            serde_json::to_string(&d.allowed_roots)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        ("token", format!("\"{}\"", generate_token())),
        (
            "allowed_extensions",
            serde_json::to_string(&d.allowed_extensions)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "max_file_size_bytes",
            serde_json::to_string(&d.max_file_size_bytes)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "rate_limit_max_requests",
            serde_json::to_string(&d.rate_limit_max_requests)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "rate_limit_window_ms",
            serde_json::to_string(&d.rate_limit_window_ms)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "backup_dir",
            serde_json::to_string(&d.backup_dir).map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "backup_retention",
            serde_json::to_string(&d.backup_retention)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "host",
            serde_json::to_string(&d.host).map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "port",
            serde_json::to_string(&d.port).map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "whitelist_enabled",
            serde_json::to_string(&d.whitelist_enabled)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "readonly_mode",
            serde_json::to_string(&d.readonly_mode)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "backup_enabled",
            serde_json::to_string(&d.backup_enabled)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "audit_enabled",
            serde_json::to_string(&d.audit_enabled)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "rate_limit_enabled",
            serde_json::to_string(&d.rate_limit_enabled)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "shell_enabled",
            serde_json::to_string(&d.shell_enabled)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
        (
            "session_cwd_enabled",
            serde_json::to_string(&d.session_cwd_enabled)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
    ];

    // E-P1-4: 用事务包裹，避免 18 次独立隐式事务 + fsync
    conn.execute("BEGIN", [])
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;
    for (key, default_value) in defaults {
        conn.execute(
            "INSERT OR IGNORE INTO config (key, value) VALUES (?1, ?2)",
            params![key, default_value],
        )
        .map_err(|e| format!("Failed to insert default for {key}: {e}"))?;
    }
    conn.execute("COMMIT", [])
        .map_err(|e| format!("Failed to commit defaults: {e}"))?;

    Ok(())
}

fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let idx = rng.gen_range(0..36);
            if idx < 10 {
                (b'0' + idx) as char
            } else {
                (b'a' + idx - 10) as char
            }
        })
        .collect()
}

pub fn get_config_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM config WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

pub fn set_config_value(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| format!("Failed to set config value {key}: {e}"))?;
    Ok(())
}
