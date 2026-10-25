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
         PRAGMA foreign_keys=ON;
         PRAGMA wal_autocheckpoint=256;",
    )
    .map_err(|e| format!("Failed to set PRAGMA: {e}"))?;

    // 启动时做一次 TRUNCATE checkpoint，把残留 WAL 回写主库并**把文件截到 0**。
    //
    // 为何光有上面的 `wal_autocheckpoint` 不够：它只在 WAL 页数超阀时把内容回写主库、
    // 然后**重置写指针复用同一个文件**，并不缩小文件本身。实测就撞上了这个：
    // 加了 autocheckpoint 后重启，`cc-bridge.db-wal` 依旧是 4.13MB（而主库才 448KB）。
    // 残留的大 WAL 不仅占磁盘，还会拖累每次启动的 replay。
    //
    // 失败不当错：TRUNCATE 需要独占，若恰好有其他进程持有连接会返回 SQLITE_BUSY。
    // 这里是启动路径、本进程只此一个连接，正常不会发生；即使发生也只是没收到空间，
    // 不影响数据正确性，所以不能因此让启动失败。
    if let Err(e) = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE") {
        log::warn!("启动 WAL checkpoint(TRUNCATE) 未成功（不影响使用）: {e}");
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to create config table: {e}"))?;

    // 备份索引：创建备份时记录原始绝对路径，还原时精确读取而非按文件名猜测。
    // 旧备份（本表上线前创建的）没有对应记录，查不到即视为"无法定位"，前端按钮相应禁用——
    // 属已知、可接受的降级（历史备份仍在磁盘上，只是失去了 UI 一键还原/看改了什么的能力）。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backup_index (
            backup_path   TEXT PRIMARY KEY NOT NULL,
            original_path TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to create backup_index table: {e}"))?;

    // 外挂 MCP server 的工具清单缓存。建表逻辑放在 bridge 模块里，这里只负责调一下，
    // 避免表结构跟读写它的代码分两处维护。
    crate::mcp::bridge::manifest::ensure_table(&conn)?;

    // CC 对话会话落盘（「关掉 app 就没了」的解）。同上，表归 `cc_session::store` 管。
    crate::cc_session::store::ensure_table(&conn)?;

    // 会话用量账（对话账按 session id 落库，与工具账并排对账用）。
    crate::cc_session::usage::ensure_table(&conn)?;

    // 历史对话索引（CLI 自己那些 jsonl 的缓存）。表归 `cc_history::index` 管。
    crate::cc_history::index::ensure_table(&conn)?;

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
    // 一次性回填本版新增的默认扩展名。`ensure_defaults` 用的是 INSERT OR IGNORE，
    // 只对新装用户生效，存量用户永远拿不到新默认值——见函数注释。
    backfill_default_extensions(&conn)?;

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
        (
            "token",
            format!("\"{}\"", crate::security::auth::generate_token()),
        ),
        ("external_mcp_enabled", d.external_mcp_enabled.to_string()),
        (
            "external_mcp_servers",
            serde_json::to_string(&d.external_mcp_servers)
                .map_err(|e| format!("序列化默认值失败：{e}"))?,
        ),
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

/// 本版（2026-10-21）新增的默认扩展名。必须与 `BridgeConfig::default().allowed_extensions`
/// 的新增部分一致——`backfill_tests::additions_are_all_in_default_extensions` 守这条一致性。
const EXTENSIONS_ADDED_V2: &[&str] = &[
    ".ipynb", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf", ".zip", ".tar", ".gz",
    ".7z", ".rar", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".csv", ".tsv",
    ".log",
];

/// 回填标记。故意不进 `BridgeConfig`，这样它不会出现在导出/导入的配置 JSON 里。
const EXTENSIONS_BACKFILL_MARKER: &str = "extensions_backfilled_v2";

/// 一次性把「本版新增的默认扩展名」回填进**存量**用户的配置。
///
/// WHY：`ensure_defaults` 用的是 `INSERT OR IGNORE`，改 `BridgeConfig::default()` 只对
/// 新装用户生效。2026-10-21 真机测试实测：存量配置里没有 `.ipynb`，`notebook_edit` 因此
/// 100% 不可用；没有 `.pptx/.pdf/.png`，`prepare_upload` / `prepare_download` 按 MCP
/// instructions 的承诺操作时同样撞墙。
///
/// 三条边界：
/// 1. **只追加本版新增项**，不复活用户主动删掉的旧默认项（如 `.sh`）。
/// 2. **不删除、不改写**用户自定义项。
/// 3. 🔴 现有列表为空 = 用户在设置页选了「不限制扩展名」。这时**绝不动**，否则等于把
///    「不限制」偷偷改回「限制 23 项」，属于最严重的那类安全语义倒退。
fn backfill_default_extensions(conn: &Connection) -> Result<(), String> {
    if get_config_value(conn, EXTENSIONS_BACKFILL_MARKER).is_some() {
        return Ok(());
    }

    let current: Vec<String> = match get_config_value(conn, "allowed_extensions") {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => Vec::new(),
    };

    // 空列表 = 「不限制」的显式选择，保持原样（仍然写标记，避免每次启动重算一遍）。
    if !current.is_empty() {
        let mut next = current.clone();
        for ext in EXTENSIONS_ADDED_V2 {
            if !next.iter().any(|e| e.trim().eq_ignore_ascii_case(ext)) {
                next.push((*ext).to_string());
            }
        }
        if next.len() != current.len() {
            let json = serde_json::to_string(&next)
                .map_err(|e| format!("序列化回填后的扩展名列表失败：{e}"))?;
            set_config_value(conn, "allowed_extensions", &json)?;
            log::info!("回填默认扩展名：{} → {} 项", current.len(), next.len());
        }
    }

    set_config_value(conn, EXTENSIONS_BACKFILL_MARKER, "true")?;
    Ok(())
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

#[cfg(test)]
mod backfill_tests {
    use super::*;
    use crate::config::BridgeConfig;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-mem db");
        conn.execute_batch(
            "CREATE TABLE config (
                key   TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
        )
        .expect("create config table");
        conn
    }

    fn read_ext(conn: &Connection) -> Vec<String> {
        serde_json::from_str(&get_config_value(conn, "allowed_extensions").expect("present"))
            .expect("json")
    }

    fn seed(conn: &Connection, exts: &[&str]) {
        set_config_value(
            conn,
            "allowed_extensions",
            &serde_json::to_string(exts).expect("json"),
        )
        .expect("seed");
    }

    /// 回填清单里的每一项都必须真的在默认白名单里。否则回填会给用户配置塞进一个
    /// 默认值本身都不包含的扩展名——等于凭空放宽安全边界。
    #[test]
    fn additions_are_all_in_default_extensions() {
        let defaults: Vec<String> = BridgeConfig::default()
            .allowed_extensions
            .iter()
            .map(|e| e.to_lowercase())
            .collect();
        for ext in EXTENSIONS_ADDED_V2 {
            assert!(
                defaults.iter().any(|d| d == ext),
                "{ext} 在回填清单里但不在默认白名单里，两处已漂移"
            );
        }
    }

    /// 存量用户（旧 30 项 + 一个自定义项）升级后：新能力补齐，自定义项与旧项一个不少。
    #[test]
    fn backfill_appends_missing_and_keeps_everything_else() {
        let conn = mem_conn();
        seed(&conn, &[".js", ".md", ".mycustom"]);
        backfill_default_extensions(&conn).expect("backfill");

        let ext = read_ext(&conn);
        for required in [".ipynb", ".pdf", ".png", ".zip"] {
            assert!(ext.iter().any(|e| e == required), "缺 {required}：{ext:?}");
        }
        for kept in [".js", ".md", ".mycustom"] {
            assert!(ext.iter().any(|e| e == kept), "丢了 {kept}：{ext:?}");
        }
    }

    /// 🔴 空列表 = 「不限制扩展名」。回填必须原样放过，否则等于把「不限制」偷偷改成
    /// 「限制 N 项」——最严重的那类安全语义倒退。
    #[test]
    fn backfill_never_touches_empty_list() {
        let conn = mem_conn();
        seed(&conn, &[]);
        backfill_default_extensions(&conn).expect("backfill");
        assert!(read_ext(&conn).is_empty(), "空列表被改写了");
    }

    /// 只跑一次：第二次调用不再改动（用户随后手删的项不会被重新加回来）。
    #[test]
    fn backfill_runs_only_once() {
        let conn = mem_conn();
        seed(&conn, &[".js"]);
        backfill_default_extensions(&conn).expect("first");
        let after_first = read_ext(&conn);
        assert!(after_first.iter().any(|e| e == ".ipynb"));

        // 模拟用户升级后主动删掉 .ipynb。
        let trimmed: Vec<&str> = after_first
            .iter()
            .map(|s| s.as_str())
            .filter(|e| *e != ".ipynb")
            .collect();
        seed(&conn, &trimmed);

        backfill_default_extensions(&conn).expect("second");
        assert!(
            !read_ext(&conn).iter().any(|e| e == ".ipynb"),
            "第二次运行不该复活用户已删除的项"
        );
    }
}
