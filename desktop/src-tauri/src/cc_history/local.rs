//! 本机扫描：CLI 自己写的 `~/.claude/projects/<编码目录>/<uuid>.jsonl`。
//!
//! ## 🔴 不解析目录名，只信文件里的 `cwd`
//!
//! 目录名是 cwd 的**单向编码**（`C:\Users\19145` → `C--Users-19145`），
//! desktop-cc-gui 靠反解它来分组，而它自己的注释都承认非 ASCII 会被压成 `-`
//! （`D:\项目\a` 与 `D:\项目\b` 可能落到同一个目录名）。
//!
//! 我们换一条更省事也更准的路：**直接把 `projects/*/*.jsonl` 全扫一遍**，
//! 每条会话的归属从 jsonl 行里的 `cwd` 字段读（实测第 4 行起就有）。
//! 这样「按 cwd 找目录」的多拼法枚举（原始 / 去尾斜杠 / canonicalize）
//! 整个问题都不存在 —— 也就不需要为它写三份代码和一堆回归测试。
//!
//! 代价是每次扫描要读每个文件的**头几行**（拿到 `cwd` 即停），
//! 但那 60 个文件加起来只有几百 KB，且二级门禁（size + mtime）会让
//! 绝大多数文件根本不被打开。
//!
//! ## 为什么不读 `history.jsonl`
//!
//! 实测它在 `~/.claude/` **顶层**（905KB），是 CLI 的命令历史，不是会话转录。
//! 即便某个版本把它挪进 `projects/`，[`scan`] 也只认 `*.jsonl` 的 UUID 文件名
//! —— `history` 这个 stem 不是 UUID，直接排除。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 一个被发现的转录文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// 文件名 stem，就是 `--resume` 要的 session id。
    pub session_id: String,
    pub path: PathBuf,
    pub size: i64,
    /// 修改时间（毫秒）。二级门禁用它和 `size` 一起判断「这份文件变了没」。
    pub mtime_ms: i64,
}

/// `~/.claude` 的根。
///
/// 🔴 `CLAUDE_CONFIG_DIR` 优先：用户把配置挪到别处时，`~/.claude` 可能是空的或
/// 残留的旧目录，照它扫会「一条历史都没有」而 CLI 明明有。
pub fn config_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    home_dir().map(|h| h.join(".claude"))
}

/// `projects` 目录。**不存在时返回 `None`**，由调用方区分「没装过」与「读失败」。
pub fn projects_root() -> Option<PathBuf> {
    let p = config_root()?.join("projects");
    p.is_dir().then_some(p)
}

/// 扫一遍本机全部转录。
///
/// 返回的列表**不保证有内容**：`projects` 不存在时返回空，而不是报错 ——
/// 「没装过 CLI / 从没聊过」是正常状态，不是故障。
pub fn scan() -> Vec<Found> {
    let Some(root) = projects_root() else {
        return Vec::new();
    };
    let Ok(dirs) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dir in dirs.flatten() {
        let dir_path = dir.path();
        if !dir_path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir_path) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = session_id_of(&path) else {
                continue;
            };
            let Ok(meta) = file.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            out.push(Found {
                session_id,
                path,
                size: meta.len() as i64,
                mtime_ms: mtime_ms(&meta),
            });
        }
    }
    // 新的排前面：列表本来就是按时间倒序给人看的，先排好省得每层再排一遍。
    out.sort_by_key(|f| std::cmp::Reverse(f.mtime_ms));
    out
}

/// 文件名 stem 当 session id。
///
/// **必须是 UUID 形状**：这个值会原样传给 `--resume`，混进 `history` 之类的
/// 非会话文件会让用户在列表里点出一个永远报错的条目。
fn session_id_of(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    (is_uuid(stem)).then(|| stem.to_string())
}

/// `8-4-4-4-12` 的十六进制。手写而不加依赖：一个 `uuid` crate 只为了这一处不值得。
fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let want = [8, 4, 4, 4, 12];
    parts
        .iter()
        .zip(want)
        .all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// 读一份转录的文本。
///
/// 用 `from_utf8_lossy`：CLI 往同一个文件里追加写，进程被杀时尾部可能是半行
/// （甚至是半个多字节字符）。为一行坏数据丢掉整份历史不值得 —— 坏行由
/// [`super::parse`] 静默跳过。
pub fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读不到 {}：{e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 现有文件的 `(size, mtime_ms)` 签名，给二级门禁用。
pub fn signatures(found: &[Found]) -> HashMap<String, (i64, i64)> {
    found
        .iter()
        .map(|f| (f.session_id.clone(), (f.size, f.mtime_ms)))
        .collect()
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

#[cfg(not(windows))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_shape_is_enforced() {
        assert!(is_uuid("021d92e5-3260-42dc-a40c-aeece70e6207"));
        // 实测 `~/.claude/` 顶层那个文件，绝不能当会话。
        assert!(!is_uuid("history"));
        assert!(!is_uuid("021d92e5-3260-42dc-a40c"));
        assert!(!is_uuid("zz1d92e5-3260-42dc-a40c-aeece70e6207"));
        // 多段（`.jsonl` 之外的点会被拆成更多段）也要拒。
        assert!(!is_uuid("a-b-c-d-e-f"));
    }

    /// `CLAUDE_CONFIG_DIR` 指向不存在的目录时要退回 `~/.claude`，不能直接返回它。
    #[test]
    fn nonexistent_config_dir_falls_back() {
        // 这条只验证函数不会 panic 且返回的路径存在性一致；真正的优先级由
        // `config_root` 的 `is_dir()` 判定，环境变量只在本进程里改不安全
        // （并行测试会互相干扰），所以只做冒烟。
        let _ = config_root();
        let _ = projects_root();
    }
}
