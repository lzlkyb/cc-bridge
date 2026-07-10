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

    let max_file_size = config.max_file_size_bytes;
    drop(config);

    let name_matcher = args.name_pattern.as_deref().map(compile_glob).transpose()?;
    let content_regex = args.content_pattern.as_deref().map(|p| {
        regex::Regex::new(p).unwrap_or_else(|_| regex::Regex::new(&regex::escape(p)).unwrap())
    });
    let max_results = args.max_results;

    // ignore::Walk 是同步/阻塞迭代器（内部基于 walkdir），丢进 spawn_blocking 避免
    // 占用 tokio 工作线程；文件内容读取也相应改用 std::fs（同一个 blocking 任务里）。
    let matches = tokio::task::spawn_blocking(move || {
        walk_search_blocking(
            &root_resolved,
            name_matcher.as_ref(),
            content_regex.as_ref(),
            max_results,
            max_file_size,
        )
    })
    .await
    .map_err(|e| format!("search task panicked: {e}"))?;

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&matches).unwrap() }] }),
    )
}

fn compile_glob(pattern: &str) -> Result<globset::GlobMatcher, String> {
    globset::GlobBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map_err(|e| format!("Invalid namePattern: {e}"))
        .map(|g| g.compile_matcher())
}

fn walk_search_blocking(
    root: &Path,
    name_matcher: Option<&globset::GlobMatcher>,
    content_regex: Option<&regex::Regex>,
    max_results: usize,
    max_file_size: u64,
) -> Vec<Value> {
    let mut matches = Vec::new();

    // ignore::WalkBuilder 默认已开启 git_ignore（吃 .gitignore 规则）。这里显式
    // hidden(false)：保留现有"不隐藏点文件"的行为，不额外引入没人要求的过滤。
    // 但 hidden(false) 会连带让 .git 目录本身也被遍历进去（ripgrep 自己的已知行为，
    // 见 BurntSushi/ripgrep#3099，官方判定 wontfix），所以额外加一条 override 规则
    // 强制排除 .git，不依赖 hidden 开关。
    let mut builder = ignore::WalkBuilder::new(root);
    builder.hidden(false);
    let mut override_builder = ignore::overrides::OverrideBuilder::new(root);
    if override_builder.add("!.git").is_ok() {
        if let Ok(built) = override_builder.build() {
            builder.overrides(built);
        }
    }

    for entry in builder.build() {
        if matches.len() >= max_results {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }

        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy();

        if let Some(m) = name_matcher {
            if !m.is_match(file_name.as_ref()) {
                continue;
            }
        }

        if content_regex.is_none() {
            matches.push(json!({ "path": path.to_string_lossy(), "type": "name" }));
            continue;
        }

        let Ok(file_meta) = entry.metadata() else {
            continue;
        };
        if file_meta.len() > max_file_size {
            continue;
        }

        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };

        let content_re = content_regex.unwrap();
        let lines: Vec<&str> = content.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if matches.len() >= max_results {
                break;
            }
            if content_re.is_match(line) {
                let ctx_before: Vec<&str> = lines[i.saturating_sub(2)..i].to_vec();
                let ctx_after: Vec<&str> = lines
                    .get(i + 1..=(i + 2).min(lines.len().saturating_sub(1)))
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

    matches
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 用 std::env::temp_dir() 而非 tempfile crate——cc-bridge 没有 dev-deps 段，
    /// 且本测试只需要一个"独立、唯一、可写"的目录树，stdlib 足够。每个 case 走
    /// unique_subdir 保证并发跑不出错。
    fn unique_subdir(label: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cc-bridge-search-test-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("tempdir create");
        dir
    }

    /// 写文件（含父目录），方便造 fixture。
    fn touch(p: &Path, body: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create_parent");
        }
        fs::write(p, body).expect("write fixture");
    }

    /// fixture：模拟一个 cc-bridge 用户项目根，包含：
    /// - 顶层 Cargo.toml / src/lib.rs（应被搜到）
    /// - .git/ 目录（应被 ignore 跳过）
    /// - build/.gitignore 含 target/ + build/target/x.txt（应被 ignore 跳过）
    /// - node_modules/foo.js（无 .gitignore 提及，仍被列出——这是用户源文件外的目录）
    fn build_fixture() -> std::path::PathBuf {
        let root = unique_subdir("fixture");
        touch(&root.join("Cargo.toml"), "[package]\nname=\"x\"\n");
        touch(&root.join("src/lib.rs"), "fn main(){}\n");
        touch(&root.join(".git/HEAD"), "ref: refs/heads/main\n");
        touch(&root.join("build/target/x.txt"), "should be ignored\n");
        touch(&root.join("build/.gitignore"), "target/\n");
        touch(&root.join("node_modules/foo.js"), "var x=1\n");
        touch(&root.join("docs/README.md"), "hello\n");
        root
    }

    fn collected_paths(matches: &[Value]) -> Vec<String> {
        matches
            .iter()
            .map(|m| {
                m.get("path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn skips_dot_git_even_with_hidden_false() {
        // D 组 P4-2 行为变更：默认隐藏 .git 是用 OverrideBuilder add("!.git") 强排除。
        // 旧版（手写 walker + 不主动过滤 .git）会返回 .git/HEAD 作为结果。
        let root = build_fixture();
        let matches = walk_search_blocking(&root, None, None, 1000, 1_000_000);
        let paths = collected_paths(&matches);

        // 检查含 "/.git/" 或以 "/.git" 结尾的路径不应出现（不能简单 contains(".git")，
        // 因为 build/.gitignore 含 ".git" 字面但本身应在结果里——它不是被排除的对象）。
        let dot_git_paths: Vec<&String> = paths
            .iter()
            .filter(|p| {
                let normalized = p.replace('\\', "/");
                normalized.contains("/.git/") || normalized.ends_with("/.git")
            })
            .collect();
        assert!(
            dot_git_paths.is_empty(),
            ".git/ 内容不应被遍历到，结果含：{dot_git_paths:?}"
        );
        // 顶上还能找到 Cargo.toml
        assert!(
            paths.iter().any(|p| p.ends_with("Cargo.toml")),
            "应找到 Cargo.toml，结果：{paths:?}"
        );
        // build/target/x.txt 被 .gitignore 排除
        assert!(
            !paths.iter().any(|p| p.contains("build/target")),
            "build/.gitignore 应排除 target/，结果：{paths:?}"
        );
    }

    #[test]
    fn glob_recursive_matches_nested_paths() {
        // 旧版 glob_to_regex 不支持 '**' → `**/*.toml` 实际只匹配当前目录的 *.toml，
        // 嵌套的会被漏掉。这是 D 组 P4-2 的关键修复点之一。
        let root = build_fixture();
        // Cargo.toml 在根；fixture 里 Cargo.toml 一份即可，足以证明单级。
        // 加一个深层 toml 来验证 ** 跨目录匹配。
        touch(&root.join("deep/nested/dir/Cargo.toml"), "[package]\nname=\"y\"\n");

        let matcher = compile_glob("**/*.toml").expect("**/*.toml is valid");
        let matches = walk_search_blocking(&root, Some(&matcher), None, 1000, 1_000_000);
        let paths = collected_paths(&matches);

        // 两层 toml 都该匹配到
        assert!(
            paths.iter().any(|p| p.ends_with("Cargo.toml")),
            "顶层 Cargo.toml 应匹配，结果：{paths:?}"
        );
        assert!(
            paths.iter().any(|p| p.contains("deep") && p.ends_with("Cargo.toml")),
            "嵌套 Cargo.toml 应匹配（** 跨目录生效），结果：{paths:?}"
        );
    }

    #[test]
    fn content_pattern_finds_substring_in_line() {
        // 旧手写版就走 regex.is_match(line)；新 walk 走 ignore crate 但内容匹配逻辑未变。
        // 这条测试专盯 walker 接入后内容匹配仍正常。
        let root = build_fixture();
        // fixture 里 src/lib.rs 含 "fn main"
        let re = regex::Regex::new("fn main").unwrap();
        let matches = walk_search_blocking(&root, None, Some(&re), 1000, 1_000_000);
        assert!(!matches.is_empty(), "应至少命中 1 行 fn main");
        let m = &matches[0];
        assert_eq!(m.get("type").and_then(|t| t.as_str()), Some("content"));
        assert_eq!(m.get("lineNumber").and_then(|n| n.as_u64()), Some(1));
    }
}
