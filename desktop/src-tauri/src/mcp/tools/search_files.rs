use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SearchFilesArgs {
    #[serde(rename = "rootPath")]
    pub root_path: String,
    #[serde(rename = "namePattern")]
    pub name_pattern: Option<String>,
    #[serde(rename = "contentPattern")]
    pub content_pattern: Option<String>,
    #[serde(rename = "maxResults", default = "default_max_results")]
    pub max_results: usize,
}

fn default_max_results() -> usize {
    100
}

pub async fn handle(args: SearchFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let root_resolved = security::path::resolve_safe_path(
        &args.root_path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;

    let metadata = tokio::fs::metadata(&root_resolved)
        .await
        .map_err(|e| format!("Cannot stat: {e}"))?;
    if !metadata.is_dir() {
        return Err("rootPath is not a directory".into());
    }

    let name_regex = args.name_pattern.as_deref().map(glob_to_regex);
    let content_regex = args.content_pattern.as_deref().map(|p| {
        regex::Regex::new(p).unwrap_or_else(|_| regex::Regex::new(&regex::escape(p)).unwrap())
    });

    let mut matches = Vec::new();
    walk_search(
        &root_resolved,
        &name_regex,
        &content_regex,
        args.max_results,
        config.max_file_size_bytes,
        &mut matches,
    )
    .await;

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&matches).unwrap() }] }),
    )
}

fn glob_to_regex(glob: &str) -> regex::Regex {
    let mut re = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => {
                if ".+^${}()|[]\\".contains(c) {
                    re.push('\\');
                }
                re.push(c);
            }
        }
    }
    re.push('$');
    regex::RegexBuilder::new(&re)
        .case_insensitive(true)
        .build()
        .unwrap()
}

async fn walk_search(
    dir: &Path,
    name_regex: &Option<regex::Regex>,
    content_regex: &Option<regex::Regex>,
    max_results: usize,
    max_file_size: u64,
    matches: &mut Vec<Value>,
) {
    if matches.len() >= max_results {
        return;
    }

    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        if matches.len() >= max_results {
            return;
        }

        let path = entry.path();
        let metadata = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            Box::pin(walk_search(
                &path,
                name_regex,
                content_regex,
                max_results,
                max_file_size,
                matches,
            ))
            .await;
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        if let Some(re) = name_regex {
            if !re.is_match(&file_name) {
                continue;
            }
        }

        if content_regex.is_none() {
            matches.push(json!({ "path": path.to_string_lossy(), "type": "name" }));
            continue;
        }

        if metadata.len() > max_file_size {
            continue;
        }

        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        let content_re = content_regex.as_ref().unwrap();
        for (i, line) in content.lines().enumerate() {
            if matches.len() >= max_results {
                break;
            }
            if content_re.is_match(line) {
                let lines: Vec<&str> = content.lines().collect();
                let ctx_before: Vec<&str> = lines[i.saturating_sub(2)..i].to_vec();
                let ctx_after: Vec<&str> = lines
                    .get(i + 1..=(i + 2).min(lines.len() - 1))
                    .unwrap_or(&[])
                    .to_vec();

                matches.push(json!({
                    "path": path.to_string_lossy(),
                    "type": "content",
                    "lineNumber": i + 1,
                    "line": line,
                    "contextBefore": ctx_before,
                    "contextAfter": ctx_after,
                }));
            }
        }
    }
}
