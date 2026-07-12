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
    let resolved = security::path::resolve_safe_path(
        &args.path,
        &config.allowed_roots,
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

    let (line_count, function_count, class_count) = if encoding != "binary" {
        let text = String::from_utf8_lossy(&data);
        let lines = if text.is_empty() {
            0
        } else {
            text.lines().count()
        };
        let (fns, cls) = count_functions_classes(&text, &language);
        (Some(lines), Some(fns), Some(cls))
    } else {
        (None, None, None)
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
        "analysisNote": "function/class counts are heuristic regex-based estimates, not AST-accurate parsing",
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
