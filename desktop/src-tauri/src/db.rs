use std::path::Path;

use rusqlite::{params, Connection};

pub fn init_database(data_dir: &Path) -> Result<Connection, String> {
    let db_path = data_dir.join("cc-bridge.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {e}"))?;

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
    let defaults = [
        ("allowed_roots", "[]"),
        ("token", &format!("\"{}\"", generate_token())),
        (
            "allowed_extensions",
            r#"[".js",".ts",".jsx",".tsx",".mjs",".cjs",".json",".py",".java",".go",".rs",".c",".cpp",".h",".hpp",".cs",".rb",".php",".sh",".bash",".yml",".yaml",".toml",".ini",".md",".txt",".html",".css",".scss",".sql",".xml"]"#,
        ),
        ("max_file_size_bytes", "20971520"),
        ("rate_limit_max_requests", "100"),
        ("rate_limit_window_ms", "60000"),
        ("backup_dir", "\".cc-bridge-backup\""),
        ("backup_retention", "10"),
        ("host", "\"0.0.0.0\""),
        ("port", "7823"),
        ("whitelist_enabled", "true"),
        ("readonly_mode", "false"),
        ("backup_enabled", "true"),
        ("audit_enabled", "true"),
        ("rate_limit_enabled", "true"),
    ];

    for (key, default_value) in defaults {
        conn.execute(
            "INSERT OR IGNORE INTO config (key, value) VALUES (?1, ?2)",
            params![key, default_value],
        )
        .map_err(|e| format!("Failed to insert default for {key}: {e}"))?;
    }

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
