//! 请求日志：内存环形（供界面）+ 按天 JSONL（供排障）。
//!
//! 两条存储各有分工，都不是装饰：
//!
//! - **内存环形**回答「刚才那几条怎么样了」。界面每两秒拉一次，量必须可控，
//!   所以上限固定 5000 行（`relay_log_keep`，不暴露给用户）。
//! - **JSONL** 回答「昨天下午那次 429 是什么」。按天分文件，启动时清掉超期的整份
//!   文件——不原地改写，读方的偏移不会失效（同 `journal.rs` 的做法）。
//!
//! **默认不记 body**（§4.10 第 4 条）。这条不是省事：那 937KB 的日志就是教训。
//! 需要看 body 时走 debug 开关，且界面要标体积风险。
//!
//! 请求是「开始时插入一条 in-flight、流结束时回填」的两段式。这样做是因为 SSE 可能
//! 持续几分钟——若等流结束才写日志，界面在整段时间里都看不到这条请求，
//! 而人恰恰是在那段时间里去查「卡住了没有」。

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(test)]
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};

use super::usage::{TokenUsage, UsageCollectionIssue};

/// 日志保留天数（磁盘）。
pub(crate) const DISK_RETENTION_DAYS: u32 = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureStage {
    ClientSource,
    ClientToken,
    ClientBlocked,
    Request,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientResult {
    pub status: u16,
    pub request_id: Option<String>,
    pub failure_stage: Option<FailureStage>,
    pub failed: bool,
}

/// 一条请求记录。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayLogEntry {
    pub id: u64,
    #[serde(skip)]
    pub(super) started_at: Option<Instant>,
    #[serde(default)]
    pub request_id: Option<String>,
    /// UTC 毫秒。界面按本地时区显示（§4.11「日志时间基准」）。
    pub ts_ms: i64,
    /// `local`（回环）或来源 IP。
    pub source: String,
    /// 客户端请求的原始模型名（去掉私有后缀后）。
    pub client_model: String,
    pub tier: String,
    pub upstream_model: String,
    #[serde(default)]
    pub upstream_provider: Option<String>,
    #[serde(default)]
    pub upstream_key: Option<String>,
    #[serde(default)]
    pub upstream_config_id: Option<String>,
    #[serde(default)]
    pub upstream_config_name: Option<String>,
    #[serde(default)]
    pub failure_stage: Option<FailureStage>,
    /// 上游在响应里自报的模型名。**真实**跑了什么，只有这里能看到。
    #[serde(default)]
    pub reported_model: Option<String>,
    /// 响应里我们回填给客户端的名字（正常应等于 `client_model`）。
    ///
    /// 与 `reported_model` 一起构成三元组：请求名 / 上游名 / 上报名。前两个是
    /// 「我要什么、实际给了什么」，第三个是「我告诉客户端给了什么」。
    #[serde(default)]
    pub response_model: Option<String>,
    /// 模型名回填的结果。`None` = 这条路径不需要回填（错误响应、count_tokens
    /// 或 OpenAI 方言）。`Some(..)` 里非 `Rewritten` 的都是降级——客户端看到了
    /// 上游真名，原因记在这里。
    #[serde(default)]
    pub model_rewrite: Option<super::model_rewrite::ModelRewrite>,
    /// 上游自报的名字与「请求名 / 上游名」都对不上——上游换了模型。
    ///
    /// 判定只容忍写法差异（大小写、`vendor/` 前缀、日期快照、`-latest`、
    /// 版本分隔符），型号不同就一定为 true。见 `model_rewrite::is_substituted`。
    #[serde(default)]
    pub model_mismatch: bool,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
    #[serde(default)]
    pub usage_collection_issue: Option<UsageCollectionIssue>,
    /// 该档未配置、请求落到 default。
    pub fell_back: bool,
    /// 命中方式：alias / override / keyword / fallback。
    pub via: String,
    /// 触发过的改写：`fold` / `strip_suffix` / `clamp` 或组合。
    pub rewrite: Option<String>,
    /// 折叠摘要，含 `messages[i].content[j]` 路径。
    pub fold_summary: Option<String>,
    /// schema 正则归一化摘要（`\0` → `\x00` 的位置）。与折叠摘要分开记：
    /// 折叠动了消息结构，这个只换了正则的写法，排障时不能混。
    #[serde(default)]
    pub schema_summary: Option<String>,
    /// 是否被折叠过（响应头 `x-relay-sanitized` 与界面徽章用）。
    pub sanitized: bool,
    /// 上游状态码。in-flight 时为 `None`。
    pub status: Option<u16>,
    /// 首字节耗时（TTFB 的真实指标，比总耗时有意义）。
    pub first_byte_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub bytes_in: Option<u64>,
    pub bytes_out: Option<u64>,
    /// 失败原因（上游错误摘要或本地错误）。密钥已打码。
    pub error: Option<String>,
    /// 上游 4xx/5xx 的**响应体原文**（截断到 4KB）。
    ///
    /// 与 `error` 分开：`error` 是「哪里断了」的一句话，这里是上游自己说的话。
    /// 之前的实现不带它，于是「`is not a "regex"`」这类唯一能定位问题的信息
    /// 只存在于客户端界面的截图里，中转日志里只剩一个 400。
    #[serde(default)]
    pub upstream_error: Option<String>,
    /// 请求路径，目前是 `/v1/messages` 或 `/v1/messages/count_tokens`。
    pub path: String,
}

impl RelayLogEntry {
    pub fn is_error(&self) -> bool {
        self.status.is_some_and(|s| s >= 400) || self.error.is_some()
    }

    pub fn is_in_flight(&self) -> bool {
        self.status.is_none() && self.error.is_none()
    }
}

/// 流结束时回填的字段。
#[derive(Clone, Debug, Default)]
pub struct LogPatch {
    pub status: Option<u16>,
    pub first_byte_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub bytes_out: Option<u64>,
    pub error: Option<String>,
    /// 见 `RelayLogEntry::upstream_error`。
    pub upstream_error: Option<String>,
    /// 自愈重试追加的改写（`repair:clamp` 等）。首次清清洗的结果在 `begin`
    /// 时就写进了 entry，这里只补重试那一次新增的部分。
    pub rewrite: Option<String>,
    pub reported_model: Option<String>,
    pub response_model: Option<String>,
    pub model_rewrite: Option<super::model_rewrite::ModelRewrite>,
    pub model_mismatch: Option<bool>,
    pub usage: Option<TokenUsage>,
    pub usage_collection_issue: Option<UsageCollectionIssue>,
}

/// 今日 / 全部聚合，给四张指标卡与档位分布。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStats {
    pub today_requests: u64,
    pub today_folded: u64,
    pub today_errors: u64,
    /// 0–100。
    pub today_error_rate: f64,
    pub first_byte_p50_ms: Option<u64>,
    pub first_byte_p95_ms: Option<u64>,
    pub avg_total_ms: Option<u64>,
    /// 三档命中数（今日）。
    pub tier_hits: Vec<TierHit>,
    pub last_error: Option<String>,
    pub last_error_at_ms: Option<i64>,
    /// 当前是否还有请求在飞。
    pub in_flight: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierHit {
    pub tier: String,
    pub count: u64,
    /// 其中「该档未配置、落到 default」的数量。灰色横条用。
    pub fell_back: u64,
}

struct Inner {
    entries: VecDeque<RelayLogEntry>,
    evicted_pending: HashMap<u64, RelayLogEntry>,
    next_id: u64,
    latest_client_result: Option<(Instant, u64, ClientResult)>,
    last_client_success: Option<Instant>,
}

impl Inner {
    fn record_client_result(&mut self, entry: &RelayLogEntry) {
        if entry.error.as_deref() == Some("客户端提前断开") {
            return;
        }
        let (Some(at), Some(status)) = (entry.started_at, entry.status) else {
            return;
        };
        let generation = entry.path == "/v1/messages";
        // Claude Code may call count_tokens before it sends its first generation request.
        if !generation && !entry.is_error() {
            return;
        }
        if self
            .latest_client_result
            .as_ref()
            .is_none_or(|(last, id, _)| (at, entry.id) >= (*last, *id))
        {
            self.latest_client_result = Some((
                at,
                entry.id,
                ClientResult {
                    status,
                    request_id: entry.request_id.clone(),
                    failure_stage: entry.failure_stage,
                    failed: entry.is_error(),
                },
            ));
        }
        if generation && (200..300).contains(&status) && !entry.is_error() {
            self.last_client_success =
                Some(self.last_client_success.map_or(at, |last| last.max(at)));
        }
    }
}

struct DiskWriter {
    day: String,
    file: Option<File>,
}

/// 日志仓库。内部用 `std::sync::Mutex`：临界区只有几十微秒，且不跨 await。
pub struct RelayLog {
    inner: Mutex<Inner>,
    keep: usize,
    dir: Option<PathBuf>,
    disk: Mutex<Option<DiskWriter>>,
}

impl RelayLog {
    /// `dir` 为 `None` 时只用内存（单元测试与「不想落盘」的场景）。
    pub fn new(keep: usize, dir: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: VecDeque::new(),
                evicted_pending: HashMap::new(),
                next_id: 1,
                latest_client_result: None,
                last_client_success: None,
            }),
            keep: keep.max(1),
            dir,
            disk: Mutex::new(None),
        }
    }

    /// 插入请求。如果已知最终状态（例如本地鉴权拒绝），直接记录结果。
    pub fn begin(&self, mut entry: RelayLogEntry) -> u64 {
        entry.request_id = Some(uuid::Uuid::new_v4().to_string());
        entry.started_at.get_or_insert_with(Instant::now);
        entry.ts_ms = if entry.ts_ms == 0 {
            Local::now().timestamp_millis()
        } else {
            entry.ts_ms
        };
        let id = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            // A burst of identical local rejections should not crowd out the useful log rows.
            if let Some(
                stage @ (FailureStage::ClientSource
                | FailureStage::ClientToken
                | FailureStage::ClientBlocked),
            ) = entry.failure_stage
            {
                if let Some(previous) = inner
                    .entries
                    .iter()
                    .take_while(|row| entry.ts_ms.saturating_sub(row.ts_ms) < 2_000)
                    .take(24)
                    .find(|row| {
                        row.failure_stage == Some(stage)
                            && row.source == entry.source
                            && row.path == entry.path
                    })
                    .cloned()
                {
                    entry.id = previous.id;
                    entry.request_id = previous.request_id;
                    inner.record_client_result(&entry);
                    return previous.id;
                }
            }
            let id = inner.next_id;
            inner.next_id += 1;
            entry.id = id;
            inner.record_client_result(&entry);
            // 新的在前：界面只读最近几条，不必反转
            inner.entries.push_front(entry.clone());
            while inner.entries.len() > self.keep {
                if let Some(old) = inner.entries.pop_back().filter(RelayLogEntry::is_in_flight) {
                    // A long stream can outlive a full rotation of the recent-request list.
                    inner.evicted_pending.insert(old.id, old);
                }
            }
            id
        };
        // 落盘放在锁外：文件 IO 比内存操作慢几个数量级，不能占着环形缓冲的锁。
        // in-flight 记录也写一行，流中断时至少能看到「发出去了」。
        self.append_disk(&entry);
        id
    }

    /// 回填结果。
    pub fn finish(&self, id: u64, patch: LogPatch) {
        let updated = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let updated = if let Some(entry) = inner.entries.iter_mut().find(|e| e.id == id) {
                apply_patch(entry, patch);
                entry.clone()
            } else if let Some(mut entry) = inner.evicted_pending.remove(&id) {
                apply_patch(&mut entry, patch);
                entry
            } else {
                return;
            };
            inner.record_client_result(&updated);
            updated
        };
        self.append_disk_final(&updated);
    }

    /// 最近 `n` 条（新的在前）。
    pub fn recent(&self, n: usize) -> Vec<RelayLogEntry> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.iter().take(n).cloned().collect()
    }

    pub(super) fn client_state_since(&self, since: Instant) -> (bool, Option<ClientResult>) {
        let inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        (
            inner.last_client_success.is_some_and(|at| at >= since),
            inner
                .latest_client_result
                .as_ref()
                .filter(|(at, _, _)| *at >= since)
                .map(|(_, _, result)| result.clone()),
        )
    }

    /// Seven local calendar days, with final records replacing their matching begin lines.
    pub fn history(&self) -> std::io::Result<Vec<RelayLogEntry>> {
        let today = Local::now().date_naive();
        let first_day = today - chrono::Days::new(6);
        let mut entries = HashMap::new();
        if let Some(dir) = &self.dir {
            // A request can finish in a different day's file from its begin record.
            for offset in 0..7 {
                let date = first_day + chrono::Days::new(offset);
                let path = day_file(dir, &date.format("%Y%m%d").to_string());
                let file = match File::open(path) {
                    Ok(file) => file,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(err) => return Err(err),
                };
                for line in BufReader::new(file).lines() {
                    if let Ok(entry) = serde_json::from_str::<RelayLogEntry>(&line?) {
                        entries.insert(history_key(&entry), entry);
                    }
                }
            }
        }

        let mut pending = HashSet::new();
        {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            for entry in inner.entries.iter().chain(inner.evicted_pending.values()) {
                let key = history_key(entry);
                if entry.is_in_flight() {
                    pending.insert(key.clone());
                }
                entries.insert(key, entry.clone());
            }
        }
        let mut history = Vec::new();
        for (key, mut entry) in entries {
            let date = Local
                .timestamp_millis_opt(entry.ts_ms)
                .single()
                .map(|d| d.date_naive());
            if !date.is_some_and(|date| (first_day..=today).contains(&date)) {
                continue;
            }
            if entry.is_in_flight() && !pending.contains(&key) {
                entry.error = Some("请求结束前未记录到结果".into());
            }
            history.push(entry);
        }
        history.sort_unstable_by_key(|entry| Reverse((entry.ts_ms, entry.id)));
        Ok(history)
    }

    /// 全部条目数。
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .len()
    }

    /// 与 `len` 配套。空日志是正常状态（刚启动），不是异常——
    /// 所以调用方该用它判空，而不是 `len() == 0`。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(crate) fn in_flight_count(&self) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .entries
            .iter()
            .chain(inner.evicted_pending.values())
            .filter(|entry| entry.is_in_flight())
            .count()
    }

    /// 今日聚合。`now_ms` 与 `day_start_ms` 由调用方给，以便测试确定性。
    pub fn stats_for(&self, day_start_ms: i64) -> RelayStats {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        build_stats(
            inner.entries.iter().chain(inner.evicted_pending.values()),
            day_start_ms,
        )
    }

    /// 今日聚合，按本地时区的零点算边界。
    ///
    /// 用 `chrono::Local` 而不是 UTC：用户看的是自己墙上钟的「今天」，
    /// 用 UTC 会让 08:00 之前的请求算到昨天（UTC+8）。
    pub fn stats_today(&self) -> RelayStats {
        self.stats_for(local_day_start_ms())
    }

    fn append_disk(&self, entry: &RelayLogEntry) {
        let Some(dir) = self.dir.as_ref() else { return };
        let Some(line) = serde_json::to_string(entry).ok() else {
            return;
        };
        self.write_line(dir, &line);
    }

    fn append_disk_final(&self, entry: &RelayLogEntry) {
        // 完成行多一个标记，读的时候能区分「进行中」与「已结束」的两行。
        let Some(dir) = self.dir.as_ref() else { return };
        let mut value = match serde_json::to_value(entry) {
            Ok(v) => v,
            Err(_) => return,
        };
        if let Some(obj) = value.as_object_mut() {
            obj.insert("final".into(), serde_json::Value::Bool(true));
        }
        if let Ok(line) = serde_json::to_string(&value) {
            self.write_line(dir, &line);
        }
    }

    fn write_line(&self, dir: &Path, line: &str) {
        let day = Local::now().format("%Y%m%d").to_string();
        let mut guard = self.disk.lock().unwrap_or_else(|e| e.into_inner());
        // 换天时重开文件；其余时间复用句柄，避免每条日志都 open/close。
        let need_reopen = guard.as_ref().is_none_or(|w| w.day != day);
        if need_reopen {
            let path = day_file(dir, &day);
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok();
            *guard = Some(DiskWriter { day, file });
        }
        if let Some(writer) = guard.as_mut() {
            if let Some(f) = writer.file.as_mut() {
                // 写失败不 panic：日志不是业务路径，磁盘满不该让请求失败。
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

fn history_key(entry: &RelayLogEntry) -> String {
    entry
        .request_id
        .clone()
        .unwrap_or_else(|| format!("{}:{}", entry.ts_ms, entry.id))
}

fn apply_patch(entry: &mut RelayLogEntry, patch: LogPatch) {
    entry.status = patch.status.or(entry.status);
    entry.first_byte_ms = patch.first_byte_ms.or(entry.first_byte_ms);
    entry.total_ms = patch.total_ms.or(entry.total_ms);
    entry.bytes_out = patch.bytes_out.or(entry.bytes_out);
    entry.error = patch.error.or(entry.error.take());
    entry.upstream_error = patch.upstream_error.or(entry.upstream_error.take());
    entry.rewrite = match (patch.rewrite, entry.rewrite.take()) {
        // 自愈重试发生在首次清洗之后，两次改写要拼起来而不是覆盖。
        (Some(repair), Some(first)) => Some(format!("{first}+{repair}")),
        (Some(repair), None) => Some(repair),
        (None, existing) => existing,
    };
    entry.reported_model = patch.reported_model.or(entry.reported_model.take());
    entry.response_model = patch.response_model.or(entry.response_model.take());
    entry.model_rewrite = patch.model_rewrite.or(entry.model_rewrite);
    entry.model_mismatch = patch.model_mismatch.unwrap_or(entry.model_mismatch);
    entry.usage = patch.usage.or(entry.usage.take());
    entry.usage_collection_issue = patch
        .usage_collection_issue
        .or(entry.usage_collection_issue);
}

fn day_file(dir: &Path, day: &str) -> PathBuf {
    dir.join(format!("relay-{day}.jsonl"))
}

/// 本地时区「今天零点」的 epoch 毫秒。
pub fn local_day_start_ms() -> i64 {
    let now = Local::now();
    let Some(naive) = now.date_naive().and_hms_opt(0, 0, 0) else {
        return 0;
    };
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp_millis())
        // DST 边界上零点可能不存在（极少数时区），退化成「24 小时前」，
        // 宁可少算几小时也不要整块统计归零。
        .unwrap_or_else(|| now.timestamp_millis() - 86_400_000)
}

fn build_stats<'a>(
    entries: impl Iterator<Item = &'a RelayLogEntry>,
    day_start_ms: i64,
) -> RelayStats {
    let mut stats = RelayStats {
        tier_hits: ["default", "haiku", "opus"]
            .into_iter()
            .map(|tier| TierHit {
                tier: tier.to_string(),
                count: 0,
                fell_back: 0,
            })
            .collect(),
        ..RelayStats::default()
    };
    let mut first_bytes: Vec<u64> = Vec::new();
    let mut totals: Vec<u64> = Vec::new();

    for entry in entries {
        if entry.is_in_flight() {
            stats.in_flight += 1;
        }
        if entry.ts_ms < day_start_ms {
            continue;
        }
        stats.today_requests += 1;
        if entry.sanitized {
            stats.today_folded += 1;
        }
        if entry.is_error() {
            stats.today_errors += 1;
            // 只在「今天」范围内取最后一条错误
            if stats.last_error_at_ms.is_none_or(|ts| entry.ts_ms >= ts) {
                stats.last_error_at_ms = Some(entry.ts_ms);
                stats.last_error = Some(entry.error.clone().unwrap_or_else(|| {
                    format!(
                        "上游返回 {}（{}）",
                        entry.status.unwrap_or(0),
                        entry.client_model
                    )
                }));
            }
        }
        if let Some(row) = stats.tier_hits.iter_mut().find(|r| r.tier == entry.tier) {
            row.count += 1;
            if entry.fell_back {
                row.fell_back += 1;
            }
        }
        if let Some(ms) = entry.first_byte_ms {
            first_bytes.push(ms);
        }
        if let Some(ms) = entry.total_ms {
            totals.push(ms);
        }
    }

    stats.today_error_rate = if stats.today_requests == 0 {
        0.0
    } else {
        (stats.today_errors as f64) * 100.0 / (stats.today_requests as f64)
    };
    stats.first_byte_p50_ms = percentile(&mut first_bytes, 50);
    stats.first_byte_p95_ms = percentile(&mut first_bytes, 95);
    stats.avg_total_ms = if totals.is_empty() {
        None
    } else {
        Some(totals.iter().sum::<u64>() / totals.len() as u64)
    };
    stats
}

fn percentile(values: &mut [u64], p: u8) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    // 用 ceil 让 p50 落在「中间那个」而不是插值——界面显示的是整数毫秒，
    // 插值出来的 412.5 只会被四舍五入回去，不如直接取样本。
    let idx = ((values.len() as f64 - 1.0) * (p as f64 / 100.0)).round() as usize;
    values.get(idx.min(values.len() - 1)).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts_ms: i64, status: Option<u16>) -> RelayLogEntry {
        RelayLogEntry {
            id: 0,
            ts_ms,
            source: "local".into(),
            client_model: "claude-sonnet-5-5".into(),
            tier: "default".into(),
            upstream_model: "qwen4-max-preview".into(),
            fell_back: false,
            via: "alias".into(),
            rewrite: None,
            fold_summary: None,
            sanitized: false,
            status,
            first_byte_ms: None,
            total_ms: None,
            bytes_in: Some(100),
            bytes_out: None,
            error: None,
            path: "/v1/messages".into(),
            ..RelayLogEntry::default()
        }
    }

    fn log() -> RelayLog {
        RelayLog::new(3, None)
    }

    #[test]
    fn begin_then_finish_fills_the_same_row() {
        let log = log();
        let id = log.begin(entry(1_000, None));
        assert_eq!(log.len(), 1);
        assert!(log.recent(1)[0].is_in_flight());

        log.finish(
            id,
            LogPatch {
                status: Some(200),
                first_byte_ms: Some(120),
                total_ms: Some(900),
                bytes_out: Some(2048),
                error: None,
                ..LogPatch::default()
            },
        );
        let row = &log.recent(1)[0];
        assert_eq!(row.status, Some(200));
        assert_eq!(row.first_byte_ms, Some(120));
        assert!(!row.is_in_flight());
    }

    #[test]
    fn in_flight_count_preserves_evicted_requests() {
        let log = RelayLog::new(1, None);
        let first = log.begin(entry(1, None));
        let second = log.begin(entry(2, None));
        assert_eq!(log.in_flight_count(), 2);
        for id in [first, second] {
            log.finish(
                id,
                LogPatch {
                    status: Some(200),
                    ..LogPatch::default()
                },
            );
        }
        assert_eq!(log.in_flight_count(), 0);
    }

    #[test]
    fn verification_ignores_earlier_requests_that_finish_late_and_token_probes() {
        let log = RelayLog::new(1, None);
        let since = Instant::now();
        let before = |path: &str, at: Instant| RelayLogEntry {
            path: path.to_string(),
            started_at: Some(at),
            ..entry(0, None)
        };
        let old = log.begin(before(
            "/v1/messages",
            since - std::time::Duration::from_millis(1),
        ));
        let current = log.begin(before("/v1/messages", since));
        let count = log.begin(before("/v1/messages/count_tokens", since));
        for (id, status) in [(current, 429), (old, 200), (count, 200)] {
            log.finish(
                id,
                LogPatch {
                    status: Some(status),
                    ..LogPatch::default()
                },
            );
        }
        let (verified, result) = log.client_state_since(since);
        assert!(!verified);
        assert_eq!(result.unwrap().status, 429);

        let success = log.begin(before("/v1/messages", since));
        log.finish(
            success,
            LogPatch {
                status: Some(200),
                ..LogPatch::default()
            },
        );
        let (verified, result) = log.client_state_since(since);
        assert!(verified);
        assert_eq!(result.unwrap().status, 200);

        let failed_probe = log.begin(before("/v1/messages/count_tokens", since));
        log.finish(
            failed_probe,
            LogPatch {
                status: Some(429),
                ..LogPatch::default()
            },
        );
        let (verified, result) = log.client_state_since(since);
        assert!(
            verified,
            "a probe does not change the earlier model verification"
        );
        assert_eq!(
            result.unwrap().status,
            429,
            "failed token probes still need a diagnosis"
        );
    }

    #[test]
    fn ring_buffer_respects_keep_limit() {
        let log = log();
        for i in 0..10 {
            log.begin(entry(1_000 + i, Some(200)));
        }
        assert_eq!(log.len(), 3, "稳态行数必须有上限");
        // 新的在前
        assert!(log.recent(1)[0].ts_ms > log.recent(3)[2].ts_ms);
    }

    #[test]
    fn stats_only_count_today() {
        let log = log();
        let day_start = 1_000_000;
        log.begin(entry(day_start - 1, Some(200)));
        log.begin(entry(day_start + 10, Some(200)));
        log.begin(entry(day_start + 20, Some(429)));
        let stats = log.stats_for(day_start);
        assert_eq!(stats.today_requests, 2, "昨天的不能算进来");
        assert_eq!(stats.today_errors, 1);
        assert!((stats.today_error_rate - 50.0).abs() < f64::EPSILON);
        assert!(stats.last_error.is_some());
    }

    #[test]
    fn tier_hits_track_fall_back() {
        let log = log();
        let mut a = entry(100, Some(200));
        a.tier = "haiku".into();
        a.fell_back = true;
        log.begin(a);
        log.begin(entry(200, Some(200)));
        let stats = log.stats_for(0);
        let haiku = stats.tier_hits.iter().find(|t| t.tier == "haiku").unwrap();
        let default = stats
            .tier_hits
            .iter()
            .find(|t| t.tier == "default")
            .unwrap();
        assert_eq!((haiku.count, haiku.fell_back), (1, 1));
        assert_eq!((default.count, default.fell_back), (1, 0));
    }

    #[test]
    fn folded_and_sanitized_are_counted() {
        let log = log();
        let mut a = entry(100, Some(200));
        a.sanitized = true;
        a.rewrite = Some("fold".into());
        log.begin(a);
        let stats = log.stats_for(0);
        assert_eq!(stats.today_folded, 1);
    }

    #[test]
    fn percentile_picks_real_samples() {
        let mut values = vec![10, 20, 30, 40, 50];
        assert_eq!(percentile(&mut values, 50), Some(30));
        let mut values = vec![100, 200, 300, 400];
        assert_eq!(percentile(&mut values, 95), Some(400));
        assert_eq!(percentile(&mut [], 50), None);
    }

    #[test]
    fn day_start_is_local_midnight() {
        // 只断言它落在「今天」范围内且不晚于现在——具体值随运行时时区变化。
        let start = local_day_start_ms();
        let now = Local::now().timestamp_millis();
        assert!(start <= now);
        assert!(now - start < 86_400_000 + 3_600_000);
    }

    #[test]
    fn disk_log_is_written_per_day() {
        let dir = std::env::temp_dir().join(format!("relay-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = RelayLog::new(100, Some(dir.clone()));
        let id = log.begin(entry(0, None));
        log.finish(
            id,
            LogPatch {
                status: Some(200),
                ..LogPatch::default()
            },
        );
        let day = Local::now().format("%Y%m%d").to_string();
        let path = day_file(&dir, &day);
        let text = fs::read_to_string(&path).expect("日志文件应存在");
        assert_eq!(text.lines().count(), 2, "in-flight 与完成各一行");
        assert!(text.contains("\"final\":true"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_keeps_usage_after_rotation_and_process_restart() {
        let dir = std::env::temp_dir().join(format!("relay-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let log = RelayLog::new(1, Some(dir.clone()));
        let first = log.begin(entry(0, None));
        let second = log.begin(entry(0, None));
        log.finish(
            first,
            LogPatch {
                status: Some(200),
                usage: Some(TokenUsage {
                    input: Some(40),
                    output: Some(0),
                    ..TokenUsage::default()
                }),
                ..LogPatch::default()
            },
        );
        log.finish(
            second,
            LogPatch {
                status: Some(429),
                ..LogPatch::default()
            },
        );
        assert_eq!(log.recent(5).len(), 1);
        drop(log);

        let restarted = RelayLog::new(1, Some(dir.clone()));
        assert_eq!(restarted.begin(entry(0, None)), first);
        let history = restarted.history().unwrap();
        assert_eq!(
            history.len(),
            3,
            "begin/final pairs are deduplicated without conflating process IDs"
        );
        assert_eq!(history.iter().filter(|row| row.is_in_flight()).count(), 1);
        let usage = history.iter().find_map(|row| row.usage.as_ref()).unwrap();
        assert_eq!((usage.input, usage.output), (Some(40), Some(0)));
        drop(restarted);
        fs::remove_dir_all(dir).unwrap();
    }
}
