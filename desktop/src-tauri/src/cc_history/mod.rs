//! 历史对话：把 CLI 自己写的 jsonl 读回来，让用户能看见并接着聊。
//!
//! ## 分工
//!
//! ```text
//! local.rs   扫 / 读本机 ~/.claude/projects（不解析目录名，只信文件里的 cwd）
//! parse.rs   jsonl → CcEvent（白名单 + 行号做 block_id）
//! index.rs   索引表 cc_history（两级门禁、远端正文缓存、列表）
//! remote.rs  远端扫描与读取（走常驻 helper，零握手）
//! ```
//!
//! ## 和期一（`cc_session::store`）的关系
//!
//! | | 期一 `cc_sessions` | 这里 `cc_history` |
//! |---|---|---|
//! | 存什么 | **我们自己**产生的 CcEvent 快照 | CLI 转录的**索引**（+ 远端正文缓存） |
//! | 谁写的 | 我们（每轮落盘） | CLI（自己追加），我们只读 |
//! | 覆盖谁 | 只在对话页里聊过的 | **全部**，包括终端页手敲 claude 产生的 |
//!
//! 两者不重复也不冲突：期一让「关掉不丢」，这里让「翻得到旧账」。
//! 同一条会话可能两边都有 —— 界面上按 `last_used_at` 取新的那个来源即可。
//!
//! ## 🔴 绝不写回 `~/.claude/*`
//!
//! 那是 CLI 的原始记录。重命名、置顶、归档全部只存在我们自己的索引里
//! （期三），删远端会话也只删本机缓存。理由不只是「别动别人的文件」：
//! CLI 用 `parentUuid` 串起整棵树，我们插一行进去它下次 `--resume` 可能直接读坏。

pub mod index;
pub mod local;
pub mod parse;

use std::path::PathBuf;

use rusqlite::Connection;

use crate::cc_session::proto::CcEvent;

/// 打开一条历史时最多回放多少事件。
///
/// 本机最大的一份转录是 1MB / 上万条事件，全量回放会让 React 一次渲染上万节点
/// 直接卡住。1MB 事件大概对应几小时的对话，对「接着聊」完全够用 ——
/// 更早的内容从头部丢掉并如实报告 `dropped`。
pub const OPEN_MAX_BYTES: usize = 1_000_000;

/// 一次扫描的结果。
#[derive(Debug, Clone)]
pub struct ScanOutcome {
    pub rows: Vec<index::Row>,
    /// 解析失败的文件数。坏文件不阻塞其余，但要能告诉用户「有几条没读进来」。
    pub failed: usize,
    /// `~/.claude/projects` 在不在。不在时列表为空是**正常**的（没装过 / 没聊过），
    /// 界面要显示引导而不是「读取失败」。
    pub dir_found: bool,
}

/// 打开一条历史拿到的内容。
#[derive(Debug, Clone)]
pub struct Opened {
    pub meta: parse::Meta,
    pub events: Vec<CcEvent>,
    /// 因为体积上限被丢掉的头部事件数。`> 0` 时界面必须提示「更早的未加载」。
    pub dropped: u64,
}

/// 扫一遍本机，更新索引，返回列表。
///
/// ## 两级门禁
///
/// 第一级是 `(size, mtime_ms)` 签名 —— 没变就**根本不打开文件**。
/// 实测 62 个文件 / 24MB，首次全解析约 200ms；之后只要没有新会话，
/// 每次进对话页都是纯查库。
pub fn scan_local(conn: &Connection) -> Result<ScanOutcome, String> {
    let found = local::scan();
    let dir_found = local::projects_root().is_some();
    let sigs = index::signatures(conn, "");
    let mut failed = 0usize;

    for f in &found {
        // 第一级门禁：签名没变就跳过（不打开文件）。
        if sigs.get(&f.session_id) == Some(&(f.size, f.mtime_ms)) {
            continue;
        }
        let text = match local::read_text(&f.path) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("读历史转录失败：{e}");
                failed += 1;
                continue;
            }
        };
        // 列表只要元信息，不建事件数组 —— 24MB 全建出来纯属浪费。
        let (meta, _) = parse::Parser::parse_text(&text, &f.session_id, false);
        // 先算标题：`meta.title()` 借 `meta`，而下面的结构体表达式会把它的字段移走。
        let title = meta.title();
        index::upsert(
            conn,
            &index::Row {
                connection_id: String::new(),
                session_id: f.session_id.clone(),
                path: f.path.to_string_lossy().into_owned(),
                cwd: meta.cwd,
                git_branch: meta.git_branch,
                title,
                preview: meta.preview,
                message_count: meta.user_count,
                file_size: f.size,
                file_mtime_ms: f.mtime_ms,
                last_used_at: f.mtime_ms / 1000,
                cached: false,
            },
        )?;
    }

    // 🔴 空扫描不做清理。`projects` 不存在、或 `CLAUDE_CONFIG_DIR` 临时指向别处时，
    // `found` 是空的 —— 这时候把本机条目全删，等于用户配错了环境变量就丢光历史。
    if !found.is_empty() {
        let keep: Vec<String> = found.iter().map(|f| f.session_id.clone()).collect();
        index::prune_missing(conn, "", &keep)?;
    }

    Ok(ScanOutcome {
        rows: index::list(conn, "")?,
        failed,
        dir_found,
    })
}

/// 读一条本机历史的正文。
///
/// ## 路径失效的两条兜底
///
/// 索引里存的是**上次扫描时**的绝对路径。它会失效：
/// - 用户改了 `cwd`（CLI 按 cwd 编码出新的目录名，旧文件被搬走）；
/// - `CLAUDE_CONFIG_DIR` 换了；
/// - 文件被 CLI 自己归档（`~/.claude/projects` 之外）。
///
/// 所以先试索引路径，不行就按 `session_id` 在扫描结果里重新找一遍 ——
/// 文件名就是 session id，这是**唯一稳定**的定位依据。
pub fn open_local(conn: &Connection, session_id: &str) -> Result<Opened, String> {
    let row = index::get(conn, "", session_id)?
        .ok_or_else(|| "这条历史不在索引里，请刷新列表后重试".to_string())?;
    let path = resolve_path(&row.path, session_id)
        .ok_or_else(|| format!("找不到这条会话的转录文件（`{session_id}`）。它可能已被删除。"))?;
    let text = local::read_text(&path)?;
    Ok(build(&text, session_id, &row))
}

/// 解析一段转录文本并套上体积上限。
fn build(text: &str, session_id: &str, row: &index::Row) -> Opened {
    let (mut meta, events) = parse::Parser::parse_text(text, session_id, true);
    let (events, dropped) = crate::cc_session::store::trim_events(&events, OPEN_MAX_BYTES);
    // `row` 里的 cwd 是上一次扫描的结果；这次解析出来的更新（用户重命名过项目等），
    // 以本次为准。先算好再改，否则 `..meta` 会和已借用的字段打架。
    if meta.cwd.is_none() {
        meta.cwd = row.cwd.clone();
    }
    Opened {
        meta,
        events,
        dropped,
    }
}

/// 定位转录文件：先试索引里的路径，再按 session id 重扫。
fn resolve_path(indexed: &str, session_id: &str) -> Option<PathBuf> {
    let p = PathBuf::from(indexed);
    if p.is_file() {
        return Some(p);
    }
    local::scan()
        .into_iter()
        .find(|f| f.session_id == session_id)
        .map(|f| f.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("内存库");
        index::ensure_table(&c).expect("建表");
        c
    }

    fn row(sid: &str) -> index::Row {
        index::Row {
            connection_id: String::new(),
            session_id: sid.into(),
            path: format!("/nonexistent/{sid}.jsonl"),
            cwd: Some("/indexed-cwd".into()),
            git_branch: None,
            title: "索引里的标题".into(),
            preview: None,
            message_count: 1,
            file_size: 1,
            file_mtime_ms: 1000,
            last_used_at: 1,
            cached: false,
        }
    }

    /// 打开时必须用**本次解析**的 cwd，而不是索引里的旧值：
    /// 用户把项目搬了目录之后，旧 cwd 会让续聊在错误的地方启动。
    #[test]
    fn freshly_parsed_cwd_wins_over_indexed_one() {
        let text = r#"{"type":"user","message":{"content":"hi"},"cwd":"/fresh-cwd"}"#;
        let opened = build(text, "s1", &row("s1"));
        assert_eq!(opened.meta.cwd.as_deref(), Some("/fresh-cwd"));
    }

    /// 本次解析读不到 cwd 时（老版本转录可能没有这个字段）才退回索引值。
    #[test]
    fn indexed_cwd_is_the_fallback() {
        let text = r#"{"type":"user","message":{"content":"hi"}}"#;
        let opened = build(text, "s1", &row("s1"));
        assert_eq!(opened.meta.cwd.as_deref(), Some("/indexed-cwd"));
    }

    /// 超出体积上限要从头部丢，并且如实报数 —— 否则界面会以为这就是全部。
    #[test]
    fn oversized_history_reports_dropped() {
        let big = "x".repeat(4000);
        let mut lines = Vec::new();
        for i in 0..400 {
            lines.push(format!(
                r#"{{"type":"user","message":{{"content":"第{i}轮 {big}"}}}}"#
            ));
        }
        let opened = build(&lines.join("\n"), "s", &row("s"));
        assert!(opened.dropped > 0, "1.6MB 必须被裁到 1MB 以内");
        assert!(opened.events.len() < 400);
        // 保留的必须是**后面**的内容：最新的那轮一定要在。
        match opened.events.last() {
            Some(CcEvent::UserMessage { text }) => assert!(text.starts_with("第399轮")),
            other => panic!("末尾应当是最后一轮，实际 {other:?}"),
        }
    }

    /// 🔴 真机端到端：扫描 → 落索引 → 列表 → 打开。
    ///
    /// 合成样本管不住的部分：
    /// - 二级门禁真的能命中吗（第二次扫描必须比第一次明显快，否则等于每次进对话页
    ///   都在重解析 24MB）；
    /// - `prune_missing` 会不会把好好的条目删掉（它是按「这次扫描看到的」做差集，
    ///   一旦算错就是「历史列表空了一半」）；
    /// - 打开真实会话能不能产出事件（解析层通过不代表 `open_local` 的路径解析也通过）。
    #[test]
    #[ignore = "需要本机 ~/.claude/projects"]
    fn real_scan_and_open_roundtrip() {
        let c = conn();
        let first_start = std::time::Instant::now();
        let out = scan_local(&c).expect("扫描不该失败");
        let first = first_start.elapsed();
        println!(
            "首次扫描 {} 条 / 失败 {} / 目录 {} / 耗时 {:?}",
            out.rows.len(),
            out.failed,
            out.dir_found,
            first
        );
        for r in out.rows.iter().take(5) {
            println!(
                "  {} 轮 · {} · {}",
                r.message_count,
                r.title,
                r.cwd.as_deref().unwrap_or("（没有 cwd）")
            );
        }
        if out.rows.is_empty() {
            println!("本机没有历史，跳过后续断言");
            return;
        }

        // 第二次扫描必须走门禁（不打开文件）。给 300ms 余量：查库 + read_dir 的
        // 真实成本远低于这个数，而重解析 24MB 会明显超过它。
        let again_start = std::time::Instant::now();
        let again = scan_local(&c).expect("再扫不该失败");
        let again_took = again_start.elapsed();
        println!("二次扫描耗时 {:?}", again_took);
        assert_eq!(again.rows.len(), out.rows.len(), "两次扫描结果必须一致");
        assert!(
            again_took.as_millis() < 300,
            "二级门禁没命中：二次扫描用了 {again_took:?}，等于每次都在重解析"
        );

        let top = &out.rows[0];
        let opened = open_local(&c, &top.session_id).expect("打开最新一条");
        println!(
            "打开「{}」→ {} 事件 / 裁剪 {}",
            opened.meta.title(),
            opened.events.len(),
            opened.dropped
        );
        assert!(!opened.events.is_empty(), "真实会话必须有内容");
        assert!(!opened.meta.title().trim().is_empty(), "标题不能是空串");
    }

    /// 小会话一条都不能丢。
    #[test]
    fn small_history_keeps_everything() {
        let text = r#"{"type":"user","message":{"content":"一"}}
{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"二"}]}}"#;
        let opened = build(text, "s", &row("s"));
        assert_eq!(opened.dropped, 0);
        assert_eq!(opened.events.len(), 2);
    }

    /// 索引路径失效时按 session id 重扫 —— 这是路径唯一的稳定替代品。
    #[test]
    fn missing_indexed_path_falls_back_to_scan() {
        // 本机有没有装 CLI 都能跑：文件不存在时必须返回 None 而不是 panic。
        assert!(resolve_path("/definitely/not/here/x.jsonl", "no-such-session").is_none());
    }

    /// 不在索引里的 session 要给一句人话，而不是内部错误。
    #[test]
    fn opening_unknown_session_is_a_readable_error() {
        let err = open_local(&conn(), "nope").expect_err("必须报错");
        assert!(err.contains("刷新列表"), "{err}");
    }

    /// 空库扫描不能报错（首次启动就是这个状态）。
    #[test]
    fn scan_on_clean_install_is_ok() {
        let out = scan_local(&conn()).expect("扫描不该失败");
        // 本机可能真装了 CLI，所以只断言不 panic、结构完整。
        assert!(out.failed <= out.rows.len() + 100);
    }

    /// 🔴 真机冒烟：拿本机**全部**真实转录跑一遍解析。
    ///
    /// 合成样本证明不了的事，这里才管得住：
    /// - 真实文件里有几十种我们没见过的行类型，不能有任何一种把解析掀翻；
    /// - `block_id` 必须**全局唯一** —— 撞一个就等于界面上两段内容互相覆盖
    ///   （`id:0` 撞车那次真机 bug 的同源故障，只是换了个入口）；
    /// - 标题不能是空串，否则列表里是一排点不动的空白行。
    ///
    /// 需要本机有 `~/.claude/projects`，所以默认 `#[ignore]`，手动跑：
    /// `cargo test --lib --no-default-features cc_history -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机 ~/.claude/projects"]
    fn real_transcripts_parse_into_readable_sessions() {
        let found = local::scan();
        if found.is_empty() {
            println!("本机没有转录，跳过");
            return;
        }
        let mut no_event = Vec::new();
        let mut dup_block: Vec<String> = Vec::new();
        let mut sample: Vec<(String, usize, i64)> = Vec::new();
        for f in &found {
            let Ok(text) = local::read_text(&f.path) else {
                continue;
            };
            let (meta, events) = parse::Parser::parse_text(&text, &f.session_id, true);
            assert!(
                !meta.title().trim().is_empty(),
                "{} 的标题是空的",
                f.session_id
            );
            if events.is_empty() {
                no_event.push(f.session_id.clone());
            }
            let mut seen = std::collections::HashSet::new();
            for e in &events {
                let id = match e {
                    CcEvent::Text { block_id, .. } | CcEvent::Thinking { block_id, .. } => {
                        block_id.as_str()
                    }
                    _ => continue,
                };
                if !seen.insert(id) {
                    dup_block.push(format!("{} → {id}", f.session_id));
                }
            }
            if sample.len() < 8 {
                sample.push((meta.title(), events.len(), meta.user_count));
            }
        }
        println!(
            "转录 {} 份；零事件 {} 份；block_id 撞车 {} 处",
            found.len(),
            no_event.len(),
            dup_block.len()
        );
        for (title, n, u) in &sample {
            println!("  {n:>5} 事件 / {u:>3} 轮 · {title}");
        }
        assert!(dup_block.is_empty(), "block_id 撞车：{dup_block:?}");
        assert!(
            no_event.len() < found.len(),
            "全部转录都解析成了零事件 —— 白名单判据错了"
        );
    }
}
