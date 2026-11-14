//! 变更日志（开放能力）：cc-bridge 每改动一个文件，就在 `<数据目录>/journal/changes-YYYYMMDD.jsonl`
//! 追加一条记录。对外契约见 `docs/开放能力-变更日志.md`，设计见 `proposals/change_journal_rfc.md`。
//!
//! 为什么不让别人读 audit.log：那是内部日志（一次调用一条、改了哪些文件藏在参数全文里、
//! 会被原地重写变短、字段无版本），没法当对外契约。这里是**按文件、只追加、带版本号**的一份。
//!
//! 接入方式（尽量不动各工具的主流程）：
//! - `http.rs::dispatch_tool` 用 [`with_call`] 包住写类工具：建一次调用的上下文（调用 id、变更集名、原因），
//!   工具返回后统一收尾写盘。batch 子操作同样走 `dispatch_tool`，自动继承外层的变更集。
//! - 各写工具在**真正写盘之前**调一次 [`note`] 登记（顺带记下改前的大小与哈希）；
//!   备份路径由 `audit::record_op_backup` 顺手转给 [`attach_backup`]。
//! - 不在调用上下文里（界面上的还原、单元测试直调）时 `note` 是空操作，不影响写入。
//!
//! 只记录**确实改变了文件**的操作：写入失败或内容原样不变的不记（改前改后一致）。
//! 日志只记元信息与哈希，不记文件内容——内容在备份里。

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// 记录格式版本。只加字段不升版；改语义才升。
pub const FORMAT_VERSION: u32 = 1;

/// 会被记入变更日志的工具，也是 `tools/list` 里注入 `changeSet` / `reason` 参数的工具。
///
/// 🔴 不含 `run_command` / `mcp_proxy`：它们改了什么只能按时间窗猜，低可信度的归因会误导使用方
/// （RFC 决策 5）。`prepare_upload` 的实际写入发生在之后的 HTTP 上传里，不在调用上下文中，首期不记。
pub const JOURNAL_TOOLS: &[&str] = &[
    "write_files",
    "edit_files",
    "move_files",
    "copy_files",
    "delete_files",
    "remove_directory",
    "notebook_edit",
    "create_directory",
    "batch",
];

/// 超过这个大小的文件只记大小不算哈希，免得一次写入多读两遍大文件。
const HASH_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
/// `reason` 的长度上限（字符），超长截断。
const REASON_MAX_CHARS: usize = 200;
/// 变更集名的长度上限（字符），超长截断。
const NAME_MAX_CHARS: usize = 200;
/// `change_sets` 默认最多列几条。
pub const DEFAULT_LIST_LIMIT: usize = 20;

/// 改动类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Create,
    Write,
    Edit,
    Delete,
    Move,
    Copy,
    Mkdir,
    Rmdir,
}

/// 文件某一时刻的大小与哈希。哈希缺失 = 文件太大或读取失败。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub size: u64,
    pub sha256: Option<String>,
}

/// 路径在某一时刻的状态。
#[derive(Clone, Debug, PartialEq, Eq)]
enum PathState {
    Absent,
    File(Snapshot),
    Dir,
}

impl PathState {
    fn of(path: &Path) -> Self {
        match fs::metadata(path) {
            Ok(m) if m.is_dir() => PathState::Dir,
            Ok(m) => {
                let size = m.len();
                let sha256 = if size <= HASH_LIMIT_BYTES {
                    fs::read(path).ok().map(|b| hex(&Sha256::digest(&b)))
                } else {
                    None
                };
                PathState::File(Snapshot { size, sha256 })
            }
            Err(_) => PathState::Absent,
        }
    }

    fn snapshot(&self) -> Option<Snapshot> {
        match self {
            PathState::File(s) => Some(s.clone()),
            _ => None,
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 一次登记：写盘前记下、收尾时补上改后状态。
struct Note {
    op: Op,
    path: PathBuf,
    from: Option<PathBuf>,
    backup: Option<PathBuf>,
    before: PathState,
    /// 同一次调用里同一路径又被登记时，由下一次登记定格为那一刻的状态；否则收尾时现取。
    after: Option<PathState>,
}

/// 一次工具调用的上下文。batch 子操作继承外层的 id / 客户端 / 来源 / 变更集 / 原因。
struct CallCtx {
    id: String,
    tool: String,
    client: Option<String>,
    source: Option<String>,
    change_set: Option<String>,
    reason: Option<String>,
    notes: RefCell<Vec<Note>>,
    /// 要回显给模型的话。外层与子操作共用一份，只在最外层追加到结果里。
    echoes: Arc<Mutex<Vec<String>>>,
}

tokio::task_local! {
    static CALL: CallCtx;
    static CLIENT: &'static str;
}

/// 把 `ClientKind` 映射成日志里的客户端名。
pub fn client_label(kind: crate::mcp::client_kind::ClientKind) -> &'static str {
    use crate::mcp::client_kind::ClientKind;
    match kind {
        ClientKind::ClaudeCode => "claude-code",
        ClientKind::Codex => "codex",
        ClientKind::WorkBuddy => "workbuddy",
        ClientKind::Generic => "generic",
    }
}

/// 进入「这次请求来自哪个客户端」的作用域（由传输层在 tools/call 入口设置）。
pub async fn with_client<F: std::future::Future>(client: &'static str, fut: F) -> F::Output {
    CLIENT.scope(client, fut).await
}

/// 变更集名清洗：去首尾空白；`/ \ : * ? " < > |` 换成 `_`（保证能直接当文件名用）；空名 = 未声明。
///
/// 与 NCForge 补丁名的清洗规则一致，所以「变更集名 = 补丁名去掉日期」能逐字对上。
/// 大小写敏感、不做其他改写：命名格式由项目规则约定，桥不校验。
pub fn normalize_change_set(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .take(NAME_MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// 原因清洗：去首尾空白、换行压成空格、超长截断；空 = 未给。
pub fn normalize_reason(raw: &str) -> Option<String> {
    let one_line: String = raw
        .trim()
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .take(REASON_MAX_CHARS)
        .collect();
    let one_line = one_line.trim().to_string();
    (!one_line.is_empty()).then_some(one_line)
}

fn new_call_id() -> String {
    let u = uuid::Uuid::new_v4().simple().to_string();
    format!("c-{}", &u[..12])
}

/// 写工具在真正写盘之前调用：登记这次要改的路径，并记下改前状态。
///
/// 不在调用上下文里时为空操作。`from` 只有 move / copy 有。
pub fn note(op: Op, path: &Path, from: Option<&Path>) {
    let _ = CALL.try_with(|c| {
        let before = PathState::of(path);
        let mut notes = c.notes.borrow_mut();
        // 同一路径在同一次调用里再次登记：上一条的「改后」就是这一刻的状态。
        if let Some(prev) = notes
            .iter_mut()
            .rev()
            .find(|n| n.path == path && n.after.is_none())
        {
            prev.after = Some(before.clone());
        }
        notes.push(Note {
            op,
            path: path.to_path_buf(),
            from: from.map(Path::to_path_buf),
            backup: None,
            before,
            after: None,
        });
    });
}

/// 把本次生成的备份挂到最近一次登记该路径的记录上。由 `audit::record_op_backup` 调用。
pub fn attach_backup(path: &Path, backup: Option<&Path>) {
    let _ = CALL.try_with(|c| {
        if let Some(n) = c
            .notes
            .borrow_mut()
            .iter_mut()
            .rev()
            .find(|n| n.path == path)
        {
            n.backup = backup.map(Path::to_path_buf);
        }
    });
}

/// 包住一次工具调用：只对 [`JOURNAL_TOOLS`] 生效，变更日志关闭时原样执行。
///
/// 工具返回后把登记过的路径逐条收尾写盘；最外层调用再把「新变更集」之类的回显追加到结果末尾。
pub async fn with_call<F>(
    state: &Arc<AppState>,
    tool: &str,
    args: &Value,
    fut: F,
) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>>,
{
    if !JOURNAL_TOOLS.contains(&tool) {
        return fut.await;
    }
    let (enabled, retention) = {
        let c = state.config.read().await;
        (c.journal_enabled, c.journal_retention_days)
    };
    if !enabled {
        return fut.await;
    }
    let own_cs = args
        .get("changeSet")
        .and_then(Value::as_str)
        .and_then(normalize_change_set);
    let own_reason = args
        .get("reason")
        .and_then(Value::as_str)
        .and_then(normalize_reason);
    let parent = CALL
        .try_with(|p| {
            (
                p.id.clone(),
                p.client.clone(),
                p.source.clone(),
                p.change_set.clone(),
                p.reason.clone(),
                p.echoes.clone(),
            )
        })
        .ok();
    let is_root = parent.is_none();
    let ctx = match parent {
        Some((id, client, source, cs, reason, echoes)) => CallCtx {
            id,
            tool: tool.to_string(),
            client,
            source,
            change_set: own_cs.or(cs),
            reason: own_reason.or(reason),
            notes: RefCell::new(Vec::new()),
            echoes,
        },
        None => CallCtx {
            id: new_call_id(),
            tool: tool.to_string(),
            client: CLIENT.try_with(|c| c.to_string()).ok(),
            source: crate::audit::current_source_ip(),
            change_set: own_cs,
            reason: own_reason,
            notes: RefCell::new(Vec::new()),
            echoes: Arc::new(Mutex::new(Vec::new())),
        },
    };
    let data_dir = state.data_dir.clone();
    let (result, echoes) = CALL
        .scope(ctx, async move {
            let r = fut.await;
            finalize(&data_dir, retention);
            let echoes = if is_root {
                CALL.with(|c| {
                    std::mem::take(&mut *c.echoes.lock().unwrap_or_else(|e| e.into_inner()))
                })
            } else {
                Vec::new()
            };
            (r, echoes)
        })
        .await;
    match result {
        Ok(v) if !echoes.is_empty() => Ok(append_echoes(v, &echoes)),
        other => other,
    }
}

/// 把回显作为一个独立的 text 块接在结果末尾；结果不是标准 content 数组时原样返回。
fn append_echoes(mut v: Value, echoes: &[String]) -> Value {
    if let Some(blocks) = v.get_mut("content").and_then(Value::as_array_mut) {
        blocks.push(json!({ "type": "text", "text": format!("[变更集] {}", echoes.join("；")) }));
    }
    v
}

#[derive(Serialize)]
struct CallInfo<'a> {
    id: &'a str,
    tool: &'a str,
    client: Option<&'a str>,
    source: Option<&'a str>,
}

#[derive(Serialize)]
struct Entry<'a> {
    v: u32,
    seq: u64,
    at: String,
    op: Op,
    path: String,
    from: Option<String>,
    backup: Option<String>,
    before: Option<Snapshot>,
    after: Option<Snapshot>,
    call: CallInfo<'a>,
    #[serde(rename = "changeSet")]
    change_set: Option<&'a str>,
    reason: Option<&'a str>,
}

/// 路径对外展示形态：去掉 Windows 的 `\\?\` 长路径前缀。
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// 这条登记是否确实改变了文件系统（没变的不记）。
///
/// `from_gone`：移动的源路径此刻已不存在。移动到同内容的目标也算改动（源没了）；
/// 但移动失败、目标原本就在时不能误记，所以要「目标变了」或「源确实没了」。
fn changed(op: Op, before: &PathState, after: &PathState, from_gone: bool) -> bool {
    match op {
        Op::Mkdir => *before != PathState::Dir && *after == PathState::Dir,
        Op::Rmdir => *before == PathState::Dir && *after == PathState::Absent,
        Op::Move => *after != PathState::Absent && (before != after || from_gone),
        _ => before != after,
    }
}

/// 收尾：把本次调用登记的路径逐条写盘，必要时产生回显。
fn finalize(data_dir: &Path, retention_days: u32) {
    let _ = CALL.try_with(|c| {
        let notes = std::mem::take(&mut *c.notes.borrow_mut());
        if notes.is_empty() {
            return;
        }
        let at = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
        let mut entries = Vec::new();
        for n in &notes {
            let after = n.after.clone().unwrap_or_else(|| PathState::of(&n.path));
            let from_gone = n.from.as_deref().is_some_and(|f| !f.exists());
            if !changed(n.op, &n.before, &after, from_gone) {
                continue;
            }
            entries.push(Entry {
                v: FORMAT_VERSION,
                seq: 0,
                at: at.clone(),
                op: n.op,
                path: display_path(&n.path),
                from: n.from.as_deref().map(display_path),
                backup: n.backup.as_deref().map(display_path),
                before: n.before.snapshot(),
                after: after.snapshot(),
                call: CallInfo {
                    id: &c.id,
                    tool: &c.tool,
                    client: c.client.as_deref(),
                    source: c.source.as_deref(),
                },
                change_set: c.change_set.as_deref(),
                reason: c.reason.as_deref(),
            });
        }
        if entries.is_empty() {
            return;
        }
        // 先判断是不是新名字再写盘：首次加载已知名字时扫到的就不会包含本批。
        let echo = c
            .change_set
            .as_deref()
            .and_then(|name| register_name(data_dir, name));
        if let Err(e) = append_entries(data_dir, retention_days, &mut entries) {
            log::error!("变更日志写入失败：{e}");
            return;
        }
        if let Some(echo) = echo {
            let mut echoes = c.echoes.lock().unwrap_or_else(|e| e.into_inner());
            if !echoes.contains(&echo) {
                echoes.push(echo);
            }
        }
    });
}

// ── 落盘 ──

struct Writer {
    day: String,
    file: Option<File>,
    next_seq: u64,
}

/// 按数据目录分开的写句柄（生产只有一个；单元测试各用各的临时目录）。
/// 同一个锁里分配 `seq` 并追加，保证并发调用下序号不重、文件里按序号递增。
static WRITERS: OnceLock<Mutex<HashMap<PathBuf, Writer>>> = OnceLock::new();

pub fn journal_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("journal")
}

fn day_file(dir: &Path, day: &str) -> PathBuf {
    dir.join(format!("changes-{day}.jsonl"))
}

/// 保留期内的日志文件，按日期升序。
fn journal_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let day = name
                .strip_prefix("changes-")?
                .strip_suffix(".jsonl")?
                .to_string();
            (day.len() == 8 && day.chars().all(|c| c.is_ascii_digit())).then(|| (day, e.path()))
        })
        .collect();
    out.sort();
    out
}

/// 从最近的日志文件里找出最大的 seq，续着编号。
fn last_seq(dir: &Path) -> u64 {
    for (_, path) in journal_files(dir).iter().rev() {
        let Ok(f) = File::open(path) else { continue };
        let max = BufReader::new(f)
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
            .filter_map(|v| v.get("seq").and_then(Value::as_u64))
            .max();
        if let Some(m) = max {
            return m;
        }
    }
    0
}

/// 启动与每天定时调用：不管变更日志开没开都清一次超期文件。
/// 否则关闭后不再有写入，旧日志就永远不会被删。
pub fn cleanup_expired(data_dir: &Path, retention_days: u32) {
    cleanup(&journal_dir(data_dir), retention_days);
}

/// 删掉超过保留天数的整份日志文件（不原地改写，跟读方的偏移不会失效）。
fn cleanup(dir: &Path, retention_days: u32) {
    let keep_from = (chrono::Local::now()
        - chrono::Duration::days(i64::from(retention_days.max(1)) - 1))
    .format("%Y%m%d")
    .to_string();
    for (day, path) in journal_files(dir) {
        if day < keep_from {
            let _ = fs::remove_file(path);
        }
    }
}

fn append_entries(
    data_dir: &Path,
    retention_days: u32,
    entries: &mut [Entry<'_>],
) -> std::io::Result<()> {
    let dir = journal_dir(data_dir);
    let mut map = WRITERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    let w = map.entry(dir.clone()).or_insert_with(|| Writer {
        day: String::new(),
        file: None,
        next_seq: 0,
    });
    if w.file.is_none() || w.day != today {
        fs::create_dir_all(&dir)?;
        if w.next_seq == 0 {
            w.next_seq = last_seq(&dir) + 1;
        }
        cleanup(&dir, retention_days);
        w.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(day_file(&dir, &today))?,
        );
        w.day = today;
    }
    let mut buf = String::new();
    for e in entries.iter_mut() {
        e.seq = w.next_seq;
        w.next_seq += 1;
        buf.push_str(&serde_json::to_string(e).map_err(std::io::Error::other)?);
        buf.push('\n');
    }
    let file = w.file.as_mut().expect("上面已打开");
    // 一次调用的多条记录一次写入，减少与跟读方交错时读到半批的窗口。
    let r = file.write_all(buf.as_bytes()).and_then(|_| file.flush());
    if r.is_err() {
        // 句柄可能已失效（目录被删等），下次重新打开。
        w.file = None;
    }
    r
}

// ── 变更集统计与回显 ──

/// 保留期内一个变更集的概况。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSetSummary {
    pub name: String,
    pub files: usize,
    pub last_at: String,
}

/// 扫描保留期内的日志，按变更集汇总；`path_prefix` 不区分大小写、不区分 `/` 与 `\`。
/// 结果按最后改动时间倒序。
pub fn scan_change_sets(data_dir: &Path, path_prefix: Option<&str>) -> Vec<ChangeSetSummary> {
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let prefix = path_prefix.map(norm).filter(|p| !p.is_empty());
    let mut agg: HashMap<String, (HashSet<String>, String)> = HashMap::new();
    for (_, path) in journal_files(&journal_dir(data_dir)) {
        let Ok(f) = File::open(&path) else { continue };
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(name) = v.get("changeSet").and_then(Value::as_str) else {
                continue;
            };
            let p = v.get("path").and_then(Value::as_str).unwrap_or_default();
            if let Some(pre) = &prefix {
                if !norm(p).starts_with(pre.as_str()) {
                    continue;
                }
            }
            let at = v.get("at").and_then(Value::as_str).unwrap_or_default();
            let slot = agg.entry(name.to_string()).or_default();
            slot.0.insert(norm(p));
            if at > slot.1.as_str() {
                slot.1 = at.to_string();
            }
        }
    }
    let mut out: Vec<ChangeSetSummary> = agg
        .into_iter()
        .map(|(name, (files, last_at))| ChangeSetSummary {
            name,
            files: files.len(),
            last_at,
        })
        .collect();
    out.sort_by(|a, b| b.last_at.cmp(&a.last_at).then_with(|| a.name.cmp(&b.name)));
    out
}

/// 保留期内出现过的变更集名（按数据目录分开）。用于判断「新变更集」与「疑似敲错」。
static KNOWN: OnceLock<Mutex<HashMap<PathBuf, HashSet<String>>>> = OnceLock::new();

/// 登记一个变更集名：第一次出现时返回回显（含疑似敲错提示），已知的返回 None。
///
/// 回显只在这两种情况出现，沿用已有名字不回显——省 token（RFC 2.5）。
/// 必须在本批写盘**之前**调用：首次加载时从磁盘扫到的就是「之前已有」的名字。
fn register_name(data_dir: &Path, name: &str) -> Option<String> {
    let mut map = KNOWN
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let known = map.entry(journal_dir(data_dir)).or_insert_with(|| {
        scan_change_sets(data_dir, None)
            .into_iter()
            .map(|s| s.name)
            .collect()
    });
    if known.contains(name) {
        return None;
    }
    let similar = known
        .iter()
        .filter_map(|k| similarity(name, k).map(|d| (d, k)))
        .min()
        .map(|(_, k)| k.clone());
    known.insert(name.to_string());
    Some(match similar {
        Some(s) => format!("新变更集「{name}」，是不是「{s}」？是的话之后请沿用原名"),
        None => format!("新变更集「{name}」"),
    })
}

/// 两个名字是否「只差一点」：是则返回距离（越小越像），不像返回 None。
///
/// 忽略大小写与 `_` `-` 空格后相同、一个包含另一个（如后补了清单号前缀）、
/// 或编辑距离很小（不超过较短名字长度的 1/8，最少 1、最多 3）。
fn similarity(a: &str, b: &str) -> Option<usize> {
    let squash = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|c| !matches!(c, '_' | '-' | ' '))
            .flat_map(char::to_lowercase)
            .collect()
    };
    let (x, y) = (squash(a), squash(b));
    if x.is_empty() || y.is_empty() {
        return None;
    }
    if x == y {
        return Some(0);
    }
    let (short, long) = if x.len() <= y.len() {
        (&x, &y)
    } else {
        (&y, &x)
    };
    if short.len() >= 4 && long.windows(short.len()).any(|w| w == short.as_slice()) {
        return Some(1);
    }
    let limit = (short.len() / 8).clamp(1, 3);
    let d = levenshtein(&x, &y);
    (d <= limit).then_some(d)
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::make_state;

    fn read_entries(data_dir: &Path) -> Vec<Value> {
        journal_files(&journal_dir(data_dir))
            .into_iter()
            .flat_map(|(_, p)| {
                fs::read_to_string(p)
                    .unwrap()
                    .lines()
                    .map(|l| serde_json::from_str::<Value>(l).unwrap())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn 名字按补丁名规则清洗() {
        assert_eq!(
            normalize_change_set("  a/b:c*d  ").as_deref(),
            Some("a_b_c_d")
        );
        assert_eq!(normalize_change_set("   "), None);
        assert_eq!(
            normalize_change_set("7691_平台耗材采购退库").as_deref(),
            Some("7691_平台耗材采购退库"),
            "中文与下划线原样保留"
        );
        assert_eq!(normalize_reason(" 一\n二 ").as_deref(), Some("一 二"));
        assert_eq!(
            normalize_reason(&"字".repeat(300)).unwrap().chars().count(),
            REASON_MAX_CHARS
        );
    }

    #[test]
    fn 疑似敲错的判定() {
        assert_eq!(
            similarity("退库申请锁HIS库存", "退库申请锁his库存"),
            Some(0)
        );
        assert!(
            similarity("7691_平台耗材退库", "平台耗材退库").is_some(),
            "后补清单号前缀"
        );
        assert!(similarity("平台耗材采购退库原仓库无货", "平台耗材采购退库原仓无货").is_some());
        assert_eq!(similarity("退库申请锁HIS库存", "销售出库推门户"), None);
    }

    #[tokio::test]
    async fn 写入记录一条且改后哈希对得上() {
        let (state, dir) = make_state(|c| c.journal_enabled = true);
        let f = dir.join("a.txt");
        fs::write(&f, "old").unwrap();
        let args = json!({ "changeSet": "需求A", "reason": "改一下" });
        let f2 = f.clone();
        let r = with_client(
            "claude-code",
            with_call(&state, "write_files", &args, async move {
                note(Op::Write, &f2, None);
                fs::write(&f2, "new").unwrap();
                Ok(json!({ "content": [{ "type": "text", "text": "ok" }] }))
            }),
        )
        .await
        .unwrap();
        let es = read_entries(&state.data_dir);
        assert_eq!(es.len(), 1);
        let e = &es[0];
        assert_eq!(e["op"], "write");
        assert_eq!(e["changeSet"], "需求A");
        assert_eq!(e["reason"], "改一下");
        assert_eq!(e["call"]["client"], "claude-code");
        assert_eq!(e["call"]["tool"], "write_files");
        assert_eq!(e["before"]["size"], 3);
        assert_eq!(e["after"]["sha256"], hex(&Sha256::digest(b"new")));
        assert!(e["seq"].as_u64().unwrap() >= 1);
        // 第一次用这个名字 → 结果末尾多一个回显块
        let blocks = r["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(blocks[1]["text"]
            .as_str()
            .unwrap()
            .contains("新变更集「需求A」"));
    }

    #[tokio::test]
    async fn 沿用已有名字不回显_内容不变不记() {
        let (state, dir) = make_state(|c| c.journal_enabled = true);
        let f = dir.join("b.txt");
        fs::write(&f, "1").unwrap();
        let args = json!({ "changeSet": "需求B" });
        for content in ["2", "3", "3"] {
            let f2 = f.clone();
            let r = with_call(&state, "edit_files", &args, async move {
                note(Op::Edit, &f2, None);
                fs::write(&f2, content).unwrap();
                Ok(json!({ "content": [{ "type": "text", "text": "ok" }] }))
            })
            .await
            .unwrap();
            if content != "2" {
                assert_eq!(
                    r["content"].as_array().unwrap().len(),
                    1,
                    "沿用名字不该回显"
                );
            }
        }
        let es = read_entries(&state.data_dir);
        assert_eq!(es.len(), 2, "第三次内容没变，不记");
        assert!(es[1]["seq"].as_u64() > es[0]["seq"].as_u64());
    }

    #[tokio::test]
    async fn 子操作继承外层变更集与调用id_回显只在外层() {
        let (state, dir) = make_state(|c| c.journal_enabled = true);
        let (fa, fb) = (dir.join("x.txt"), dir.join("y.txt"));
        let outer = json!({ "changeSet": "需求C", "reason": "批量" });
        let st = state.clone();
        let r = with_call(&state, "batch", &outer, async move {
            for f in [fa, fb] {
                let sub = json!({});
                let r = with_call(&st, "write_files", &sub, async move {
                    note(Op::Create, &f, None);
                    fs::write(&f, "x").unwrap();
                    Ok(json!({ "content": [{ "type": "text", "text": "ok" }] }))
                })
                .await
                .unwrap();
                assert_eq!(
                    r["content"].as_array().unwrap().len(),
                    1,
                    "子操作不追加回显"
                );
            }
            Ok(json!({ "content": [{ "type": "text", "text": "batch" }] }))
        })
        .await
        .unwrap();
        let es = read_entries(&state.data_dir);
        assert_eq!(es.len(), 2);
        assert_eq!(
            es[0]["call"]["id"], es[1]["call"]["id"],
            "同一次 batch 共享调用 id"
        );
        assert_eq!(es[0]["changeSet"], "需求C");
        assert_eq!(es[1]["reason"], "批量");
        assert_eq!(es[0]["op"], "create");
        assert!(es[0]["before"].is_null());
        assert_eq!(
            r["content"].as_array().unwrap().len(),
            2,
            "外层追加一次回显"
        );
    }

    #[tokio::test]
    async fn 关闭时不记_非写工具不记() {
        let (state, dir) = make_state(|c| c.journal_enabled = false);
        let f = dir.join("c.txt");
        let f2 = f.clone();
        with_call(&state, "write_files", &json!({}), async move {
            note(Op::Create, &f2, None);
            fs::write(&f2, "x").unwrap();
            Ok(json!({}))
        })
        .await
        .unwrap();
        assert!(read_entries(&state.data_dir).is_empty());
        state.config.write().await.journal_enabled = true;
        let f3 = f.clone();
        with_call(&state, "run_command", &json!({}), async move {
            note(Op::Write, &f3, None);
            fs::write(&f3, "y").unwrap();
            Ok(json!({}))
        })
        .await
        .unwrap();
        assert!(
            read_entries(&state.data_dir).is_empty(),
            "run_command 不在记录范围"
        );
    }

    #[tokio::test]
    async fn 变更集汇总按最后改动倒序_可按路径前缀过滤() {
        let (state, dir) = make_state(|c| c.journal_enabled = true);
        for (name, file) in [
            ("需求D", "d1.txt"),
            ("需求D", "d2.txt"),
            ("需求E", "sub/e.txt"),
        ] {
            let f = dir.join(file);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            let args = json!({ "changeSet": name });
            with_call(&state, "write_files", &args, async move {
                note(Op::Create, &f, None);
                fs::write(&f, "z").unwrap();
                Ok(json!({}))
            })
            .await
            .unwrap();
        }
        let all = scan_change_sets(&state.data_dir, None);
        assert_eq!(all.len(), 2);
        let d = all.iter().find(|s| s.name == "需求D").unwrap();
        assert_eq!(d.files, 2);
        let sub = dir.join("SUB").to_string_lossy().into_owned();
        let only = scan_change_sets(&state.data_dir, Some(&sub));
        assert_eq!(only.len(), 1, "前缀过滤不区分大小写");
        assert_eq!(only[0].name, "需求E");
    }

    #[tokio::test]
    async fn 重启后序号续着编() {
        let (state, dir) = make_state(|c| c.journal_enabled = true);
        let f = dir.join("s.txt");
        let f2 = f.clone();
        with_call(&state, "write_files", &json!({}), async move {
            note(Op::Create, &f2, None);
            fs::write(&f2, "1").unwrap();
            Ok(json!({}))
        })
        .await
        .unwrap();
        // 模拟重启：丢掉写句柄，序号要从文件里接着编。
        WRITERS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .remove(&journal_dir(&state.data_dir));
        let f3 = f.clone();
        with_call(&state, "write_files", &json!({}), async move {
            note(Op::Write, &f3, None);
            fs::write(&f3, "2").unwrap();
            Ok(json!({}))
        })
        .await
        .unwrap();
        let es = read_entries(&state.data_dir);
        assert_eq!(
            es[1]["seq"].as_u64().unwrap(),
            es[0]["seq"].as_u64().unwrap() + 1
        );
    }
}
