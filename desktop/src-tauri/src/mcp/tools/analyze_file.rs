use std::sync::Arc;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct AnalyzeFileArgs {
    pub path: String,
}

pub async fn handle(args: AnalyzeFileArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let resolved = security::path::resolve_safe_path_cached(
        &args.path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Cannot stat: {e}"))?;
    if metadata.is_dir() {
        return Err("path is a directory".into());
    }
    security::filesize::assert_file_size_ok(&resolved, config.max_file_size_bytes)?;

    let data = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Read error: {e}"))?;

    let encoding = guess_encoding(&data);
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    let language = ext_to_language(&ext);

    let (line_count, function_count, class_count, analysis_note) = if encoding != "binary" {
        // 大文件跳过 line/function/class 扫描：`String::from_utf8_lossy` 需要把整文件
        // 解码成 String，对 GBK 老工程等大文件会瞬间吃满内存（曾对 ~500MB 文件触发
        // OOM-killer）。对超大文件只返 encoding/language/mtime/size，远程 AI 仍能
        // 据此判断"该用 read_files 取行范围"或"用 search_files 局部查"。
        const LARGE_FILE_LINE_SCAN_BYTES: u64 = 64 * 1024 * 1024;
        if metadata.len() > LARGE_FILE_LINE_SCAN_BYTES {
            (
                None,
                None,
                None,
                format!(
                    "file > {LARGE_FILE_LINE_SCAN_BYTES} bytes ({n} bytes): line/function/class counts skipped to avoid full-file in-memory decode; use read_files (with start/endLine) or search_files for partial inspection",
                    n = metadata.len()
                ),
            )
        } else {
            let text = String::from_utf8_lossy(&data);
            let lines = if text.is_empty() {
                0
            } else {
                text.lines().count()
            };
            let (fns, cls) = count_functions_classes(&text, &language);
            (
                Some(lines),
                Some(fns),
                Some(cls),
                "function/class counts are heuristic regex-based estimates, not AST-accurate parsing"
                    .to_string(),
            )
        }
    } else {
        (
            None,
            None,
            None,
            "binary file: line/function/class counts skipped".to_string(),
        )
    };

    let mtime = metadata
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

    let result = json!({
        "path": args.path,
        "size": metadata.len(),
        "mtime": mtime,
        "encoding": encoding,
        "extension": ext,
        "language": language,
        "lineCount": line_count,
        "functionCount": function_count,
        "classCount": class_count,
        "analysisNote": analysis_note,
    });

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&result).unwrap() }] }),
    )
}

fn guess_encoding(data: &[u8]) -> &'static str {
    if data.len() >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
        return "utf8-bom";
    }
    if data.len() >= 2 && data[0] == 0xff && data[1] == 0xfe {
        return "utf16le";
    }
    if data.len() >= 2 && data[0] == 0xfe && data[1] == 0xff {
        return "utf16be";
    }

    let sample_len = data.len().min(8192);
    let sample = &data[..sample_len];
    let zero_count = sample.iter().filter(|&&b| b == 0).count();
    if !sample.is_empty() && (zero_count as f64 / sample.len() as f64) > 0.1 {
        return "binary";
    }

    match std::str::from_utf8(sample) {
        Ok(_) => "utf8",
        Err(_) => "unknown",
    }
}

fn ext_to_language(ext: &str) -> String {
    match ext {
        ".js" | ".jsx" | ".mjs" | ".cjs" => "javascript",
        ".ts" | ".tsx" => "typescript",
        ".py" => "python",
        ".java" => "java",
        ".go" => "go",
        ".rs" => "rust",
        ".c" | ".h" => "c",
        ".cpp" | ".hpp" => "cpp",
        ".cs" => "csharp",
        ".rb" => "ruby",
        ".php" => "php",
        ".sh" | ".bash" => "shell",
        ".md" => "markdown",
        ".json" => "json",
        ".yml" | ".yaml" => "yaml",
        ".html" => "html",
        ".css" => "css",
        ".sql" => "sql",
        ".xml" => "xml",
        _ => "unknown",
    }
    .into()
}

fn count_functions_classes(text: &str, language: &str) -> (usize, usize) {
    // E-P1-2: 预编译所有正则，避免每次调用重复编译
    use regex::Regex;
    static RE_CACHE: LazyLock<std::collections::HashMap<String, Regex>> = LazyLock::new(|| {
        let patterns: &[&str] = &[
            r"\bfunction\s+\w+",
            r"=>\s*\b",
            r"\bclass\s+\w+",
            r"(?m)^\s*def\s+\w+",
            r"(?m)^\s*class\s+\w+",
            r"\b(?:public|private|protected|static)\s+\w+\s+\w+\s*\([^)]*\)\s*\{",
            r"\bfunc\s+\w+",
            r"\bfn\s+\w+",
            r"\bstruct\s+\w+",
            r"\b\w+\s+\w+\s*\([^;{]*\)\s*\{",
        ];
        patterns
            .iter()
            .map(|&p| (p.to_string(), Regex::new(p).unwrap()))
            .collect()
    });
    let compiled = |p: &&str| RE_CACHE.get(*p);

    let (fn_patterns, cls_patterns): (Vec<&str>, Vec<&str>) = match language {
        "javascript" | "typescript" => (
            vec![r"\bfunction\s+\w+", r"=>\s*\{"],
            vec![r"\bclass\s+\w+"],
        ),
        "python" => (vec![r"(?m)^\s*def\s+\w+"], vec![r"(?m)^\s*class\s+\w+"]),
        "java" | "csharp" => (
            vec![r"\b(?:public|private|protected|static)[^;{}]*\([^)]*\)\s*\{"],
            vec![r"\bclass\s+\w+"],
        ),
        "go" => (vec![r"\bfunc\s+\w+"], vec![]),
        "rust" => (vec![r"\bfn\s+\w+"], vec![r"\bstruct\s+\w+"]),
        "c" => (vec![r"\b\w+\s+\w+\s*\([^;{]*\)\s*\{"], vec![]),
        "cpp" => (
            vec![r"\b\w+\s+\w+\s*\([^;{]*\)\s*\{"],
            vec![r"\bclass\s+\w+"],
        ),
        "ruby" => (vec![r"(?m)^\s*def\s+\w+"], vec![r"(?m)^\s*class\s+\w+"]),
        "php" => (vec![r"\bfunction\s+\w+"], vec![r"\bclass\s+\w+"]),
        _ => return (0, 0),
    };

    let fn_count: usize = fn_patterns
        .iter()
        .filter_map(compiled)
        .map(|re| re.find_iter(text).count())
        .sum();

    let cls_count: usize = cls_patterns
        .iter()
        .filter_map(compiled)
        .map(|re| re.find_iter(text).count())
        .sum();

    (fn_count, cls_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BridgeConfig;
    use crate::db;
    use crate::state::AppState;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn unique_subdir(label: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cc-bridge-analyze-test-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir create");
        dir
    }

    fn make_state(f: impl FnOnce(&mut BridgeConfig)) -> (Arc<AppState>, std::path::PathBuf) {
        let dir = unique_subdir("analyze");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        let mut cfg = BridgeConfig {
            allowed_roots: vec![dir.to_string_lossy().into_owned()],
            ..BridgeConfig::default()
        };
        f(&mut cfg);
        (Arc::new(AppState::new(conn, cfg, dir.clone())), dir)
    }

    /// 小文件：line/function/class 计数全部给出，analysisNote 是正常的启发式提示。
    #[tokio::test]
    async fn small_file_returns_full_counts() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".rs".to_string()];
            c.whitelist_enabled = true;
        });
        let p = dir.join("small.rs");
        std::fs::write(
            &p,
            "fn alpha() {}\nfn beta() {}\nstruct Gamma {}\nfn delta() {}\n",
        )
        .unwrap();

        let v = handle(
            AnalyzeFileArgs {
                path: p.to_string_lossy().into_owned(),
            },
            &state,
        )
        .await
        .expect("small file analyze should succeed");
        let text = v["content"][0]["text"].as_str().unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(info["encoding"].as_str(), Some("utf8"));
        assert_eq!(info["language"].as_str(), Some("rust"));
        assert!(info["lineCount"].as_u64().unwrap() > 0, "lineCount 应 > 0");
        assert!(
            info["functionCount"].as_u64().unwrap() >= 3,
            "至少 alpha/beta/delta 三个 fn"
        );
        assert!(
            info["classCount"].as_u64().unwrap() >= 1,
            "至少 Gamma struct"
        );
        assert!(
            info["analysisNote"].as_str().unwrap().contains("heuristic"),
            "小文件 analysisNote 应保持原文（heuristic 提示）"
        );
    }

    /// 大文件（>64MB）：line/function/class 全部 None，analysisNote 明确说明跳过原因。
    /// 这一条专盯 H1 修复：避免对大文件做全文件 in-memory decode（OOM 风险）。
    /// 文件用稀疏写盘（64MB + 1 字节），阈值走 "> LARGE_FILE_LINE_SCAN_BYTES" 的严格大于分支。
    #[tokio::test]
    async fn large_file_skips_line_scan() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".rs".to_string()];
            c.whitelist_enabled = true;
            // 把 max_file_size_bytes 调到足够大，允许 analyze 一个 64MB+ 的文件。
            c.max_file_size_bytes = 256 * 1024 * 1024;
        });
        let p = dir.join("big.rs");
        // 64MB + 100 字节（首字节 'f'，其余填充 'x' 保证从 utf8 视角合法）。
        // 用 std::fs::File + 1MB 缓冲循环写盘，避免在 Rust 内存里一次分配 64MB Vec。
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&p)
            .unwrap();
        f.write_all(b"f").unwrap();
        let buf = vec![b'x'; 1024 * 1024]; // 1MB
        let total: u64 = 64 * 1024 * 1024 + 100;
        let mut written: u64 = 1;
        while written < total {
            let chunk = buf.len().min((total - written) as usize);
            f.write_all(&buf[..chunk]).unwrap();
            written += chunk as u64;
        }
        f.sync_all().unwrap();
        let actual = std::fs::metadata(&p).unwrap().len();
        assert!(
            actual > 64 * 1024 * 1024,
            "测试 fixture 必须 > 64MB，实际 {actual}"
        );

        let v = handle(
            AnalyzeFileArgs {
                path: p.to_string_lossy().into_owned(),
            },
            &state,
        )
        .await
        .expect("large file analyze should still succeed (skipping line scan, not failing)");
        let text = v["content"][0]["text"].as_str().unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            info["lineCount"],
            serde_json::Value::Null,
            "大文件 lineCount 必须为 null"
        );
        assert_eq!(
            info["functionCount"],
            serde_json::Value::Null,
            "大文件 functionCount 必须为 null"
        );
        assert_eq!(
            info["classCount"],
            serde_json::Value::Null,
            "大文件 classCount 必须为 null"
        );
        assert_eq!(info["size"].as_u64(), Some(actual), "size 必须真实回报");
        let note = info["analysisNote"].as_str().unwrap();
        assert!(
            note.contains("skipped"),
            "analysisNote 应说明跳过原因，实际：{note}"
        );
        assert!(
            note.contains("read_files") || note.contains("search_files"),
            "analysisNote 应给出替代工具建议，实际：{note}"
        );
    }
}
