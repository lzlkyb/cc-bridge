use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
    // ---- 富 Grep 选项（仅 content_pattern 生效，对标 native Claude Code 的 Grep）----
    #[serde(rename = "caseInsensitive", default)]
    pub case_insensitive: Option<bool>,
    #[serde(rename = "beforeContext", default)]
    pub before_context: Option<usize>,
    #[serde(rename = "afterContext", default)]
    pub after_context: Option<usize>,
    #[serde(rename = "context", default)]
    pub context: Option<usize>,
    #[serde(rename = "lineNumbers", default)]
    pub line_numbers: Option<bool>,
    #[serde(rename = "headLimit", default)]
    pub head_limit: Option<usize>,
    #[serde(rename = "outputMode", default)]
    pub output_mode: Option<String>,
    #[serde(rename = "multiline", default)]
    pub multiline: Option<bool>,
}

/// 文件内容 Grep 的输出模式（对标 native Claude Code 的 Grep `output_mode`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    /// 返回每个匹配行（含行号/上下文），默认。
    Content,
    /// 只返回含匹配的文件路径（去重）。
    FilesWithMatches,
    /// 返回每个文件的匹配计数。
    Count,
}

/// 富 Grep 选项，从 `SearchFilesArgs` 解析而来（仅 `content_pattern` 生效）。
#[derive(Debug, Clone, Copy)]
struct GrepOptions {
    before: usize,
    after: usize,
    line_numbers: bool,
    head_limit: usize,
    output_mode: OutputMode,
}

impl Default for GrepOptions {
    fn default() -> Self {
        Self {
            before: 2,
            after: 2,
            line_numbers: true,
            head_limit: usize::MAX,
            output_mode: OutputMode::Content,
        }
    }
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
        let build_matcher = |pat: &str| -> grep_regex::RegexMatcher {
            grep_regex::RegexMatcherBuilder::new()
                .case_insensitive(args.case_insensitive.unwrap_or(false))
                .multi_line(args.multiline.unwrap_or(false))
                .build(pat)
                .expect("invalid content_pattern")
        };
        // 先按原始 pattern 编译；非法正则（如裸特殊字符）则用 regex::escape 转义后
        // 重试，对齐旧版 RegexBuilder + escape 的回退语义。
        match grep_regex::RegexMatcherBuilder::new()
            .case_insensitive(args.case_insensitive.unwrap_or(false))
            .multi_line(args.multiline.unwrap_or(false))
            .build(p)
        {
            Ok(m) => m,
            Err(_) => build_matcher(&regex::escape(p)),
        }
    });

    // 富 Grep 选项：从 SearchFilesArgs 解析。`context` 同时覆盖 before/after；
    // `head_limit` 缺省时回退到 `max_results`（保持原有 maxResults 语义）。
    let grep = GrepOptions {
        before: args.before_context.or(args.context).unwrap_or(2),
        after: args.after_context.or(args.context).unwrap_or(2),
        line_numbers: args.line_numbers.unwrap_or(true),
        head_limit: args.head_limit.unwrap_or(args.max_results),
        output_mode: match args.output_mode.as_deref() {
            Some("files_with_matches") => OutputMode::FilesWithMatches,
            Some("count") => OutputMode::Count,
            _ => OutputMode::Content,
        },
    };

    // ignore::Walk 是同步/阻塞迭代器（内部基于 walkdir），丢进 spawn_blocking 避免
    // 占用 tokio 工作线程；文件内容读取也相应改用 std::fs（同一个 blocking 任务里）。
    let matches = tokio::task::spawn_blocking(move || {
        walk_search_blocking(
            &root_resolved,
            name_matcher.as_ref(),
            content_regex.as_ref(),
            &grep,
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
    content_regex: Option<&grep_regex::RegexMatcher>,
    grep: &GrepOptions,
    max_file_size: u64,
) -> Vec<Value> {
    let matches: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let counter: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let head_limit = grep.head_limit;

    // ignore::WalkBuilder 默认开启 git_ignore（吃 .gitignore）。hidden(false) 保留
    // "不隐藏点文件" 的现有行为。ripgrep 已知行为：hidden(false) 会让 .git 被遍历
    // （BurntSushi/ripgrep#3099，官方 wontfix），故用 OverrideBuilder 强制排除。
    // P6-1 关键变更：除 .git 外，再强制排除 target/ 与 node_modules/，不依赖搜索
    // 根目录是否恰好有 .gitignore 挡住构建目录——这正是审计日志里 search_files 最坏
    // 长尾（~20s）的来源（会把构建产物整盘扫进去）。
    // P6-2 补齐：再排除 .svn/.hg/.bzr 三类 VCS 元数据目录，对齐 native Claude Code
    // 底层 ripgrep 的默认 VCS 排除名单（.git/.svn/.hg/.bzr/.jj/.sl）。老 SVN/Hg
    // 工程（如含数千 .svn-base 的目录）不再被整盘扫进去。
    let mut builder = ignore::WalkBuilder::new(root);
    builder.hidden(false);
    let mut override_builder = ignore::overrides::OverrideBuilder::new(root);
    let mut ov_ok = true;
    for pat in [
        "!.git",
        "!.svn",
        "!.hg",
        "!.bzr",
        "!target",
        "!node_modules",
    ] {
        if override_builder.add(pat).is_err() {
            ov_ok = false;
        }
    }
    if ov_ok {
        if let Ok(built) = override_builder.build() {
            builder.overrides(built);
        }
    }

    // P6-1 关键变更：build_parallel() 多核并行遍历（ripgrep 快的根因）。结果收集到
    // Mutex<Vec> 并在达到 head_limit 时 WalkState::Quit 早停。文件内容读取（std::fs）
    // 天然落在 rayon 线程池里并行执行。
    let matches_arc = Arc::clone(&matches);
    let counter_arc = Arc::clone(&counter);
    builder.build_parallel().run(|| {
        let matches = Arc::clone(&matches_arc);
        let counter = Arc::clone(&counter_arc);
        Box::new(move |entry| {
            if counter.load(Ordering::Relaxed) >= head_limit {
                return ignore::WalkState::Quit;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                return ignore::WalkState::Continue;
            }
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy();
            if let Some(m) = name_matcher {
                if !m.is_match(file_name.as_ref()) {
                    return ignore::WalkState::Continue;
                }
            }

            // 仅按文件名匹配：直接入队。附带 _mtime（内部字段，排序后剥离）用于
            // P6-2 的「最近修改优先」排序，对齐 native Glob 行为。
            if content_regex.is_none() {
                // 毫秒精度：同一秒内创建/修改的多个文件也能正确按修改时间排序。
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let mut g = matches.lock().unwrap();
                g.push(json!({ "path": path.to_string_lossy(), "type": "name", "_mtime": mtime }));
                let n = g.len();
                drop(g);
                counter.fetch_add(1, Ordering::Relaxed);
                return if n >= head_limit {
                    ignore::WalkState::Quit
                } else {
                    ignore::WalkState::Continue
                };
            }

            let file_meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => return ignore::WalkState::Continue,
            };
            if file_meta.len() > max_file_size {
                return ignore::WalkState::Continue;
            }

            // P6-3：内容搜索统一交给 grep-searcher（ripgrep 同款引擎），替换旧版
            // 逐行 BufReader.lines() + regex。获得 mmap+SIMD+字面量预筛（大文件 2–5x
            // 提速）、自动二进制检测（NUL 文件跳过，对齐 native Grep --text 默认关）、
            // 非 UTF-8 鲁棒（Lossy 解码，GBK 等老工程不再漏搜）。
            let results = grep_file(path, content_regex.unwrap(), grep, head_limit, &counter);
            if results.is_empty() {
                return ignore::WalkState::Continue;
            }
            let mut g = matches.lock().unwrap();
            for r in results {
                if g.len() >= head_limit {
                    break;
                }
                g.push(r);
            }
            let n = g.len();
            drop(g);
            counter.fetch_add(n, Ordering::Relaxed);
            if n >= head_limit {
                ignore::WalkState::Quit
            } else {
                ignore::WalkState::Continue
            }
        })
    });

    // 并行遍历结果顺序不确定 -> 统一排序保证确定性输出。
    // P6-2：name 模式带 _mtime -> 主键按修改时间「倒序」（最近修改优先，对齐 native
    // Glob）；content 模式无 _mtime（均视为 0）-> 自然退化为 path + lineNumber 的
    // 确定性排序（对齐 native Grep 的路径序，行号有意义）。
    // 注：head_limit 早停保留（P6-1 性能特性），故命中数超过 head_limit 时得到的是
    // 「早停收集到的那批」内按上述规则排序；精确搜索（结果数 < head_limit）完全正确。
    let mut out = std::mem::take(&mut *matches.lock().unwrap());
    out.sort_by(|a, b| {
        let ma = a.get("_mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        let mb = b.get("_mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        match mb.cmp(&ma) {
            std::cmp::Ordering::Equal => {
                let pa = a.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let pb = b.get("path").and_then(|v| v.as_str()).unwrap_or("");
                match pa.cmp(pb) {
                    std::cmp::Ordering::Equal => {
                        let la = a.get("lineNumber").and_then(|v| v.as_u64()).unwrap_or(0);
                        let lb = b.get("lineNumber").and_then(|v| v.as_u64()).unwrap_or(0);
                        la.cmp(&lb)
                    }
                    other => other,
                }
            }
            other => other,
        }
    });
    // 剥离内部排序字段 _mtime，不污染对外 JSON 结果。
    for v in out.iter_mut() {
        if let Some(obj) = v.as_object_mut() {
            obj.remove("_mtime");
        }
    }
    out
}

/// 用 grep-searcher（ripgrep 同款引擎）对单文件做内容搜索。
///
/// 相较旧版「逐行 `BufReader.lines()` + `regex`」，本实现获得：
/// - **内存映射 + SIMD 行扫描 + 字面量预筛**（`grep_regex` 默认开启），大文件 2–5x 提速；
/// - **自动二进制检测**：含 NUL 的文件视为二进制直接跳过，对齐 native Grep（`--text` 默认关）；
/// - **非 UTF-8 鲁棒**：`Lossy` 解码（无效字节替换为 U+FFFD），GBK 等老工程源码不再被漏搜
///   （旧版 `read_to_string`/`lines()` 遇非 UTF-8 直接 `Err` 中断，导致整文件漏命中）。
///
/// 三模式：
/// - `FilesWithMatches`：命中第一行即停止扫描（早停）；
/// - `Count`：统计匹配行数（需扫完全文件）；
/// - `Content`：返回每个匹配行的行号/文本 + 前 `before`/后 `after` 行上下文。
fn grep_file(
    path: &Path,
    matcher: &grep_regex::RegexMatcher,
    grep: &GrepOptions,
    head_limit: usize,
    counter: &AtomicUsize,
) -> Vec<Value> {
    use grep_searcher::{sinks, BinaryDetection, SearcherBuilder};
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .build();

    match grep.output_mode {
        OutputMode::FilesWithMatches => {
            let mut found = false;
            let res = searcher.search_path(
                matcher,
                path,
                sinks::Lossy(|_ln, _line| {
                    found = true;
                    Ok(false) // 命中即停
                }),
            );
            if res.is_err() || !found {
                return Vec::new();
            }
            vec![json!({ "path": path.to_string_lossy(), "type": "content" })]
        }
        OutputMode::Count => {
            let mut count = 0usize;
            let res = searcher.search_path(
                matcher,
                path,
                sinks::Lossy(|_ln, _line| {
                    count += 1;
                    Ok(true)
                }),
            );
            if res.is_err() || count == 0 {
                return Vec::new();
            }
            vec![json!({
                "path": path.to_string_lossy(),
                "type": "content",
                "count": count,
            })]
        }
        OutputMode::Content => {
            // 先 mmap + SIMD 快扫匹配行（不整读内存），命中即收集行号 + 文本。
            let mut hits: Vec<(u64, String)> = Vec::new();
            let res = searcher.search_path(
                matcher,
                path,
                sinks::Lossy(|ln, line| {
                    if counter.load(Ordering::Relaxed) + hits.len() >= head_limit {
                        return Ok(false); // 受 head_limit 约束早停
                    }
                    hits.push((ln, line.to_string()));
                    Ok(true)
                }),
            );
            if res.is_err() || hits.is_empty() {
                return Vec::new();
            }
            // 取上下文：用 `from_utf8_lossy` 读全行（与 grep-searcher 同样的 Lossy 语义，
            // 保证 GBK 等非 UTF-8 文件上下文也能正确切片，彻底修复旧版 `read_to_string` 漏搜）。
            let Ok(bytes) = std::fs::read(path) else {
                return Vec::new();
            };
            let content = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = content.lines().collect();
            let mut objs: Vec<Value> = Vec::new();
            for (ln, line) in &hits {
                if objs.len() >= head_limit {
                    break;
                }
                let idx = (*ln).saturating_sub(1) as usize;
                let ctx_before: Vec<&str> = lines[idx.saturating_sub(grep.before)..idx].to_vec();
                let ctx_after: Vec<&str> = lines
                    .get(idx + 1..=(idx + grep.after).min(lines.len().saturating_sub(1)))
                    .unwrap_or(&[])
                    .to_vec();
                let mut obj = json!({
                    "path": path.to_string_lossy(),
                    "type": "content",
                    "line": line,
                    "contextBefore": ctx_before,
                    "contextAfter": ctx_after,
                });
                if grep.line_numbers {
                    obj["lineNumber"] = json!(ln);
                }
                objs.push(obj);
            }
            objs
        }
    }
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

    /// P6-3 测试辅助：用 grep-searcher 的 RegexMatcher 替换旧版 regex::Regex，
    /// 对齐生产代码（search_files 内容搜索已切到 grep_regex::RegexMatcher）。
    fn matcher(p: &str) -> grep_regex::RegexMatcher {
        grep_regex::RegexMatcherBuilder::new()
            .build(p)
            .expect("test pattern should compile")
    }
    fn matcher_ci(p: &str, ci: bool) -> grep_regex::RegexMatcher {
        grep_regex::RegexMatcherBuilder::new()
            .case_insensitive(ci)
            .build(p)
            .expect("test pattern should compile")
    }

    #[test]
    fn skips_dot_git_even_with_hidden_false() {
        // D 组 P4-2 行为变更：默认隐藏 .git 是用 OverrideBuilder add("!.git") 强排除。
        // 旧版（手写 walker + 不主动过滤 .git）会返回 .git/HEAD 作为结果。
        let root = build_fixture();
        let matches = walk_search_blocking(&root, None, None, &GrepOptions::default(), 1_000_000);
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
        touch(
            &root.join("deep/nested/dir/Cargo.toml"),
            "[package]\nname=\"y\"\n",
        );

        let matcher = compile_glob("**/*.toml").expect("**/*.toml is valid");
        let matches = walk_search_blocking(
            &root,
            Some(&matcher),
            None,
            &GrepOptions::default(),
            1_000_000,
        );
        let paths = collected_paths(&matches);

        // 两层 toml 都该匹配到
        assert!(
            paths.iter().any(|p| p.ends_with("Cargo.toml")),
            "顶层 Cargo.toml 应匹配，结果：{paths:?}"
        );
        assert!(
            paths
                .iter()
                .any(|p| p.contains("deep") && p.ends_with("Cargo.toml")),
            "嵌套 Cargo.toml 应匹配（** 跨目录生效），结果：{paths:?}"
        );
    }

    #[test]
    fn content_pattern_finds_substring_in_line() {
        // 旧手写版就走 regex.is_match(line)；新 walk 走 ignore crate 但内容匹配逻辑未变。
        // 这条测试专盯 walker 接入后内容匹配仍正常。
        let root = build_fixture();
        // fixture 里 src/lib.rs 含 "fn main"
        let re = matcher("fn main");
        let matches =
            walk_search_blocking(&root, None, Some(&re), &GrepOptions::default(), 1_000_000);
        assert!(!matches.is_empty(), "应至少命中 1 行 fn main");
        let m = &matches[0];
        assert_eq!(m.get("type").and_then(|t| t.as_str()), Some("content"));
        assert_eq!(m.get("lineNumber").and_then(|n| n.as_u64()), Some(1));
    }

    #[test]
    fn case_insensitive_content_match() {
        let root = build_fixture();
        // docs/README.md 含 "hello"（小写）。大小写敏感正则 "HELLO" 不应命中；
        // 大小写不敏感正则应命中（case_insensitive 通过 RegexBuilder 应用到正则本身）。
        let sensitive = matcher_ci("HELLO", false);
        let sensitive_matches = walk_search_blocking(
            &root,
            None,
            Some(&sensitive),
            &GrepOptions::default(),
            1_000_000,
        );
        assert!(
            sensitive_matches.is_empty(),
            "大小写敏感，HELLO 不应匹配 hello，结果：{sensitive_matches:?}"
        );

        let ci = matcher_ci("HELLO", true);
        let ci_matches =
            walk_search_blocking(&root, None, Some(&ci), &GrepOptions::default(), 1_000_000);
        assert!(
            !ci_matches.is_empty(),
            "大小写不敏感应匹配 hello，结果：{ci_matches:?}"
        );
    }

    #[test]
    fn output_mode_files_with_matches_omits_line_detail() {
        let root = build_fixture();
        let re = matcher("hello");
        let opts = GrepOptions {
            output_mode: OutputMode::FilesWithMatches,
            ..Default::default()
        };
        let matches = walk_search_blocking(&root, None, Some(&re), &opts, 1_000_000);
        assert!(!matches.is_empty(), "应至少命中一个文件");
        for m in &matches {
            assert!(
                m.get("lineNumber").is_none(),
                "files_with_matches 不应含 lineNumber，实际：{m}"
            );
            assert!(
                m.get("line").is_none(),
                "files_with_matches 不应含 line，实际：{m}"
            );
            assert_eq!(m.get("type").and_then(|t| t.as_str()), Some("content"));
        }
    }

    #[test]
    fn output_mode_count_returns_count() {
        let root = build_fixture();
        // docs/README.md 重写含 3 行 hello，验证 count。
        touch(&root.join("docs/README.md"), "hello\nhello\nhello\n");
        let re = matcher("hello");
        let opts = GrepOptions {
            output_mode: OutputMode::Count,
            ..Default::default()
        };
        let matches = walk_search_blocking(&root, None, Some(&re), &opts, 1_000_000);
        assert!(!matches.is_empty(), "应至少命中一个文件");
        for m in &matches {
            let c = m.get("count").and_then(|c| c.as_u64()).expect("count 字段");
            assert!(c > 0, "count 应 > 0，实际：{c}");
        }
    }

    #[test]
    fn context_before_after_is_configurable() {
        let root = unique_subdir("ctx");
        touch(&root.join("f.txt"), "L1\nL2\nL3\nMATCH\nL5\nL6\nL7\n");
        let re = matcher("MATCH");
        let opts = GrepOptions {
            before: 1,
            after: 1,
            line_numbers: false,
            ..Default::default()
        };
        let matches = walk_search_blocking(&root, None, Some(&re), &opts, 1_000_000);
        assert_eq!(matches.len(), 1, "应恰好 1 个匹配，实际：{matches:?}");
        let m = &matches[0];
        assert_eq!(
            m.get("lineNumber"),
            None,
            "line_numbers=false 不应含 lineNumber"
        );
        let before: Vec<String> = m
            .get("contextBefore")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let after: Vec<String> = m
            .get("contextAfter")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        assert_eq!(before, vec!["L3".to_string()], "before=1 应仅含 L3");
        assert_eq!(after, vec!["L5".to_string()], "after=1 应仅含 L5");
    }
    /// 受控基准（默认 ignore，避免拖慢常规 `cargo test`）：复现 P6-1 真实最坏场景——
    /// 一个「没有 .gitignore 挡住构建目录」的项目根，含大量 target/ 构建产物。
    /// 旧串行版会整盘扫进 target/；新并行版强制排除 target/ 只扫源码。手动运行：
    /// `cargo test --lib bench_walk_real_project_timing -- --ignored --nocapture`
    #[test]
    fn binary_file_is_skipped_like_native_grep() {
        // P6-3：grep-searcher 默认二进制检测（quit(0)）让含 NUL 的文件被跳过，
        // 对齐 native Grep（--text 默认关）。旧版 BufReader.lines() 会把含 NUL 的
        // 文件当普通文本扫，可能被误匹配；新行为应整文件跳过。
        let root = build_fixture();
        let bin = root.join("assets/blob.bin");
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        // 以 NUL 开头 + 后面跟一个可匹配串：NUL 在前，整个文件应被跳过。
        fs::write(bin, [0x00, b'w', b'o', b'r', b'l', b'd']).unwrap();
        let re = matcher("world");
        let matches =
            walk_search_blocking(&root, None, Some(&re), &GrepOptions::default(), 1_000_000);
        assert!(
            !collected_paths(&matches)
                .iter()
                .any(|p| p.ends_with("blob.bin")),
            "含 NUL 的二进制文件应被跳过，结果：{:?}",
            collected_paths(&matches)
        );
    }

    #[test]
    fn gbk_file_searchable_not_skipped() {
        // P6-3 修复的隐藏 bug：旧版 read_to_string 遇非 UTF-8 字节直接 Err 中断，
        // GBK 等老工程源码被整文件漏搜。grep-searcher 的 Lossy 解码 + Content 模式
        // 的 from_utf8_lossy 取上下文，使 ASCII pattern 在 GBK 文件里也能命中。
        let root = build_fixture();
        let gbk = root.join("legacy/old.java");
        fs::create_dir_all(gbk.parent().unwrap()).unwrap();
        // 含非 UTF-8 字节（0x81 0x40）串接 ASCII 串 "MATCH"，模拟 GBK 老文件。
        fs::write(
            gbk,
            [
                0x81, 0x40, b' ', b'p', b'r', b'i', b'v', b'a', b't', b'e', b' ', b'M', b'A', b'T',
                b'C', b'H', b' ', 0x82, 0x40,
            ],
        )
        .unwrap();
        let re = matcher("MATCH");
        let matches =
            walk_search_blocking(&root, None, Some(&re), &GrepOptions::default(), 1_000_000);
        assert!(
            collected_paths(&matches)
                .iter()
                .any(|p| p.ends_with("old.java")),
            "GBK 文件应被搜到（修复漏搜），结果：{:?}",
            collected_paths(&matches)
        );
    }

    #[test]
    #[ignore]
    fn bench_walk_real_project_timing() {
        let root = unique_subdir("bench_big");
        // 100 个源码文件
        for i in 0..100u32 {
            touch(&root.join(format!("src/file_{i}.rs")), "fn main() {}\n");
        }
        // 2900 个构建产物（target/），**不写 .gitignore**，模拟搜索根没恰好挡住 target
        for i in 0..2900u32 {
            touch(&root.join(format!("target/obj_{i}.o")), "binary junk\n");
        }

        // 对照 A（新，P6-1）：并行遍历 + 强制排除 target/node_modules/.git
        let t0 = std::time::Instant::now();
        let all = walk_search_blocking(&root, None, None, &GrepOptions::default(), 1_000_000);
        let d_all = t0.elapsed();

        // 对照 B（旧，P6-1 前）：串行 build()、不排除构建目录
        let t1 = std::time::Instant::now();
        let mut legacy_count = 0usize;
        for e in ignore::WalkBuilder::new(&root).build().flatten() {
            if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                legacy_count += 1;
            }
        }
        let d_legacy = t1.elapsed();

        // 内容搜索（新 P6-1）：在源码里搜 "fn "
        let re = matcher("fn ");
        let t2 = std::time::Instant::now();
        let content =
            walk_search_blocking(&root, None, Some(&re), &GrepOptions::default(), 1_000_000);
        let d_content = t2.elapsed();

        println!("BENCH synthetic project (100 src + 2900 target, no .gitignore)");
        println!(
            "  [新 P6-1]  遍历(并行+强制排除): {} files in {:.1?}",
            all.len(),
            d_all
        );
        println!(
            "  [旧 前]    串行遍历(不排除构建目录): {} files in {:.1?}",
            legacy_count, d_legacy
        );
        println!(
            "  [新 P6-1]  内容搜索 'fn ': {} matches in {:.1?}",
            content.len(),
            d_content
        );
        let speedup = d_legacy.as_secs_f64() / d_all.as_secs_f64().max(1e-6);
        println!("  => 遍历速度约提升 {:.1}x", speedup);

        // 真实对照：若本机 desktop/target 存在（真实 Rust 构建目录，几千大文件），
        // 演示「旧版不强制排除」会扫进多少、多久——新版因强制排除根本不扫。
        let real_target = std::path::Path::new(
            "C:/Users/19145/Downloads/10.0.19.194/202607071638/cc-bridge/desktop/target",
        );
        if real_target.exists() {
            let t3 = std::time::Instant::now();
            let mut real_n = 0usize;
            for e in ignore::WalkBuilder::new(real_target).build().flatten() {
                if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    real_n += 1;
                }
            }
            let d_real = t3.elapsed();
            println!(
                "  [真实 desktop/target] 旧串行扫(新版已强制排除,不扫): {} files in {:.1?}",
                real_n, d_real
            );
        }
    }

    #[test]
    fn force_excludes_build_dirs_without_gitignore() {
        // P6-1：即使根目录没有 .gitignore 挡住，target/ 与 node_modules/ 也应被强制
        // 排除，避免把构建产物整盘扫进去（审计日志里 search_files 最坏长尾的来源）。
        let root = unique_subdir("force_exclude");
        touch(
            &root.join("src/main.rs"),
            "fn search_target(){}
",
        );
        touch(
            &root.join("target/big.o"),
            "search_target should not match
",
        );
        touch(
            &root.join("node_modules/dep.js"),
            "search_target should not match
",
        );
        let re = matcher("search_target");
        let matches =
            walk_search_blocking(&root, None, Some(&re), &GrepOptions::default(), 1_000_000);
        let paths = collected_paths(&matches);
        // Windows 路径用反斜杠，断言用正斜杠比较需先归一化（与 skips_dot_git 测试一致）。
        let norm: Vec<String> = paths.iter().map(|p| p.replace('\\', "/")).collect();
        assert!(
            norm.iter().any(|p| p.ends_with("src/main.rs")),
            "应找到 src/main.rs，结果：{paths:?}"
        );
        assert!(
            !norm.iter().any(|p| p.contains("target/")),
            "target/ 应被强制排除，结果：{paths:?}"
        );
        assert!(
            !norm.iter().any(|p| p.contains("node_modules/")),
            "node_modules/ 应被强制排除，结果：{paths:?}"
        );
    }

    #[test]
    fn force_excludes_vcs_dirs_without_gitignore() {
        // P6-2：.svn/.hg/.bzr 三类 VCS 元数据目录应被强制排除（对齐 native Claude
        // Code 底层 ripgrep 的默认 VCS 名单），即使根目录没有 .gitignore 挡住。
        // 老 SVN/Hg 工程里成千上万的 .svn-base 等元数据文件不应进搜索结果。
        let root = unique_subdir("force_exclude_vcs");
        touch(&root.join("src/main.rs"), "fn vcs_marker(){}\n");
        touch(
            &root.join(".svn/text-base/main.rs.svn-base"),
            "vcs_marker should not match\n",
        );
        touch(
            &root.join(".hg/store/data.i"),
            "vcs_marker should not match\n",
        );
        touch(
            &root.join(".bzr/checkout/dirstate"),
            "vcs_marker should not match\n",
        );
        let re = matcher("vcs_marker");
        let matches =
            walk_search_blocking(&root, None, Some(&re), &GrepOptions::default(), 1_000_000);
        let paths = collected_paths(&matches);
        let norm: Vec<String> = paths.iter().map(|p| p.replace('\\', "/")).collect();
        assert!(
            norm.iter().any(|p| p.ends_with("src/main.rs")),
            "应找到 src/main.rs，结果：{paths:?}"
        );
        assert!(
            !norm.iter().any(|p| p.contains("/.svn/")),
            ".svn/ 应被强制排除，结果：{paths:?}"
        );
        assert!(
            !norm.iter().any(|p| p.contains("/.hg/")),
            ".hg/ 应被强制排除，结果：{paths:?}"
        );
        assert!(
            !norm.iter().any(|p| p.contains("/.bzr/")),
            ".bzr/ 应被强制排除，结果：{paths:?}"
        );
    }

    #[test]
    fn name_matches_sorted_by_mtime_desc_and_strip_internal_field() {
        // P6-2：name 模式结果按修改时间「倒序」（最近修改优先，对齐 native Glob），
        // 且内部排序字段 _mtime 不应泄漏到对外 JSON 结果。
        use std::thread::sleep;
        use std::time::Duration;
        let root = unique_subdir("mtime_sort");
        touch(&root.join("a.txt"), "1\n");
        sleep(Duration::from_millis(20));
        touch(&root.join("b.txt"), "2\n");
        sleep(Duration::from_millis(20));
        touch(&root.join("c.txt"), "3\n"); // 最新修改
        let glob = globset::Glob::new("*.txt").unwrap().compile_matcher();
        let matches =
            walk_search_blocking(&root, Some(&glob), None, &GrepOptions::default(), 1_000_000);
        assert_eq!(matches.len(), 3, "应找到 3 个 txt，结果：{matches:?}");
        let first = matches[0]
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap()
            .replace('\\', "/");
        assert!(
            first.ends_with("c.txt"),
            "最近修改的 c.txt 应排最前，实际：{matches:?}"
        );
        assert!(
            matches.iter().all(|m| m.get("_mtime").is_none()),
            "内部 _mtime 字段不应出现在对外结果里：{matches:?}"
        );
    }
}
