use std::io::{BufRead, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio::task_local;

use chrono::Local;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub tool: String,
    pub params: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "sourceIp", skip_serializing_if = "Option::is_none")]
    pub source_ip: Option<String>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// O1（结构化耗时拆解）：服务端总墙钟 = t_sent − t_recv。
    #[serde(rename = "serverMs", skip_serializing_if = "Option::is_none")]
    pub server_ms: Option<u64>,
    /// O1：实际文件读写 / 备份 / 拷贝耗时（task_local 跨工具累加）。
    #[serde(rename = "ioMs", skip_serializing_if = "Option::is_none")]
    pub io_ms: Option<u64>,
    /// O1：审计写盘耗时（以序列化开销为代理测量）。带小数的毫秒（f64）——实测典型值在
    /// 微秒级（~6.8µs），若用整数毫秒会恒截断为 0 而被前端过滤隐藏（见 O1 耗时拆解面板“审计
    /// 写盘”一项长期不可见的问题）。
    #[serde(rename = "auditMs", skip_serializing_if = "Option::is_none")]
    pub audit_ms: Option<f64>,
    /// O1：网络往返估算（O1-b 探针填；本次恒 None）。
    #[serde(rename = "netMs", skip_serializing_if = "Option::is_none")]
    pub net_ms: Option<u64>,
    /// O1：派生量 = serverMs − durationMs − auditMs（请求解析 + 响应序列化 + gzip + 线缆传输）。
    /// 同样改为 f64：输入里的 auditMs 带小数，若继续用整数会丢精度、也容易截断成 0 被隐藏。
    #[serde(rename = "overheadMs", skip_serializing_if = "Option::is_none")]
    pub overhead_ms: Option<f64>,
    /// 会话级 cwd 持久化的 handle（run_command 开启会话时记录，便于审计追溯）。
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// **发起这次工具调用的 CC 对话会话**（`system/init` 给的 session id）。
    ///
    /// 与 `sessionId` 是两回事：那个是 run_command 的 cwd 会话 handle，
    /// 这个才是「哪条对话让 CC 来调工具」。两者都只在各自场景下有值，
    /// 不要合并成一个字段——审计追溯与用量归属要分开。
    ///
    /// 只在 `turn_active` 期间填充（见 `CcSession::active_session_id`）：
    /// 轮次之间从别的客户端来的调用不属于任何对话。
    #[serde(rename = "ccSessionId", skip_serializing_if = "Option::is_none")]
    pub cc_session_id: Option<String>,
    /// 关联备份：本操作执行前生成的 .bak 绝对路径（仅写/删类操作、且备份开启时存在）。
    /// 前端据此提供「一键回滚 / 变更 Diff」入口。旧日志无此字段，`skip_serializing_if` 兼容。
    #[serde(rename = "backupPath", skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    /// 关联备份：被备份/覆盖的目标文件绝对路径（同一次操作的原文件，用于回滚写回定位）。
    #[serde(rename = "targetPath", skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    /// Token 用量估算埋点：工具返回结果的序列化字节数（http/sse 两处 dispatch 后计得）。
    /// 与 `params`（请求参数全文）一起构成「经桥交互增量」的估算基础：
    /// est_tokens = (params.len() + result_bytes) / 4。旧日志无此字段 → None，
    /// 聚合时按 0 计（估算偏低，与「估算非账单值」的口径一致）。
    #[serde(rename = "resultBytes", skip_serializing_if = "Option::is_none")]
    pub result_bytes: Option<u64>,
    /// 同一份结果按**客户端口径**算的字符数（`tools::wire_chars`）。
    ///
    /// 为什么不能拿 `result_bytes` 顶替：客户端是**按字符**分档的（≤49,823 原样、
    /// 越过就整条降级成 2KB 预览），而 UTF-8 中文 1 字符 = 3 字节。按字节判的话
    /// 一个 16,000 字的中文文件（48KB 字节）会被误判成「已降级」，而一个 60KB 的
    /// 纯中文文件（20,000 字符）其实完好无损 —— 两个方向都错。
    ///
    /// 旧日志没有这个字段（`None`）：聚合时退回 `result_bytes`，那对纯 ASCII 是等价的，
    /// 对中文只会偏高（宁可按「贵」提醒，也不要漏掉真的降级）。
    #[serde(rename = "resultChars", skip_serializing_if = "Option::is_none")]
    pub result_chars: Option<u64>,
}

/// 关联备份传递：在同一次工具调用（同一 async 任务）内，由写工具把本次生成的备份路径 +
/// 目标文件路径写入，再由 `write_audit_for_call` 在生成审计条目时取出并落盘。
/// 用 task_local 而非返回值穿透，避免改动 5 个工具 + dispatch_tool 的签名与返回类型。
/// 所有写工具的调用入口（http.rs 的 dispatch_tool、batch.rs 的子操作分发）都包裹在
/// `with_op_backup` 作用域内，故 `record_op_backup` / `take_op_backup` 一定处于作用域中。
use std::cell::RefCell;
task_local! {
    static OP_BACKUP: RefCell<Option<(Option<PathBuf>, Option<PathBuf>)>>;
    // 本次工具调用的来源 IP（供 batch 子操作补写 sourceIp；与 OP_BACKUP 同一任务作用域）。
    static SOURCE_IP: Option<String>;
}

/// 进入一次工具调用的来源 IP 作用域（包住 dispatch + 子操作分发）。
pub async fn with_source_ip<F>(ip: Option<String>, fut: F) -> F::Output
where
    F: std::future::Future,
{
    SOURCE_IP.scope(ip, fut).await
}

/// 读取当前工具调用的来源 IP；不在作用域内（如单元测试）时返回 None，不 panic。
pub fn current_source_ip() -> Option<String> {
    SOURCE_IP.try_with(|ip| ip.clone()).ok().flatten()
}

/// 进入一次工具调用的关联备份作用域，包裹 dispatch + 审计全过程（在 `handle_tools_call` 内）。
pub async fn with_op_backup<F>(fut: F) -> F::Output
where
    F: std::future::Future,
{
    let slot: RefCell<Option<(Option<PathBuf>, Option<PathBuf>)>> = RefCell::new(None);
    OP_BACKUP.scope(slot, fut).await
}

/// 工具内部调用：记录本次操作生成的备份路径与目标路径（供审计关联）。
/// 用 try_with 而非 with：作用域未建立（如单元测试直调 handle、或未来新的分发路径）时
/// 安全 no-op，而不是在写操作中途 panic（此时备份已生成、write_atomic 尚未执行）。
/// 生产路径下 dispatch 始终包在 with_op_backup 作用域内，关联仍正常生效。
pub fn record_op_backup(backup: Option<PathBuf>, target: Option<PathBuf>) {
    let _ = OP_BACKUP.try_with(|c| {
        *c.borrow_mut() = Some((backup, target));
    });
}

/// 审计写盘前调用：取出并清空关联备份信息（作用域缺失时返回 None，不 panic）。
pub fn take_op_backup() -> Option<(Option<PathBuf>, Option<PathBuf>)> {
    OP_BACKUP.try_with(|c| c.borrow_mut().take()).ok().flatten()
}

/// E-P0-7: 共享审计日志写句柄，避免每次写都 open 文件（高频批量调用下省 1000 open/s）。
/// 以 data_dir 为键惰性打开，写后 flush；日志被轮换（cleanup/clear）时由
/// `close_audit_writer` 释放句柄，避免 Windows 下文件被占用导致 rename 失败。
type AuditWriter = Option<(PathBuf, BufWriter<std::fs::File>)>;
static AUDIT_WRITER: OnceLock<Mutex<AuditWriter>> = OnceLock::new();

/// E-P4: 审计日志解析缓存。read_page 每 10s 被前端轮询，稳态下日志不再变化时全量
/// JSON 解析是纯浪费。以 (path, mtime, len) 为键值缓存整份解析结果，仅当文件被追加/
/// 轮换/清空（mtime 或 len 变化）时才重新解析。clear_all / cleanup_old_entries 在改写
/// 文件后主动失效，避免 stale。与 AUDIT_WRITER 同构（OnceLock<Mutex<…>>）。
type AuditCache = Option<(PathBuf, u64, u64, Vec<AuditEntry>)>;
static AUDIT_CACHE: OnceLock<Mutex<AuditCache>> = OnceLock::new();

pub fn write_audit_log(data_dir: &Path, entry: &AuditEntry) -> Result<(), String> {
    let line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize audit entry: {e}"))?;

    let lock = AUDIT_WRITER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().unwrap();
    // 重新打开条件：尚未打开，或目标目录变化（理论单目录，防御性）。
    let reopen = match guard.as_ref() {
        Some((p, _)) => p.as_path() != data_dir,
        None => true,
    };
    if reopen {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data_dir.join("audit.log"))
            .map_err(|e| format!("Failed to open audit log: {e}"))?;
        *guard = Some((data_dir.to_path_buf(), BufWriter::new(f)));
    }
    let (_, w) = guard.as_mut().unwrap();
    writeln!(w, "{}", line).map_err(|e| format!("Failed to write audit log: {e}"))?;
    w.flush()
        .map_err(|e| format!("Failed to flush audit log: {e}"))?;
    Ok(())
}

/// E-P0-7: 释放共享写句柄（审计日志轮换/清空前调用）。
pub fn close_audit_writer() {
    if let Some(m) = AUDIT_WRITER.get() {
        if let Ok(mut g) = m.lock() {
            if let Some((_, mut w)) = g.take() {
                let _ = w.flush();
            }
        }
    }
}

/// 分页读取结果（策略 A：页码分页）。前端依 `total` / `page_size` 计算总页数。
/// `entries` 已倒序（最新在前），`page` / `page_size` 回显请求值（已 clamp）。
#[derive(Debug, Clone, Serialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    /// 审计日志总条数（用于前端算总页数；不受当前页大小影响）
    pub total: usize,
    /// 当前页（≥1，已 clamp 到合法范围）
    pub page: usize,
    /// 每页条数（已 clamp 到 1..=500）
    #[serde(rename = "pageSize")]
    pub page_size: usize,
    #[serde(rename = "toolNames")]
    pub tool_names: Vec<String>,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct AuditFilter {
    pub query: Option<String>,
    pub tool: Option<String>,
    pub success: Option<bool>,
}

fn tool_search_label(tool: &str) -> &str {
    match tool {
        "read_files" => "读取文件",
        "write_files" => "写入文件",
        "edit_files" => "编辑文件",
        "list_directory" => "列目录",
        "list_allowed_roots" => "列出白名单",
        "run_command" => "执行命令",
        "get_command_output" => "拉取命令输出",
        "stop_command" => "终止命令",
        "search_files" => "搜索文件",
        "batch" => "批量操作",
        "create_directory" => "创建目录",
        "remove_directory" => "删除目录",
        "delete_files" => "删除文件",
        "move_files" => "移动/重命名",
        "copy_files" => "复制文件",
        "notebook_edit" => "编辑笔记本",
        "analyze_file" => "分析文件",
        _ => tool,
    }
}

fn filtered_slice(
    all: &[AuditEntry],
    start: usize,
    size: usize,
    filter: &AuditFilter,
) -> (usize, Vec<AuditEntry>, Vec<String>) {
    let query = filter.query.as_deref().unwrap_or("").trim().to_lowercase();
    let tool = filter.tool.as_deref().unwrap_or("");
    let mut tools = std::collections::BTreeSet::new();
    if query.is_empty() && tool.is_empty() && filter.success.is_none() {
        let names = all
            .iter()
            .map(|e| e.tool.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(str::to_owned)
            .collect();
        return (all.len(), page_slice(all, start, size), names);
    }
    let mut total = 0;
    let mut entries = Vec::new();
    for entry in all.iter().rev() {
        tools.insert(entry.tool.as_str());
        if (!tool.is_empty() && entry.tool != tool)
            || filter
                .success
                .is_some_and(|success| success != entry.success)
        {
            continue;
        }
        if !query.is_empty()
            && !format!(
                "{}\n{}\n{}\n{}\n{}\n{}",
                entry.timestamp,
                entry.tool,
                tool_search_label(&entry.tool),
                entry.params,
                entry.source_ip.as_deref().unwrap_or(""),
                entry.error.as_deref().unwrap_or("")
            )
            .to_lowercase()
            .contains(&query)
        {
            continue;
        }
        if total >= start && entries.len() < size {
            entries.push(entry.clone());
        }
        total += 1;
    }
    (
        total,
        entries,
        tools.into_iter().map(str::to_owned).collect(),
    )
}

/// 从已解析的全量条目里取一页（倒序：最新在前，与 read_recent_entries 旧行为一致）。
///
/// 只对本页那几条做 `cloned()`，不克隆整份——这是避免“为返回 50 条而 memcpy 几 MB”的关键。
fn page_slice(all: &[AuditEntry], start: usize, page_size: usize) -> Vec<AuditEntry> {
    all.iter()
        .rev()
        .skip(start)
        .take(page_size)
        .cloned()
        .collect()
}

/// 全量读入 audit.log 并逐行解析为 `AuditEntry`。仅在缓存未命中（文件变更）时调用，
/// 平时 read_page 直接复用 AUDIT_CACHE 中的已解析结果，跳过本函数。
fn parse_all_entries(log_path: &Path) -> Result<Vec<AuditEntry>, String> {
    let file =
        std::fs::File::open(log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;
    Ok(std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect())
}

/// 尾部窗口大小。实测单条审计 JSON 约 200–400 字节（带 O1 耗时拆解字段时偏大），
/// 8KB 够装 20–40 条，覆盖 `read_recent_tail` 的 n 上限（20）。
const TAIL_WINDOW: u64 = 8 * 1024;

/// 尾部读取最近 n 条审计（连接页「最近活动」用）。返回**最新在前**，与 `read_page` 排序一致。
///
/// 🔴 **为何不复用 `read_page`**：它的缓存键是 `(path, mtime, len)`，而审计是**追加写**——
/// 远程每调用一次工具就写一条，缓存**必然失效** → 走 `parse_all_entries` 全量重解析。
/// 本文件 `read_page` 头上那段注释里的实测基准是 **4898 条 / 5.2MB**；连接页若按 5s 轮询，
/// 就是每 5s 解析 5MB，而且随日志增长越来越贵。日志页这么干尚可（用户主动打开才跑），
/// 连接页是**默认停留页**，扛不住。
///
/// 本函数 `seek` 到文件末尾往回读一个固定窗口，只解析窗口内的行，
/// **复杂度 O(窗口) 而非 O(文件)**，成本与日志规模无关。也**不碰 `AUDIT_CACHE`**：
/// 不污染它（避免把部分数据当全量存进去），也不与日志页争那把锁。
pub fn read_recent_tail(data_dir: &Path, n: usize) -> Result<Vec<AuditEntry>, String> {
    // clamp 是防线：防止调用方传大值把它用成“分页读”——窗口固定，要更多也给不了。
    let n = n.clamp(1, 20);
    let log_path = data_dir.join("audit.log");
    // 文件不存在不是错误：首次启动、或用户刚清空过日志，就是这个状态。
    if !log_path.exists() {
        return Ok(vec![]);
    }

    let mut file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Failed to stat audit log: {e}"))?
        .len();
    let offset = len.saturating_sub(TAIL_WINDOW);
    if offset > 0 {
        file.seek(std::io::SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to seek audit log: {e}"))?;
    }
    let mut buf = Vec::with_capacity(TAIL_WINDOW as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read audit log tail: {e}"))?;

    // 从文件中间起读，偏移可能落在 UTF-8 多字节字符中间（审计 params 里常有中文路径）。
    // `from_utf8_lossy` 先兜住不报错，再配合下面的“丢首行”——两者合起来保证替换字符
    // 只会出现在那条被丢弃的行里，不会污染返回给前端的数据。
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    // offset > 0 说明不是从文件头读的，第一行**必然**被切断，直接丢。
    let start = if offset > 0 { 1.min(lines.len()) } else { 0 };

    // 倒序取（最新在前）。解析失败的行**静默跳过**：审计是追加写，读的瞬间
    // 最后一条可能只写了一半。这与 `parse_all_entries` 的 `filter_map(...ok())` 同策略。
    Ok(lines[start..]
        .iter()
        .rev()
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .take(n)
        .collect())
}

/// 分页读取审计日志（策略 A：页码分页）。
/// 读全 JSONL 文件 → `total = 行数` → 倒序（最新在前）→ `skip((page-1)*page_size).take(page_size)`。
/// 审计量受 30 天保留限制，全读可接受；返回结构供前端算总页数并渲染分页器。
///
/// E-P4 优化：以 (path, mtime, len) 为键值缓存整份解析结果。前端每 10s 轮询本函数，
/// 稳态下日志不再变化时直接复用缓存（零 JSON 解析）；仅当文件被追加/轮换/清空
/// （mtime 或 len 变化）时才重新全量解析。clear_all / cleanup_old_entries 在改写文件后
/// 主动失效缓存，避免返回 stale 数据。
pub fn read_page(data_dir: &Path, page: usize, page_size: usize) -> Result<AuditPage, String> {
    read_filtered_page(data_dir, page, page_size, &AuditFilter::default())
}

pub fn read_filtered_page(
    data_dir: &Path,
    page: usize,
    page_size: usize,
    filter: &AuditFilter,
) -> Result<AuditPage, String> {
    let page = page.max(1);
    let page_size = page_size.max(1);
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        // 文件不存在：清空缓存（避免 stale），返回空页。
        if let Some(m) = AUDIT_CACHE.get() {
            if let Ok(mut g) = m.lock() {
                *g = None;
            }
        }
        return Ok(AuditPage {
            entries: vec![],
            total: 0,
            page,
            page_size,
            tool_names: vec![],
        });
    }

    let meta =
        std::fs::metadata(&log_path).map_err(|e| format!("Failed to stat audit log: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let len = meta.len();

    // 判定命中与取页必须在同一次持锁内完成，避免 TOCTOU：更早的实现先短锁判 hit 再释锁重锁
    // 取数，两次之间若 clear_all/cleanup 把缓存置 None，`.as_ref().unwrap()` 会 panic 并在
    // 持锁时毒化互斥锁，导致后续所有 lock().unwrap() 跟着 panic。
    let cache = AUDIT_CACHE.get_or_init(|| Mutex::new(None));
    let start = (page - 1).saturating_mul(page_size);

    // 取页务必在持锁内完成，**只克隆本页需要的那几条**。
    //
    // 旧实现是 `Some(entries.clone())`：命中缓存时先把**整份**解析结果克隆一份，再
    // `rev().skip().take(page_size)` 丢掉0～99%。实测审计日志 4898 条 / 5.2MB，也就是说
    // 每次只为返回 50 条就要 memcpy 几 MB + 上万次 String 分配；而日志页开着时每 10s
    // 轮询一次（性能面板那条还是 page_size=500 / 30s）。
    //
    // 持锁时长反而变短：从“克隆全量”降为“克隆 page_size 条”。
    // 仍然是单次持锁完成判命中 + 取数，没有旧实现那种分两次持锁的 TOCTOU 窗口。
    let hit = {
        let g = cache.lock().unwrap();
        match g.as_ref() {
            Some((p, mt, ln, all))
                if p.as_path() == log_path.as_path() && *mt == mtime && *ln == len =>
            {
                Some(filtered_slice(all, start, page_size, filter))
            }
            _ => None,
        }
    };

    // 未命中：释锁后做 IO 解析，先取本页再把全量移进缓存（避免旧实现那次额外的
    // `parsed.clone()`——那是第二次全量克隆）。
    let (total, entries, tool_names) = match hit {
        Some(v) => v,
        None => {
            let parsed = parse_all_entries(&log_path)?;
            let selected = filtered_slice(&parsed, start, page_size, filter);
            *cache.lock().unwrap() = Some((log_path.clone(), mtime, len, parsed));
            selected
        }
    };

    Ok(AuditPage {
        entries,
        total,
        page,
        page_size,
        tool_names,
    })
}

/// 清空全部审计日志（删除 audit.log）。用户在日志页手动触发。
pub fn clear_all(data_dir: &Path) -> Result<(), String> {
    close_audit_writer();
    let log_path = data_dir.join("audit.log");
    if log_path.exists() {
        std::fs::remove_file(&log_path).map_err(|e| format!("Failed to clear audit log: {e}"))?;
    }
    // E-P4: 文件已删，失效解析缓存（下次读取会重建或返回空）。
    if let Some(m) = AUDIT_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn new_entry(
    tool: &str,
    params: &str,
    success: bool,
    error: Option<String>,
    source_ip: Option<String>,
    duration_ms: Option<u64>,
    server_ms: Option<u64>,
    io_ms: Option<u64>,
    audit_ms: Option<f64>,
    net_ms: Option<u64>,
    session_id: Option<String>,
    // 发起这次调用的 CC 对话会话（见字段上的说明）。
    cc_session_id: Option<String>,
) -> AuditEntry {
    // overhead = server − dispatch调度 − audit写盘；缺任一分量则留 None。f64 运算，不再用
    // saturating_sub（那是整数语义），max(0.0) 处理负数四舍五入误差。
    let overhead_ms = match (server_ms, duration_ms, audit_ms) {
        (Some(s), Some(d), Some(a)) => Some((s as f64 - d as f64 - a).max(0.0)),
        _ => None,
    };
    AuditEntry {
        timestamp: Local::now().to_rfc3339(),
        tool: tool.into(),
        params: params.into(),
        success,
        error,
        source_ip,
        duration_ms,
        server_ms,
        io_ms,
        audit_ms,
        net_ms,
        overhead_ms,
        session_id,
        cc_session_id,
        backup_path: None,
        target_path: None,
        // Token 用量估算：new_entry 拿不到响应体（dispatch 返回值在调用方手里），
        // 由 write_audit_for_call 在构造后补写（同 serverMs/auditMs 的补写模式）。
        // batch.rs 的子操作条目走不到那条路，保持 None → 只按请求侧估算。
        result_bytes: None,
        // 同 result_bytes：由 write_audit_for_call 在构造后补写（batch 子条目另行补）。
        result_chars: None,
    }
}

/// Remove audit entries older than `retention_days`. A value of 0 disables cleanup
/// (keep everything). Rewrites audit.log in place keeping only recent lines.
///
/// 返回**实际删掉的条数**（不是 `()`）：调用方靠它给用户反馈「已清理 N 条」，
/// 也靠它写日志。原先返回 `()` 且调用方用 `let _ =` 吞掉，清理成功与否、
/// 清了多少，用户和日志都完全无感。
pub fn cleanup_old_entries(data_dir: &Path, retention_days: u32) -> Result<u64, String> {
    if retention_days == 0 {
        return Ok(0);
    }

    // 🔴 清理必须与**追加写**互斥（审查 P2）。
    //
    // 原实现只调 `close_audit_writer()` 放掉句柄，然后就自己读→写 tmp→rename：
    // 这中间的窗口里，并发的一次 `write_audit_log` 会重新打开 audit.log 追加，
    // 随后 rename 把 tmp 盖上去——那一行审计**静默丢失**；而审计是安全留痕，
    // 丢一行等于给攻击者留了一个「在清理窗口里动作」的缝。
    //
    // 复用 AUDIT_WRITER 这把锁（write_audit_log 也拿它）：持有期间追加写会阻塞，
    // rename 完成后它们重新打开的是新文件，追加不会丢。
    // ⚠️ 不能再调 `close_audit_writer()`——它会去锁同一个 Mutex，直接自死锁。
    let lock = AUDIT_WRITER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    // 关句柄（Windows 下 rename 不能有打开的句柄），语义等同 close_audit_writer。
    if let Some((_, mut w)) = guard.take() {
        let _ = w.flush();
    }
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        return Ok(0);
    }

    let cutoff = Local::now() - chrono::Duration::days(retention_days as i64);

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open audit log: {e}"))?;

    let mut total: u64 = 0;
    let kept: Vec<String> = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| {
            total += 1;
            // Keep lines whose timestamp is newer than cutoff. Unparseable lines are kept.
            match serde_json::from_str::<AuditEntry>(line) {
                Ok(entry) => match chrono::DateTime::parse_from_rfc3339(&entry.timestamp) {
                    Ok(ts) => ts.with_timezone(&Local) >= cutoff,
                    Err(_) => true,
                },
                Err(_) => true,
            }
        })
        .collect();

    // 没有过期条目就不重写文件。原实现无条件 rewrite + rename，于是**每次启动**
    // 都白写一遍整份日志、并白白失效一次解析缓存（E-P4 那个缓存）。
    let removed = total - kept.len() as u64;
    if removed == 0 {
        return Ok(0);
    }

    // 临时文件名带 pid + 纳秒：固定 `audit.log.tmp` 时两个清理任务（启动清理 +
    // 改保留天数后的后台清理）会共用同一个 tmp，互相截断出半份日志（审查 P2）。
    let tmp_path = data_dir.join(format!(
        "audit.log.{}.{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    {
        let mut tmp = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp audit log: {e}"))?;
        for line in &kept {
            writeln!(tmp, "{}", line)
                .map_err(|e| format!("Failed to write temp audit log: {e}"))?;
        }
    }
    // rename 失败时不能留下垃圾 tmp（否则备份目录/数据目录里越积越多）。
    if let Err(e) = std::fs::rename(&tmp_path, &log_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to replace audit log: {e}"));
    }

    // E-P4: 文件已被 rewrite，mtime/len 已变，失效解析缓存（下次读取会重建）。
    if let Some(m) = AUDIT_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }

    Ok(removed)
}

// ═══════════════════════════════════════════════════════════════════════════
// Token 用量估算（首页用量卡 + 设置页详情）
//
// 口径：桥只看得到 MCP 请求参数与工具返回结果，模型侧的真实 token 消耗发生在
// 远程 Claude Code 与 Anthropic 之间，这里**只能估算**：
//   est_input  ≈ params.len() / 4（请求参数进入模型上下文）
//   est_output ≈ result_bytes / 4（工具结果返回后进入下一轮上下文）
// 4 字节 ≈ 1 token 是 JSON/英文为主的粗略经验值；中文内容（~3 字节/字）会略低估。
// UI 全程标注「估算」，绝不呈现为账单值。
// ═══════════════════════════════════════════════════════════════════════════

/// 折算基准：约多少字节 ≈ 1 token。
pub const BYTES_PER_TOKEN: u64 = 4;

/// 字节数 → 估算 token 数（纯函数，收口换算常数便于将来调整与单测）。
pub fn est_tokens(bytes: u64) -> u64 {
    bytes / BYTES_PER_TOKEN
}

/// 按天的用量汇总（天为本地日期）。
#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageDay {
    /// 本地日期 "YYYY-MM-DD"。
    pub date: String,
    pub calls: u64,
    #[serde(rename = "estInput")]
    pub est_input: u64,
    #[serde(rename = "estOutput")]
    pub est_output: u64,
}

/// 按工具的用量汇总（窗口期内）。
#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageTool {
    pub tool: String,
    pub calls: u64,
    #[serde(rename = "estInput")]
    pub est_input: u64,
    #[serde(rename = "estOutput")]
    pub est_output: u64,
}

/// Token 用量估算报告：按天序列（旧→新）+ 按工具排行（合计降序，Top 10）
/// + 按天×工具细分的稀疏矩阵（只含非零格）。
#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageReport {
    pub days: Vec<TokenUsageDay>,
    pub tools: Vec<TokenUsageTool>,
    /// 按（工具，日期）排序的非零格。与 days/tools **同一窗口**，三处合计必然一致。
    #[serde(rename = "byDayTool")]
    pub by_day_tool: Vec<TokenUsageCell>,
    /// 按 **CC 对话会话**归属的用量（窗口期内）。
    ///
    /// 只有带 `ccSessionId` 的条目才进得来：老日志没有这个字段，
    /// 非对话客户端（直接调桥的其它工具）也不该被算到某条对话头上。
    /// 因此这里的合计**小于** `days` 的合计，是它的一个子集，不是第三本账。
    #[serde(rename = "sessions")]
    pub sessions: Vec<TokenUsageSession>,
}

/// 按 CC 对话会话归属的用量汇总（窗口期内）。
#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageSession {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub calls: u64,
    #[serde(rename = "estInput")]
    pub est_input: u64,
    #[serde(rename = "estOutput")]
    pub est_output: u64,
}

/// 「按天 × 工具」矩阵的单格：某天某工具的调用数与 token 估算（输入+输出合计）。
/// 稀疏输出——没调用的组合不出现，前端按需铺表。
#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageCell {
    pub date: String,
    pub tool: String,
    pub calls: u64,
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
}

/// 审计时间戳（RFC3339）→ 本地日期键 "YYYY-MM-DD"。解析失败返回 None（该条不计入）。
fn entry_date_key(ts: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

/// 是否为 batch **容器**条目（兼容客户端加前缀的写法 `mcp__<server>__batch`）。
pub(crate) fn is_batch_container(tool: &str) -> bool {
    tool == "batch" || tool.ends_with("__batch")
}

/// 取全量审计条目（带 mtime/len 缓存），在**持锁期间**把 `&[AuditEntry]` 交给 `f` 聚合。
///
/// ## 为什么把聚合塞进闭包，而不是返回 `Vec<AuditEntry>`
///
/// 几千条 `AuditEntry`（每条带 `params` 全文）克隆一次就是几 MB，而调用方都只是
/// 遍历一遍。给引用就等于给了「零拷贝 + 不可能拿到过期快照」两件事。
///
/// ## 🔴 判命中与聚合必须在同一次持锁内完成
///
/// 中间放锁会让并发追加写入的条目落在「刚判过命中、聚合时文件已变」的空隙里：
/// 结果既不是旧快照也不是新快照。这与 `read_page` 是同一条 TOCTOU 防线。
///
/// 文件不存在不是错误：首次启动、或用户刚清空过日志就是这个状态（顺手失效缓存，
/// 否则清空后仍会读到清空前的旧快照）。
pub(crate) fn with_cached_entries<R>(
    data_dir: &Path,
    f: impl FnOnce(&[AuditEntry]) -> R,
) -> Result<R, String> {
    let log_path = data_dir.join("audit.log");
    if !log_path.exists() {
        if let Some(m) = AUDIT_CACHE.get() {
            if let Ok(mut g) = m.lock() {
                *g = None;
            }
        }
        return Ok(f(&[]));
    }

    let meta =
        std::fs::metadata(&log_path).map_err(|e| format!("Failed to stat audit log: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let len = meta.len();

    let cache = AUDIT_CACHE.get_or_init(|| Mutex::new(None));
    {
        let g = cache.lock().unwrap();
        if let Some((p, mt, ln, all)) = g.as_ref() {
            if p.as_path() == log_path.as_path() && *mt == mtime && *ln == len {
                return Ok(f(all));
            }
        }
    }

    let parsed = parse_all_entries(&log_path)?;
    let out = f(&parsed);
    *cache.lock().unwrap() = Some((log_path, mtime, len, parsed));
    Ok(out)
}

/// 把已解析条目聚合进日期桶与工具桶。纯聚合，不做 IO——单独抽出便于单测。
fn aggregate_usage(all: &[AuditEntry], date_keys: &[String]) -> TokenUsageReport {
    let idx_of: std::collections::HashMap<&str, usize> = date_keys
        .iter()
        .enumerate()
        .map(|(i, d)| (d.as_str(), i))
        .collect();
    let mut days: Vec<TokenUsageDay> = date_keys
        .iter()
        .map(|d| TokenUsageDay {
            date: d.clone(),
            calls: 0,
            est_input: 0,
            est_output: 0,
        })
        .collect();
    // value: [calls, est_input, est_output]
    let mut tools: std::collections::HashMap<&str, [u64; 3]> = std::collections::HashMap::new();
    // key: (date_idx, tool) → [calls, est_input+output]。与 days/tools 同一次遍历填充，
    // 保证三个视图的合计口径必然一致（窗口内条目三方全计，窗口外三方全不计）。
    let mut grid: std::collections::HashMap<(usize, &str), [u64; 2]> =
        std::collections::HashMap::new();
    // key: cc_session_id → [calls, est_input, est_output]。只收带了归属的条目，
    // 与 days/tools **同一个窗口、同一套 inp/out**（batch 容器同样只记 calls）。
    let mut sessions: std::collections::HashMap<&str, [u64; 3]> = std::collections::HashMap::new();

    for e in all {
        let Some(dk) = entry_date_key(&e.timestamp) else {
            continue;
        };
        // 不在窗口内的条目只跳过日期桶，仍计入工具排行？不——工具排行与天序列必须
        // 是同一个窗口，否则两处数字对不上（设置页表与排行并列展示）。
        let Some(&i) = idx_of.get(dk.as_str()) else {
            continue;
        };
        // 🔴 batch 是**容器**：params 里裹着全部子操作参数，返回体里裹着全部子结果文本；
        // 而 batch.rs 已为每条子操作单独落了审计（各自带 params 与 resultBytes，
        // 字节按「实际进入上下文」记，被 stub 的只记那句指路话）。
        // 若外层也计入 token，同一次调用会被记两遍：一次 4 子操作的 batch 会让
        // input/output 各虚高近一倍，正好把 batch 省下来的量在账上抹平。
        // 因此外层只保留 calls（它确实被调用了一次），token 全部由子条目的同源分母承担。
        let is_container = is_batch_container(&e.tool);
        let inp = if is_container {
            0
        } else {
            est_tokens(e.params.len() as u64)
        };
        let out = if is_container {
            0
        } else {
            est_tokens(e.result_bytes.unwrap_or(0))
        };
        let d = &mut days[i];
        d.calls += 1;
        d.est_input += inp;
        d.est_output += out;
        let t = tools.entry(e.tool.as_str()).or_insert([0, 0, 0]);
        t[0] += 1;
        t[1] += inp;
        t[2] += out;
        let g = grid.entry((i, e.tool.as_str())).or_insert([0, 0]);
        g[0] += 1;
        g[1] += inp + out;
        // 归属：只在这次调用确实由某条对话发起时记账。`turn_active` 之外的
        // 调用（别的客户端在用桥）不带这个字段，不计入任何会话。
        if let Some(sid) = e.cc_session_id.as_deref() {
            let s = sessions.entry(sid).or_insert([0, 0, 0]);
            s[0] += 1;
            s[1] += inp;
            s[2] += out;
        }
    }

    let mut tools: Vec<TokenUsageTool> = tools
        .into_iter()
        .map(|(tool, c)| TokenUsageTool {
            tool: tool.to_string(),
            calls: c[0],
            est_input: c[1],
            est_output: c[2],
        })
        .collect();
    tools.sort_by(|a, b| {
        (b.est_input + b.est_output)
            .cmp(&(a.est_input + a.est_output))
            .then_with(|| a.tool.cmp(&b.tool))
    });
    tools.truncate(10);

    // 矩阵按（工具，日期）排序：前端按工具分组铺行最省事，同工具内日期天然有序。
    let mut by_day_tool: Vec<TokenUsageCell> = grid
        .into_iter()
        .map(|((i, tool), c)| TokenUsageCell {
            date: date_keys[i].clone(),
            tool: tool.to_string(),
            calls: c[0],
            est_tokens: c[1],
        })
        .collect();
    by_day_tool.sort_by(|a, b| a.tool.cmp(&b.tool).then_with(|| a.date.cmp(&b.date)));

    let mut sessions: Vec<TokenUsageSession> = sessions
        .into_iter()
        .map(|(session_id, c)| TokenUsageSession {
            session_id: session_id.to_string(),
            calls: c[0],
            est_input: c[1],
            est_output: c[2],
        })
        .collect();
    // 与 tools 同一排序口径：估算量降序，同量按 id 升序（稳定、可对账）。
    sessions.sort_by(|a, b| {
        (b.est_input + b.est_output)
            .cmp(&(a.est_input + a.est_output))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });

    TokenUsageReport {
        days,
        tools,
        by_day_tool,
        sessions,
    }
}

/// Token 用量估算报告（近 `days` 天，含今天；clamp 1..=120）。
///
/// 上限 120 覆盖设置页热力图的 90 天视图；实际能取到多少天受审计日志保留期
/// （`audit_retention_days`，默认 30）限制——窗口内没有数据的天就是 0，前端照实显示。
///
/// 复用 `AUDIT_CACHE`（与日志页 read_page 同一份 (path,mtime,len) 缓存）：
/// 首页用量卡 30s 轮询，稳态（日志未变）时零解析；日志活跃时与日志页共享同一次
/// 全量解析成本。聚合本身在持锁内完成——遍历数千条只是内存计数，远快于重新解析。
pub fn read_usage_report(data_dir: &Path, days: u32) -> Result<TokenUsageReport, String> {
    let days = days.clamp(1, 120) as usize;
    let log_path = data_dir.join("audit.log");

    // 日期桶：旧→新，最后一天是今天。
    let today = Local::now().date_naive();
    let date_keys: Vec<String> = (0..days)
        .rev()
        .map(|i| {
            (today - chrono::Duration::days(i as i64))
                .format("%Y-%m-%d")
                .to_string()
        })
        .collect();

    if !log_path.exists() {
        // 与 read_page 同策略：文件不存在先失效缓存，再返回全零报告。
        if let Some(m) = AUDIT_CACHE.get() {
            if let Ok(mut g) = m.lock() {
                *g = None;
            }
        }
        return Ok(aggregate_usage(&[], &date_keys));
    }

    let meta =
        std::fs::metadata(&log_path).map_err(|e| format!("Failed to stat audit log: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let len = meta.len();

    // 判命中与聚合在同一次持锁内完成（与 read_page 同样的 TOCTOU 防线）。
    let cache = AUDIT_CACHE.get_or_init(|| Mutex::new(None));
    let hit: Option<TokenUsageReport> = {
        let g = cache.lock().unwrap();
        match g.as_ref() {
            Some((p, mt, ln, all))
                if p.as_path() == log_path.as_path() && *mt == mtime && *ln == len =>
            {
                Some(aggregate_usage(all, &date_keys))
            }
            _ => None,
        }
    };
    if let Some(report) = hit {
        return Ok(report);
    }

    // 未命中：全量解析 → 聚合 → 回填缓存。
    let parsed = parse_all_entries(&log_path)?;
    let report = aggregate_usage(&parsed, &date_keys);
    *cache.lock().unwrap() = Some((log_path, mtime, len, parsed));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    fn tmp_dir(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cc-bridge-audit-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    /// 🔴 回归（审查 P2）：清理与并发追加必须互斥，**不得丢审计行**。
    ///
    /// 原实现 close_audit_writer() 后自己读→写 tmp→rename，窗口里并发追加的那几行
    /// 会被 rename 覆盖掉（审计丢失 = 安全留痕缺口）。现在两边共用 AUDIT_WRITER 锁。
    #[test]
    fn cleanup_does_not_drop_concurrent_appends() {
        let dir = tmp_dir("cleanup-race");
        // 先放一条很旧的记录，保证 cleanup 真的会走「重写文件」那条路。
        let mut old_entry = new_entry(
            "read_files",
            "{}",
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        old_entry.timestamp = "2000-01-01T00:00:00+08:00".into();
        write_audit_log(&dir, &old_entry).expect("seed old");

        const WRITERS: usize = 4;
        const PER_WRITER: usize = 40;
        let mut handles = Vec::new();
        for w in 0..WRITERS {
            let d = dir.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..PER_WRITER {
                    let marker = format!("probe-{w}-{i}");
                    let e = new_entry(
                        &marker, "{}", true, None, None, None, None, None, None, None, None, None,
                    );
                    write_audit_log(&d, &e).expect("append");
                }
            }));
        }
        // 与写入并发地清理（保留 1 天：只清掉那条 2000 年的）。
        let d2 = dir.clone();
        let cleanup = std::thread::spawn(move || cleanup_old_entries(&d2, 1).expect("cleanup"));
        for h in handles {
            h.join().expect("writer");
        }
        cleanup.join().expect("cleanup thread");

        let text = std::fs::read_to_string(dir.join("audit.log")).expect("read log");
        for w in 0..WRITERS {
            for i in 0..PER_WRITER {
                let marker = format!("probe-{w}-{i}");
                assert!(text.contains(&marker), "并发写入的审计行丢失：{marker}");
            }
        }
        assert!(!text.contains("2000-01-01"), "过期行应被清理");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 固定 tmp 名会让两个清理互相截断；这里断言清理后目录里不留 tmp 垃圾。
    #[test]
    fn cleanup_leaves_no_tmp_file() {
        let dir = tmp_dir("cleanup-tmp");
        let mut old_entry = new_entry(
            "read_files",
            "{}",
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        old_entry.timestamp = "2000-01-01T00:00:00+08:00".into();
        write_audit_log(&dir, &old_entry).expect("seed");
        cleanup_old_entries(&dir, 1).expect("cleanup");
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留 tmp：{leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chinese_tool_labels_are_searchable_as_displayed() {
        let labels = [
            ("list_directory", "列目录"),
            ("move_files", "移动/重命名"),
            ("get_command_output", "拉取命令输出"),
            ("stop_command", "终止命令"),
        ];
        let entries: Vec<super::AuditEntry> = labels
            .iter()
            .map(|(tool, _)| {
                serde_json::from_value(serde_json::json!({
                    "timestamp": "2026-10-15T10:00:00+08:00", "tool": tool,
                    "params": "", "success": true
                }))
                .unwrap()
            })
            .collect();
        for (tool, label) in labels {
            let filter = super::AuditFilter {
                query: Some(label.into()),
                ..Default::default()
            };
            let (total, result, _) = super::filtered_slice(&entries, 0, 50, &filter);
            assert_eq!(total, 1, "{label}");
            assert_eq!(result[0].tool, tool);
        }
    }

    #[test]
    fn filters_all_history_before_pagination_and_keeps_tool_choices() {
        let entries: Vec<super::AuditEntry> = (0..8).map(|i| serde_json::from_value(serde_json::json!({
            "timestamp": format!("2026-10-15T10:00:0{i}+08:00"),
            "tool": if i % 2 == 0 { "read_files" } else { "run_command" },
            "params": if i == 1 { "src/Legacy.ts" } else { "src/current.ts" },
            "success": i % 2 == 0, "sourceIp": "10.0.0.8", "error": if i % 2 == 0 { None } else { Some("denied") }
        })).unwrap()).collect();
        let filter = super::AuditFilter {
            query: Some("legacy".into()),
            success: Some(false),
            ..Default::default()
        };
        let (total, result, tools) = super::filtered_slice(&entries, 0, 2, &filter);
        assert_eq!(total, 1);
        assert_eq!(result[0].params, "src/Legacy.ts");
        assert_eq!(tools, vec!["read_files", "run_command"]);
        let filter = super::AuditFilter {
            success: Some(false),
            ..Default::default()
        };
        let (total, result, _) = super::filtered_slice(&entries, 2, 2, &filter);
        assert_eq!(total, 4);
        assert_eq!(
            result
                .iter()
                .map(|e| e.timestamp.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-10-15T10:00:03+08:00", "2026-10-15T10:00:01+08:00"]
        );
        let filter = super::AuditFilter {
            query: Some("读取文件".into()),
            ..Default::default()
        };
        assert_eq!(super::filtered_slice(&entries, 0, usize::MAX, &filter).0, 4);
        let filter = super::AuditFilter {
            query: Some("10.0.0.8".into()),
            tool: Some("run_command".into()),
            ..Default::default()
        };
        assert_eq!(
            super::filtered_slice(&entries, 0, usize::MAX, &filter)
                .1
                .len(),
            4
        );
        let filter = super::AuditFilter {
            query: Some("missing".into()),
            ..Default::default()
        };
        assert_eq!(super::filtered_slice(&entries, 0, 50, &filter).0, 0);
    }
    use super::*;

    /// cleanup_old_entries 必须返回**实际删除条数**，且无过期条目时返回 0 并
    /// **不重写文件**。前者是「不再静默」的基础（调用方靠它写日志 / 提示用户）；
    /// 后者避免每次启动白写一遍整份日志、并白白失效一次解析缓存。
    #[test]
    fn cleanup_reports_removed_count_and_skips_when_nothing_expired() {
        let dir = tmp_data_dir("cleanup-count");
        let _ = clear_all(&dir);
        let log = dir.join("audit.log");

        let old_ts = (Local::now() - chrono::Duration::days(90)).to_rfc3339();
        let now_ts = Local::now().to_rfc3339();
        let line = |ts: &str, tool: &str| {
            format!(r#"{{"timestamp":"{ts}","tool":"{tool}","params":"{{}}","success":true}}"#)
        };
        std::fs::write(
            &log,
            format!(
                "{}\n{}\n{}\n",
                line(&old_ts, "old1"),
                line(&old_ts, "old2"),
                line(&now_ts, "fresh")
            ),
        )
        .expect("write log");

        let removed = cleanup_old_entries(&dir, 30).expect("cleanup");
        assert_eq!(removed, 2, "应报告删除 2 条");
        let page = read_page(&dir, 1, 50).expect("read");
        assert_eq!(page.total, 1, "只应剩下未过期的那一条");
        assert_eq!(page.entries[0].tool, "fresh");

        // 再跑一次：已无过期条目 → 返回 0，且文件 mtime 不变（证明没被重写）
        let before = std::fs::metadata(&log)
            .and_then(|m| m.modified())
            .expect("mtime");
        let again = cleanup_old_entries(&dir, 30).expect("cleanup again");
        assert_eq!(again, 0);
        let after = std::fs::metadata(&log)
            .and_then(|m| m.modified())
            .expect("mtime2");
        assert_eq!(before, after, "无过期条目时不应重写文件");

        let _ = clear_all(&dir);
    }

    /// O1 向后兼容：旧版 audit.log 行（无 serverMs/ioMs/auditMs/netMs/overheadMs）
    /// 必须能被新 AuditEntry 解析，且这些新字段全为 None，旧字段正常。
    #[test]
    fn old_log_line_parses_with_none_timing_fields() {
        let line = r#"{"timestamp":"2026-07-10T12:00:00+08:00","tool":"read_files","params":"{}","success":true,"sourceIp":"127.0.0.1","durationMs":3}"#;
        let entry: AuditEntry = serde_json::from_str(line).expect("旧格式应可解析");
        assert_eq!(entry.tool, "read_files");
        assert_eq!(entry.duration_ms, Some(3));
        assert_eq!(entry.server_ms, None);
        assert_eq!(entry.io_ms, None);
        assert_eq!(entry.audit_ms, None);
        assert_eq!(entry.net_ms, None);
        assert_eq!(entry.overhead_ms, None);
        // Token 用量估算字段同属向后兼容范畴：旧行无 resultBytes → None。
        assert_eq!(entry.result_bytes, None);
    }

    /// est_tokens：换算常数收口。0/不足一个 token 的零头都向下取整。
    #[test]
    fn est_tokens_divides_by_bytes_per_token() {
        assert_eq!(est_tokens(0), 0);
        assert_eq!(est_tokens(3), 0);
        assert_eq!(est_tokens(BYTES_PER_TOKEN), 1);
        assert_eq!(est_tokens(BYTES_PER_TOKEN * 3 + 2), 3);
    }

    /// entry_date_key：合法 RFC3339 → Some("YYYY-MM-DD")；垃圾串 → None（不计入）。
    /// 带时区偏移的时间戳须正确换算到本地日期（+08:00 的中午 12 点在 GMT+8 机器上
    /// 就是当天；本测试在非 GMT+8 机器上只断言「能解析出 10 位日期」，不断言具体值）。
    #[test]
    fn entry_date_key_parses_rfc3339() {
        let key = entry_date_key("2026-09-27T12:00:00+08:00").expect("合法时间戳应可解析");
        assert_eq!(key.len(), 10);
        assert_eq!(key.as_bytes()[4], b'-');
        assert_eq!(key.as_bytes()[7], b'-');
        assert_eq!(entry_date_key("not-a-date"), None);
    }

    /// aggregate_usage：日期桶计数 / 输入输出拆分 / 旧日志(None)按 0 计 / 窗口外
    /// 条目整体跳过（天数序列与工具排行必须是同一窗口）/ 工具排行按合计降序。
    #[test]
    fn aggregate_usage_buckets_days_and_ranks_tools() {
        let today = Local::now().date_naive();
        let dk = |offset: i64| {
            (today - chrono::Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string()
        };
        let ts = |offset: i64| (Local::now() - chrono::Duration::days(offset)).to_rfc3339();
        let date_keys = vec![dk(1), dk(0)]; // 昨天、今天

        let mk = |tool: &str, ts: String, params_len: usize, rb: Option<u64>| AuditEntry {
            timestamp: ts,
            tool: tool.into(),
            params: "x".repeat(params_len),
            success: true,
            error: None,
            source_ip: None,
            duration_ms: None,
            server_ms: None,
            io_ms: None,
            audit_ms: None,
            net_ms: None,
            overhead_ms: None,
            session_id: None,
            cc_session_id: None,
            backup_path: None,
            target_path: None,
            result_bytes: rb,
            result_chars: rb,
        };
        let entries = vec![
            // 今天：read_files 参数 40B→10 tok，结果 80B→20 tok
            mk("read_files", ts(0), 40, Some(80)),
            // 今天：write_file 无结果字节（旧日志/批次子操作）→ 输出按 0
            mk("write_file", ts(0), 20, None),
            // 昨天：read_files
            mk("read_files", ts(1), 8, Some(12)),
            // 窗口外（前天）：不应出现在任何桶里
            mk("read_files", ts(2), 999, Some(999)),
        ];

        let report = aggregate_usage(&entries, &date_keys);
        assert_eq!(report.days.len(), 2);
        let yesterday = &report.days[0];
        assert_eq!(yesterday.calls, 1);
        assert_eq!(yesterday.est_input, 2);
        assert_eq!(yesterday.est_output, 3);
        let td = &report.days[1];
        assert_eq!(td.calls, 2);
        assert_eq!(td.est_input, 10 + 5);
        assert_eq!(td.est_output, 20);

        // 排行：read_files 合计 35 > write_file 合计 5；窗口外的 999 不计入。
        assert_eq!(report.tools.len(), 2);
        assert_eq!(report.tools[0].tool, "read_files");
        assert_eq!(report.tools[0].calls, 2);
        assert_eq!(report.tools[0].est_input, 12);
        assert_eq!(report.tools[0].est_output, 23);
        assert_eq!(report.tools[1].tool, "write_file");
        assert_eq!(report.tools[1].est_output, 0);

        // 矩阵：只含非零格；窗口外的条目不出现；与天序列同口径（today 的
        // read_files = 10+20=30 tok、1 次；write_file = 5 tok、1 次；昨天 read_files = 5）。
        assert_eq!(report.by_day_tool.len(), 3);
        // 排序：先工具后日期。
        let cells: Vec<(&str, &str, u64, u64)> = report
            .by_day_tool
            .iter()
            .map(|c| (c.tool.as_str(), c.date.as_str(), c.calls, c.est_tokens))
            .collect();
        assert_eq!(
            cells,
            vec![
                ("read_files", dk(1).as_str(), 1, 2 + 3),
                ("read_files", dk(0).as_str(), 1, 10 + 20),
                ("write_file", dk(0).as_str(), 1, 5),
            ]
        );
    }

    /// 按 CC 会话归属：只有带 `ccSessionId` 的条目才进 `sessions`，
    /// 且与 days/tools 同一窗口、同一套 inp/out。它是 days 的**子集**
    /// （别的客户端在用的调用不属于任何对话），不是第三本账。
    #[test]
    fn sessions_only_collect_attributed_entries() {
        let date_keys = vec![Local::now().format("%Y-%m-%d").to_string()];
        let today = Local::now().to_rfc3339();
        let base = AuditEntry {
            timestamp: today,
            tool: "read_files".into(),
            params: "x".repeat(40),
            success: true,
            error: None,
            source_ip: None,
            duration_ms: None,
            server_ms: None,
            io_ms: None,
            audit_ms: None,
            net_ms: None,
            overhead_ms: None,
            session_id: None,
            cc_session_id: Some("cc-a".into()),
            backup_path: None,
            target_path: None,
            result_bytes: Some(80),
            result_chars: Some(80),
        };
        // 今天、同一条对话：两次调用。
        let e_today = base.clone();
        let e_today2 = AuditEntry { ..base.clone() };
        // 不带归属（别的客户端在用桥）：进 days/tools，不进 sessions。
        let e_unattributed = AuditEntry {
            cc_session_id: None,
            ..base.clone()
        };
        // 窗口外的归属条目：两边都不该出现。
        let e_old = AuditEntry {
            timestamp: (Local::now() - chrono::Duration::days(9)).to_rfc3339(),
            ..base.clone()
        };
        let report = aggregate_usage(&[e_today, e_today2, e_unattributed, e_old], &date_keys);
        assert_eq!(
            report.days[0].calls, 3,
            "三条今天的都进总账（含不带归属的）"
        );
        assert_eq!(report.sessions.len(), 1, "只有一条会话被归属");
        let s = &report.sessions[0];
        assert_eq!(s.session_id, "cc-a");
        assert_eq!(s.calls, 2, "窗口外那条不计");
        assert_eq!(s.est_input, est_tokens(40) * 2);
        assert_eq!(s.est_output, est_tokens(80) * 2);
        // 子集关系：会话合计 ≤ 当日合计（这里严格小于，因为还有一条不带归属的）。
        assert!(s.est_input + s.est_output < report.days[0].est_input + report.days[0].est_output);
    }

    /// batch 容器条目不重复计 token：子操作已各自落审计（带自己的 params 与
    /// resultBytes），外层若也计入，同一次调用会被记两遍。calls 仍保留 1
    /// （它确实被调用了一次，日志页要看得到这行）。
    #[test]
    fn batch_container_entry_only_counts_calls() {
        let date_keys = vec![Local::now().format("%Y-%m-%d").to_string()];
        let mk = |tool: &str, params_len: usize, rb: Option<u64>| AuditEntry {
            timestamp: Local::now().to_rfc3339(),
            tool: tool.into(),
            params: "x".repeat(params_len),
            success: true,
            error: None,
            source_ip: None,
            duration_ms: None,
            server_ms: None,
            io_ms: None,
            audit_ms: None,
            net_ms: None,
            overhead_ms: None,
            session_id: None,
            cc_session_id: None,
            backup_path: None,
            target_path: None,
            result_bytes: rb,
            result_chars: rb,
        };
        let entries = vec![
            // 外层容器：params 裹着全部子操作参数（400B），返回体是全部子结果（800B）
            mk("batch", 400, Some(800)),
            // 两个子操作：各 100B 参数 / 200B 结果
            mk("read_files", 100, Some(200)),
            mk("search_files", 100, Some(200)),
            // 带客户端前缀的写法同样归为容器
            mk("mcp__cc-bridge__batch", 400, Some(800)),
        ];

        let report = aggregate_usage(&entries, &date_keys);
        let td = &report.days[0];
        // 输出只等于两条子条目之和（200+200 = 400B → 100 tok），外层 800B 不计。
        assert_eq!(td.est_output, 100);
        // 输入同理：只算子条目的 100+100 = 200B → 50 tok。
        assert_eq!(td.est_input, 50);
        // calls 不归零：4 条调用各自计数（外层 2 次 + 子操作 2 次）。
        assert_eq!(td.calls, 4);
    }

    /// read_usage_report：写真实日志 → 近 7 天报告正确；文件不存在 → 7 个全零天。
    #[test]
    fn usage_report_reads_log_and_zeroes_when_missing() {
        let dir = tmp_data_dir("usage-report");
        let _ = clear_all(&dir);

        // 文件不存在：全零 7 天，最后一天是今天。
        let empty = read_usage_report(&dir, 7).expect("empty");
        assert_eq!(empty.days.len(), 7);
        assert!(empty.days.iter().all(|d| d.calls == 0));
        let today_key = Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(empty.days[6].date, today_key);

        // 写两条今天的真实条目（带 resultBytes），再读。
        let mut e1 = new_entry(
            "read_files",
            "xxxx",
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        e1.result_bytes = Some(40);
        write_audit_log(&dir, &e1).expect("write 1");
        let e2 = new_entry(
            "list_dir", "{}", true, None, None, None, None, None, None, None, None, None,
        );
        write_audit_log(&dir, &e2).expect("write 2");

        let report = read_usage_report(&dir, 7).expect("report");
        assert_eq!(report.days.len(), 7);
        let td = &report.days[6];
        assert_eq!(td.date, today_key);
        assert_eq!(td.calls, 2);
        assert_eq!(td.est_input, 1); // "xxxx" 4B → 1 tok；"{}" 2B → 0 tok
        assert_eq!(td.est_output, 10);
        assert_eq!(report.tools[0].tool, "read_files");
        assert_eq!(report.tools[0].est_output, 10);
        assert_eq!(report.tools[1].tool, "list_dir");

        // 追加一条 → 缓存失效 → 计数增长（缓存回填路径正确）。
        // 排行不变：list_dir 合计 0 tok，read_files（11 tok）仍是第一。
        let e3 = new_entry(
            "list_dir", "{}", true, None, None, None, None, None, None, None, None, None,
        );
        write_audit_log(&dir, &e3).expect("write 3");
        let again = read_usage_report(&dir, 7).expect("report again");
        assert_eq!(again.days[6].calls, 3);
        assert_eq!(again.tools[0].tool, "read_files");
        assert_eq!(again.tools[1].tool, "list_dir");
        assert_eq!(again.tools[1].calls, 2);

        let _ = clear_all(&dir);
    }

    /// O1：new_entry 应正确派生 overheadMs = server − duration − audit。
    #[test]
    fn new_entry_derives_overhead() {
        let e = new_entry(
            "read_files",
            "{}",
            true,
            None,
            Some("1.2.3.4".into()),
            Some(10),
            Some(20),
            Some(4),
            Some(2.0),
            None,
            None,
            None,
        );
        assert_eq!(e.server_ms, Some(20));
        assert_eq!(e.io_ms, Some(4));
        assert_eq!(e.audit_ms, Some(2.0));
        // overhead = 20 − 10 − 2 = 8
        assert_eq!(e.overhead_ms, Some(8.0));
    }

    /// O1：修复前 auditMs/overheadMs 用整数毫秒会把微秒级实测值截断为 0，导致前端
    /// 过滤隐藏。f64 应能保留小数精度。
    #[test]
    fn new_entry_keeps_sub_millisecond_audit_precision() {
        let e = new_entry(
            "read_files",
            "{}",
            true,
            None,
            None,
            Some(1),
            Some(1),
            None,
            Some(0.0068),
            None,
            None,
            None,
        );
        assert_eq!(e.audit_ms, Some(0.0068));
        // overhead = 1 − 1 − 0.0068，clamp 到 0
        assert_eq!(e.overhead_ms, Some(0.0));
    }

    /// E-P4: 测试辅助——在系统临时目录下建一个唯一子目录作 data_dir。
    fn tmp_data_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccb_test_{}_{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// E-P4: read_page 倒序分页 + total 正确；且二次同参调用走缓存命中、结果一致。
    #[test]
    fn read_page_paginates_recent_first() {
        let dir = tmp_data_dir("paging");
        let _ = clear_all(&dir);
        for i in 0..5 {
            let e = new_entry(
                format!("tool_{i}").as_str(),
                "{}",
                true,
                None,
                None,
                Some(i as u64),
                Some(i as u64),
                None,
                None,
                None,
                None,
                None,
            );
            write_audit_log(&dir, &e).expect("write");
        }
        let page = read_page(&dir, 1, 50).expect("read");
        assert_eq!(page.total, 5);
        assert_eq!(page.entries.len(), 5);
        // 倒序：最新（tool_4）在前
        assert_eq!(page.entries[0].tool, "tool_4");
        assert_eq!(page.entries[4].tool, "tool_0");

        // 第二页：page_size=2 → 取 tool_4, tool_3（缓存命中路径）
        let p2 = read_page(&dir, 1, 2).expect("read2");
        assert_eq!(p2.entries.len(), 2);
        assert_eq!(p2.entries[0].tool, "tool_4");
        assert_eq!(p2.entries[1].tool, "tool_3");

        // 二次同参调用结果一致（缓存未失效）
        let again = read_page(&dir, 1, 50).expect("read again");
        assert_eq!(again.total, page.total);
        assert_eq!(again.entries[0].tool, page.entries[0].tool);
        let _ = clear_all(&dir);
    }

    /// E-P4: 无文件变更时两次 read_page 结果一致；追加后缓存失效、total 增加。
    #[test]
    fn read_page_cache_consistent_and_invalidates() {
        let dir = tmp_data_dir("cache");
        let _ = clear_all(&dir);
        for i in 0..3 {
            let e = new_entry(
                format!("t{i}").as_str(),
                "{}",
                true,
                None,
                None,
                Some(i as u64),
                Some(i as u64),
                None,
                None,
                None,
                None,
                None,
            );
            write_audit_log(&dir, &e).expect("write");
        }
        let a = read_page(&dir, 1, 50).expect("read a");
        let b = read_page(&dir, 1, 50).expect("read b");
        assert_eq!(a.entries.len(), b.entries.len());
        assert_eq!(a.total, b.total);
        assert_eq!(a.entries[0].tool, b.entries[0].tool);

        // 追加一条 → len 变化 → 缓存失效 → total 变为 4
        let e4 = new_entry(
            "t3",
            "{}",
            true,
            None,
            None,
            Some(3),
            Some(3),
            None,
            None,
            None,
            None,
            None,
        );
        write_audit_log(&dir, &e4).expect("write 4");
        let c = read_page(&dir, 1, 50).expect("read c");
        assert_eq!(c.total, 4);
        assert_eq!(c.entries[0].tool, "t3");
        let _ = clear_all(&dir);
    }

    /// 测试用：写一行最小合法的审计 JSON。`pad` 用来把单条撑胖，好让测试能轻松
    /// 造出超过 `TAIL_WINDOW` 的文件。
    fn tail_line(tool: &str, pad: usize) -> String {
        format!(
            r#"{{"timestamp":"2026-08-06T10:00:00+08:00","tool":"{tool}","params":"{}","success":true}}"#,
            "x".repeat(pad)
        )
    }

    /// 基本行为：最新在前、取满 n 条，与 `read_page` 排序一致。
    #[test]
    fn tail_returns_newest_first() {
        let dir = tmp_data_dir("tail-order");
        let _ = std::fs::remove_file(dir.join("audit.log"));
        let body: String = (0..5)
            .map(|i| format!("{}\n", tail_line(&format!("t{i}"), 0)))
            .collect();
        std::fs::write(dir.join("audit.log"), body).expect("write");

        let got = read_recent_tail(&dir, 3).expect("tail");
        let tools: Vec<&str> = got.iter().map(|e| e.tool.as_str()).collect();
        assert_eq!(tools, vec!["t4", "t3", "t2"], "应当最新在前且只取 3 条");
        let _ = std::fs::remove_file(dir.join("audit.log"));
    }

    /// 文件不存在 → 空列表而非 Err。首次启动就是这个状态，报错会让连接页无缘无故弹错。
    #[test]
    fn tail_missing_file_is_empty_not_error() {
        let dir = tmp_data_dir("tail-missing");
        let _ = std::fs::remove_file(dir.join("audit.log"));
        let _ = std::fs::remove_file(dir.join("audit.log"));
        assert_eq!(read_recent_tail(&dir, 3).expect("ok").len(), 0);
    }

    /// 🔴 核心保障：文件远大于窗口时，仍能拿到正确的最后几条。
    ///
    /// 这正是本函数存在的意义——如果这里挂了，说明它退化成了全量读或读错位置。
    #[test]
    fn tail_reads_only_window_of_large_file() {
        let dir = tmp_data_dir("tail-large");
        let _ = std::fs::remove_file(dir.join("audit.log"));
        // 每条 ~1KB × 40 条 ≈ 40KB，远超 8KB 窗口。
        let body: String = (0..40)
            .map(|i| format!("{}\n", tail_line(&format!("tool{i:02}"), 1000)))
            .collect();
        assert!(
            body.len() as u64 > TAIL_WINDOW * 4,
            "构造的文件必须远大于窗口"
        );
        std::fs::write(dir.join("audit.log"), body).expect("write");

        let got = read_recent_tail(&dir, 3).expect("tail");
        let tools: Vec<&str> = got.iter().map(|e| e.tool.as_str()).collect();
        assert_eq!(tools, vec!["tool39", "tool38", "tool37"]);
        let _ = std::fs::remove_file(dir.join("audit.log"));
    }

    /// 写到一半的最后一行（追加写的真实情形）必须被静默跳过，而不是报错或返回空。
    #[test]
    fn tail_skips_half_written_last_line() {
        let dir = tmp_data_dir("tail-partial");
        let _ = std::fs::remove_file(dir.join("audit.log"));
        let body = format!(
            "{}\n{}\n{{\"timestamp\":\"2026-08-06T10:00",
            tail_line("good1", 0),
            tail_line("good2", 0)
        );
        std::fs::write(dir.join("audit.log"), body).expect("write");

        let got = read_recent_tail(&dir, 5).expect("tail");
        let tools: Vec<&str> = got.iter().map(|e| e.tool.as_str()).collect();
        assert_eq!(
            tools,
            vec!["good2", "good1"],
            "半条 JSON 应被跳过，不影响其余"
        );
        let _ = std::fs::remove_file(dir.join("audit.log"));
    }

    /// 中文路径（多字节 UTF-8）在窗口边界被切开时，不能 panic，也不能把乱码
    /// 泄露到返回值里——替换字符只允许出现在那条被丢弃的首行中。
    #[test]
    fn tail_handles_utf8_split_at_window_edge() {
        let dir = tmp_data_dir("tail-utf8");
        let _ = std::fs::remove_file(dir.join("audit.log"));
        // 用中文填充把文件撑过窗口，保证 8KB 偏移大概率落在某个三字节字符中间。
        let zh = "中文路径".repeat(200); // 4 字 × 3B × 200 = 2400B
        let body: String = (0..12)
            .map(|i| {
                format!(
                    r#"{{"timestamp":"2026-08-06T10:00:00+08:00","tool":"zh{i:02}","params":"{zh}","success":true}}"#
                ) + "\n"
            })
            .collect();
        std::fs::write(dir.join("audit.log"), body).expect("write");

        let got = read_recent_tail(&dir, 2).expect("tail");
        let tools: Vec<&str> = got.iter().map(|e| e.tool.as_str()).collect();
        assert_eq!(tools, vec!["zh11", "zh10"]);
        for e in &got {
            assert!(
                !e.params.contains('\u{FFFD}'),
                "返回的条目里不得含有 UTF-8 替换字符"
            );
        }
        let _ = std::fs::remove_file(dir.join("audit.log"));
    }

    /// n 必须被 clamp：传 0 不能返回空，传大值不能把它变回全量读。
    #[test]
    fn tail_clamps_n() {
        let dir = tmp_data_dir("tail-clamp");
        let _ = std::fs::remove_file(dir.join("audit.log"));
        let body: String = (0..30)
            .map(|i| format!("{}\n", tail_line(&format!("c{i:02}"), 0)))
            .collect();
        std::fs::write(dir.join("audit.log"), body).expect("write");

        assert_eq!(
            read_recent_tail(&dir, 0).expect("n=0").len(),
            1,
            "0 应 clamp 到 1"
        );
        assert_eq!(
            read_recent_tail(&dir, 9999).expect("n=9999").len(),
            20,
            "大值应 clamp 到 20"
        );
        let _ = std::fs::remove_file(dir.join("audit.log"));
    }
}
