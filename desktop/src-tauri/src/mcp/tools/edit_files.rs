use std::sync::Arc;

use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::backup;
use crate::diff_utils;
use crate::encoding;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct EditEntry {
    pub path: String,
    #[serde(rename = "oldString")]
    pub old_string: String,
    #[serde(rename = "newString")]
    pub new_string: String,
    #[serde(default, rename = "replaceAll")]
    pub replace_all: bool,
    /// 显式编码（如 `"gbk"`、`"gb18030"`、`"utf-16le"`）：按它读、也按它写回，
    /// **绕过**服务端「编码自动识别」开关——GBK 项目里不必为了改一个文件去改全局设置。
    /// 省略时行为不变（开关关 → 按 UTF-8 读，与 `read_files` 同口径）。
    #[serde(default)]
    pub encoding: Option<String>,
    /// 期望的出现次数：实际次数不等时**不写盘**，错误里给实际次数与前几处行号。
    ///
    /// WHY：模型改代码前最想确认的就是「这段原文是不是恰好出现 N 次」，没有这个参数时
    /// 只能手写 `assert s.count(a) == N` 的脚本绕路。它是**断言**，不改变替换规则：
    /// 是否全替换仍由 `replaceAll` 决定。
    #[serde(default, rename = "expectCount")]
    pub expect_count: Option<usize>,
}

/// 分组形态的内部 edit 项：{oldString, newString, replaceAll?, encoding?, expectCount?}
/// （path 由外层提供）。
#[derive(Debug, Deserialize)]
struct GroupedEdit {
    #[serde(rename = "oldString")]
    old_string: String,
    #[serde(rename = "newString")]
    new_string: String,
    #[serde(default, rename = "replaceAll")]
    replace_all: bool,
    #[serde(default)]
    encoding: Option<String>,
    #[serde(default, rename = "expectCount")]
    expect_count: Option<usize>,
}

/// 客户端实际发过的两种 item 形态（untagged 按序尝试）：
/// - Flat：{path, oldString, newString, replaceAll?} —— 即 [`EditEntry`] 本身；
/// - Grouped：{path, edits: [{oldString, newString, ...}, ...]} —— 按文件分组
///   （审计实锤，native Edit 语义下模型容易这么组织）。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FlexEditItem {
    Flat(EditEntry),
    Grouped {
        path: String,
        edits: Vec<GroupedEdit>,
    },
}

/// `files` 字段的容错反序列化：接受数组 / JSON 字符串化的数组（审计实锤：
/// `{"edits": "[{...}]"}`），item 兼容 Flat 与 Grouped 两种形态，Grouped 展平为逐条 EditEntry。
fn flex_edit_files<'de, D>(deserializer: D) -> Result<Vec<EditEntry>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let arr: Vec<serde_json::Value> = match value {
        arr @ serde_json::Value::Array(_) => {
            serde_json::from_value(arr).map_err(serde::de::Error::custom)?
        }
        serde_json::Value::String(s) => {
            let parsed: serde_json::Value = serde_json::from_str(s.trim())
                .map_err(|e| serde::de::Error::custom(format!("参数是字符串但解不出 JSON：{e}")))?;
            serde_json::from_value(parsed).map_err(serde::de::Error::custom)?
        }
        _ => {
            return Err(serde::de::Error::custom(
                "期望 files 数组（或 JSON 字符串化的数组）",
            ))
        }
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        match serde_json::from_value::<FlexEditItem>(item).map_err(serde::de::Error::custom)? {
            FlexEditItem::Flat(e) => out.push(e),
            FlexEditItem::Grouped { path, edits } => {
                for e in edits {
                    out.push(EditEntry {
                        path: path.clone(),
                        old_string: e.old_string,
                        new_string: e.new_string,
                        replace_all: e.replace_all,
                        encoding: e.encoding,
                        expect_count: e.expect_count,
                    });
                }
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct EditFilesArgs {
    /// 容错见 [`flex_edit_files`]：字符串化数组 / `edits` 别名 / 按文件分组形态均可接受。
    #[serde(deserialize_with = "flex_edit_files", alias = "edits")]
    pub files: Vec<EditEntry>,
    /// 回显档位：`none` | `stat` | `hunks` | `full` | `auto`（省略 = `auto`，编辑场景落成 `hunks`）。
    /// 详见 [`crate::diff_utils::DiffMode`]。
    pub diff: Option<String>,
}

pub async fn handle(args: EditFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 与 write_files 一致：拼错档位整次拒绝，不静默回落。
    let mode = match args.diff.as_deref() {
        Some(raw) => diff_utils::DiffMode::parse(raw)?,
        None => diff_utils::DiffMode::Auto,
    };
    let config = state.config.read().await;
    let mut results = Vec::new();

    for f in &args.files {
        match edit_single(f, &config, state, mode).await {
            Ok(outcome) => {
                let mut row = json!({
                    "path": f.path,
                    "ok": true,
                    "replacements": outcome.replacements,
                    "encoding": outcome.encoding,
                    "newline": outcome.newline,
                    "warning": outcome.warning,
                });
                if let Some(d) = outcome.diff {
                    row["diff"] = json!(d);
                }
                results.push(row);
            }
            Err(e) => results.push(
                json!({ "path": f.path, "ok": false, "error": e.message, "warning": e.warning }),
            ),
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

struct EditOutcome {
    replacements: usize,
    encoding: String,
    newline: &'static str,
    /// `diff:"none"` 时为 `None`，结果里不出现该字段。
    diff: Option<String>,
    /// 对 old_string 的首尾空白告警（模型多带空白导致匹配失败时给的提示）。仅 Some 时输出。
    warning: Option<String>,
}

/// edit_single 的错误：携带可选的首尾空白告警，让匹配失败的提示更有指导性。
struct EditError {
    message: String,
    warning: Option<String>,
}

impl From<String> for EditError {
    fn from(message: String) -> Self {
        Self {
            message,
            warning: None,
        }
    }
}

impl From<&str> for EditError {
    fn from(message: &str) -> Self {
        Self {
            message: message.to_string(),
            warning: None,
        }
    }
}

async fn edit_single(
    f: &EditEntry,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
    mode: diff_utils::DiffMode,
) -> Result<EditOutcome, EditError> {
    // 🔴 告警算在**归一化后**的串上。
    //
    // 算在原串上的后果：带 CRLF 的 `oldString` 现在能匹配成功了，却会在
    // **成功响应**里顶着一句“含 N 个回车符……去掉首尾空白后重试可避免匹配失败”。
    // 模型读到这句会以为还有风险、白发一轮重试——正是这条告警当初想省掉的往返。
    let warning = whitespace_warning(&crate::encoding::normalize_newlines(&f.old_string));
    if f.old_string.is_empty() {
        return Err(EditError {
            message: "oldString must not be empty".into(),
            warning: warning.clone(),
        });
    }
    // 🔴 newString 里的 `\r` 必须在碰文件之前就拦住。
    //
    // 不拦的话它会一路跑到 `encode_text` 的 round-trip 守卫那里被拒，
    // 而那条错误写的是「字符在本编码下无法表示」——**这句话是假的**：
    // `\r` 在 UTF-8 里当然表示得了。真实原因是回写时会把 `\n` 全量换成
    // `\r\n`，于是 newString 自带的 `\r\n` 变成 `\r\r\n`。把人往编码方向引的
    // 错误诊断比没有诊断更坏，所以在这里给真话。
    //
    // 为什么不像 `oldString` 那样帮它归一化：匹配是**查询**，归一化只是把
    // 针和草垛放进同一个坐标系，不丢信息；而写入是**改写**，静默把调用方
    // 要求的 `\r\n` 换成别的东西，跟本模块“宁可拒写也不静默损坏”的原则相冲。
    if f.new_string.contains('\r') {
        return Err(EditError {
            message: "newString 含回车符 \\r。本工具在归一化为 LF 的文本上工作，回写时按文件原有行尾还原；\
                      保留 \\r 会让还原后出现 \\r\\r\\n。去掉 \\r、只用 \\n 即可——\
                      目标文件是 CRLF 时会自动还原成 CRLF。"
                .into(),
            warning: warning.clone(),
        });
    }

    // 🔴 把 `oldString` 按与文件内容**同一套规则**归一化再拿去匹配。
    //
    // 文件内容读进来就已经没有任何 `\r` 了，所以调用方传 `"a\r\nb"` 本来
    // **必然**匹配不上；而 `read_files` 又会在内容旁边报 `newline: "CRLF"`，
    // 恰好把人往这个坑里引。
    //
    // 归一化查询串不是“宽容”，是把针和草垛放进同一个坐标系：用户想匹配的
    // 那段字节确实在磁盘上，我们只是用文件自己的表示法去找它，零信息损失。
    // （“只匹配 CRLF 而不匹配 LF”这个能力今天本来就不存在，因为内容已归一化。）
    let needle = crate::encoding::normalize_newlines(&f.old_string);

    // 比的是**归一化后**的：`"a\r\nb"` → `"a\nb"` 对上 `"a\nb"` 也是空操作，
    // 按原串比会放它过去，然后报一次“成功替换”但文件一个字没变。
    if needle == f.new_string {
        return Err(EditError {
            message: "oldString and newString are identical, nothing to do".into(),
            warning: warning.clone(),
        });
    }

    // 显式编码先验标签，再碰文件：标签拼错时给「有哪些可用」而不是让 `read_text`
    // 报一句 Unknown encoding label 之后模型还要猜。
    if let Some(label) = f.encoding.as_deref() {
        if crate::encoding::label_to_encoding(label).is_none() {
            return Err(EditError {
                message: format!(
                    "未知编码 {label:?}。标签与 encoding_rs 一致，常用：utf-8 / gbk / gb18030 / big5 / \
                     utf-16le / utf-16be / latin1（也可以是 windows-1252 这类别名）。"
                ),
                warning: warning.clone(),
            });
        }
    }

    let resolved = security::path::resolve_safe_path_cached(
        &f.path,
        &state.cached_roots(),
        &config.exclude_patterns,
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;

    let lock = state
        .path_locks
        .entry(resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("File does not exist: {e}"))?;
    if metadata.is_dir() {
        return Err("path is a directory".into());
    }
    security::filesize::assert_file_size_ok(&resolved, config.max_file_size_bytes)?;

    // 读取原始字节，探测编码/换行/BOM，文本归一化到 LF 供匹配。
    let t0 = std::time::Instant::now();
    let raw = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Read error: {e}"))?;
    crate::timing::record_io(t0.elapsed());
    // 修复：之前这里无条件传 None，总是走自动探测，与 `read_files.rs` 不一致——后者会看
    // `config.encoding_detect_enabled`（默认关），关时强制按 UTF-8 读、不走 GBK/GB18030 启发式。两个工具对
    // 同一个文件可能得到不同的解码结果，导致“`read_files` 里看起来完全一样的内容，
    // `edit_files` 却匹配不到”这类诡异现象。现与 read_files.rs 保持同样的判断逻辑。
    //
    // 优先级：显式 `encoding` > 服务端开关 > UTF-8。显式值必须能盖住开关——这正是
    // 「NC 项目一堆 GBK 源码，但不想为改文件去改全局设置」的用法，否则这个参数没有意义。
    let effective_encoding: Option<&str> = match f.encoding.as_deref() {
        Some(label) => Some(label),
        None if config.encoding_detect_enabled => None,
        None => Some("utf-8"),
    };
    let ft = encoding::read_text(&raw, effective_encoding)?;
    let content = &ft.text;

    // 计数：只有需要精确值时才全量扫描（`replaceAll` 要上报真实次数、`expectCount` 要断言），
    // 其余情况沿用早停（E-P0-5），避免对大文件做无谓的全串扫描。
    let need_exact = f.replace_all || f.expect_count.is_some();
    let match_count = if need_exact {
        content.matches(&needle).count()
    } else {
        content.matches(&needle).take(2).count()
    };
    if match_count == 0 {
        return Err(EditError {
            message: "oldString not found in file".into(),
            warning: warning.clone(),
        });
    }

    // `expectCount` 是**断言**：不符就整条拒写。绝不能「照着头一次出现的位置改下去」——
    // 调用方要的正是「确认这里恰好只有一处」，改错了位置比不改更糟。
    if let Some(expected) = f.expect_count {
        if match_count != expected {
            return Err(EditError {
                message: format!(
                    "expectCount={expected} 与实际情况不符：oldString 在文件里出现 {match_count} 次（{}）；未写盘。",
                    occurrence_hint(content, &needle)
                ),
                warning: warning.clone(),
            });
        }
    }

    let (updated, replacements) = if f.replace_all {
        (content.replace(&needle, &f.new_string), match_count)
    } else {
        if match_count > 1 {
            // 早停时 `match_count` 只是「≥2」的下界；错误信息里报真实总数才有助于
            // 判断该补多少上下文（这条路径已经是错误分支，多扫一次不影响正常开销）。
            let total = if need_exact {
                match_count
            } else {
                content.matches(&needle).count()
            };
            return Err(EditError {
                message: format!(
                    "oldString matched {total} times, not unique; add more surrounding context or set replaceAll=true"
                ),
                warning: warning.clone(),
            });
        }
        (content.replacen(&needle, &f.new_string, 1), 1)
    };

    // 按原编码/换行/BOM 无损编码（内含 round-trip 守卫，编码有损会报错）。
    let out_bytes = encoding::encode_text(&updated, ft.encoding, ft.crlf, ft.had_bom)?;

    if config.backup_enabled {
        let db = state.db.lock().await;
        let bp =
            backup::backup_before_overwrite(&resolved, &config.backup_dir, &state.data_dir, &db)?;
        backup::prune_backups(
            &resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
            &db,
        )?;
        drop(db);
        // 关联审计：记录本次备份路径 + 目标路径（供一键回滚 / Diff 使用）。
        crate::audit::record_op_backup(bp, Some(resolved.clone()));
    }

    // 原子写：先写临时文件再 rename，避免写一半崩溃损坏原文件。
    write_atomic(&resolved, &out_bytes).await?;

    // 回显档位由调用方定（`auto` 在编辑场景恒落成 `hunks`：目标文件必然存在）。
    // 字节数用真实落盘长度，不是 `str::len()`——GBK 下两者差一倍。
    let diff = diff_utils::render(
        mode,
        true,
        &f.path,
        content,
        &updated,
        raw.len(),
        out_bytes.len(),
    );

    Ok(EditOutcome {
        replacements,
        encoding: ft.encoding.name().to_string(),
        newline: ft.newline_label(),
        diff,
        warning,
    })
}

/// 原子写：同目录临时文件 + rename。rename 在同一卷上是原子操作。
/// `pub(crate)` 让 `notebook_edit` 也复用同一份实现，避免每个写工具各写一份原子写逻辑。
pub(crate) async fn write_atomic(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ccbridge");
    let tmp = dir.join(format!(".{file_name}.ccbridge.tmp"));

    let t0 = std::time::Instant::now();
    if let Err(e) = tokio::fs::write(&tmp, data).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Write temp failed: {e}"));
    }
    crate::timing::record_io(t0.elapsed());
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Atomic rename failed: {e}"));
    }
    Ok(())
}

/// 给「次数不符」类错误定位的行号提示：按出现顺序最多列 5 处，如 `位置：第 12、48 行`。
///
/// 只在错误分支调用，代价无所谓；`needle` 为空时返回空串（调用方已挡掉空 oldString）。
fn occurrence_hint(content: &str, needle: &str) -> String {
    if needle.is_empty() {
        return String::new();
    }
    let mut lines: Vec<usize> = Vec::new();
    let mut from = 0usize;
    while let Some(pos) = content[from..].find(needle) {
        let abs = from + pos;
        lines.push(content[..abs].matches('\n').count() + 1);
        if lines.len() >= 5 {
            break;
        }
        from = abs + needle.len();
    }
    let list: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    // 收满 5 处说明可能还有更多，用「等」而不是给出一个看起来完整的清单。
    let tail = if lines.len() >= 5 { " 等" } else { "" };
    format!("位置：第 {} 行{}", list.join("、"), tail)
}

/// 检测 old_string 首尾是否多带空白字符（空格 / 制表符 / 换行 / 回车），命中返回一条告警文案。
///
/// WHY: 模型常因 old_string 多带一个换行或尾随空格导致「0 次匹配」报错，触发一轮远程往返重试。
/// 提前告警能让模型第一次就修正。仅告警、绝不改动匹配逻辑（否则会掩盖模型的真实错误）。
fn whitespace_warning(s: &str) -> Option<String> {
    let lead = s.len() - s.trim_start().len();
    let trail = s.len() - s.trim_end().len();
    if lead == 0 && trail == 0 {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if lead > 0 {
        let spaces = s[..lead].chars().filter(|c| *c == ' ').count();
        let tabs = lead - spaces;
        parts.push(format!(
            "前导 {lead} 个字符（空格 {spaces} / 制表符 {tabs}）"
        ));
    }
    if trail > 0 {
        let trail_part = &s[s.len() - trail..];
        let spaces = trail_part.chars().filter(|c| *c == ' ').count();
        let tabs = trail - spaces;
        parts.push(format!(
            "尾随 {trail} 个字符（空格 {spaces} / 制表符 {tabs}）"
        ));
    }
    let nl = s.matches('\n').count();
    let cr = s.matches('\r').count();
    if nl > 0 || cr > 0 {
        parts.push(format!("含 {nl} 个换行符 / {cr} 个回车符"));
    }
    Some(format!(
        "oldString 首尾检测到空白字符：{}。若非故意多带，去掉首尾空白后重试可避免匹配失败。",
        parts.join("，")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 归一化规则本身的说明性断言：原串匹配不上、归一化后能匹配上。
    ///
    /// ⚠ **它不是回归测试，别当它是。** 它只调 `normalize_newlines`，
    /// 压根没碰 `edit_single`——把下面那个 `needle` 改回 `f.old_string`，
    /// 这条照样全绿（已实验验证）。真正护住行为的是 `http.rs` 里那条
    /// `edit_files_matches_crlf_old_string_and_preserves_line_endings`（真起服务、真读写文件）。
    #[test]
    fn crlf_needle_matches_normalized_content() {
        // 文件读进来之后的样子（与 `read_text` 同一套规则）。
        let content = crate::encoding::normalize_newlines("alpha\r\nbeta\r\n");
        assert!(
            !content.contains("alpha\r\nbeta"),
            "原串必然匹配不上——这正是要归一化查询串的理由"
        );
        let needle = crate::encoding::normalize_newlines("alpha\r\nbeta");
        assert!(content.contains(&needle), "归一化后必须能匹配上");
    }

    #[test]
    fn whitespace_warning_detects_leading_and_trailing() {
        let w = whitespace_warning("    fn main() {\n");
        let text = w.expect("应检测到首尾空白");
        assert!(text.contains("前导"), "应提到前导空白：{text}");
        assert!(text.contains("尾随"), "应提到尾随空白：{text}");
        assert!(text.contains("换行符"), "应提到换行符：{text}");
    }

    #[test]
    fn whitespace_warning_none_for_clean_string() {
        assert!(whitespace_warning("fn main() {").is_none());
    }

    #[test]
    fn whitespace_warning_tab_counts() {
        let w = whitespace_warning("\tfn()").expect("应检测到前导制表符");
        assert!(w.contains("制表符 1"), "应统计出 1 个制表符：{w}");
    }

    /// A 类容错：`{"edits": "[...]"}`（错误键 + 字符串化 + Flat 形态）——审计实锤样本。
    #[test]
    fn flex_accepts_stringified_flat_form_under_alias() {
        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "edits": "[{\"path\": \"D:\\\\x\\\\NcSvn.java\", \"oldString\": \"a\", \"newString\": \"b\"}]"
        }))
        .expect("edits 别名 + 字符串化数组应被接受");
        assert_eq!(args.files.len(), 1);
        assert_eq!(args.files[0].path, "D:\\x\\NcSvn.java");
        assert_eq!(args.files[0].old_string, "a");
    }

    /// Grouped 形态：{path, edits: [{oldString, newString}, ...]} —— 审计实锤「missing field oldString」的根因。
    #[test]
    fn flex_accepts_grouped_form() {
        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{
                "path": "a.java",
                "edits": [
                    { "oldString": "x", "newString": "y" },
                    { "oldString": "p", "newString": "q", "replaceAll": true }
                ]
            }]
        }))
        .expect("分组形态应被接受并展平");
        assert_eq!(
            args.files.len(),
            2,
            "分组内 2 条 edit 应展平为 2 个 EditEntry"
        );
        assert_eq!(args.files[0].path, "a.java");
        assert_eq!(args.files[1].old_string, "p");
        assert!(args.files[1].replace_all);
    }

    /// 正规 Flat 形态不受影响（回归保护）。
    #[test]
    fn flex_keeps_plain_flat_form() {
        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{ "path": "a.java", "oldString": "x", "newString": "y" }]
        }))
        .expect("正规形态必须继续工作");
        assert_eq!(args.files.len(), 1);
        assert_eq!(args.files[0].new_string, "y");
    }

    /// 解不出 JSON 的字符串照样报错（不静默兜底）。
    #[test]
    fn flex_rejects_non_json_string() {
        let r: Result<EditFilesArgs, _> =
            serde_json::from_value(serde_json::json!({ "files": "not json" }));
        assert!(r.is_err());
    }

    /// 回显档位（RFC 十五）：`none` 让结果里**没有** diff 字段，`full` 与改造前一致。
    ///
    /// 两条断言合在一个测试里是有意的——它们共享同一次目录与配置准备，而各自独立造
    /// `AppState` 会让这条本已很轻的测试多开两个临时库。
    #[tokio::test]
    async fn diff_mode_controls_echoed_change() {
        use crate::mcp::tools::testutil::*;

        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree\n").expect("seed");
        let path = file.to_string_lossy().into_owned();

        // ① none：连字段都不给。
        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{ "path": path, "oldString": "two", "newString": "TWO" }],
            "diff": "none"
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("edit");
        let rows: Value =
            serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).expect("rows");
        assert_eq!(rows[0]["ok"], json!(true), "编辑应成功：{rows}");
        assert!(
            rows[0].get("diff").is_none(),
            "diff:\"none\" 时不应出现 diff 字段：{rows}"
        );

        // ② full：必须给出 -two / +TWO 的完整 hunk（改造前行为）。
        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{ "path": path, "oldString": "three", "newString": "THREE" }],
            "diff": "full"
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("edit");
        let text = out["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("-three"), "full 应回显被删行：{text}");
        assert!(text.contains("+THREE"), "full 应回显新增行：{text}");
    }

    /// 取 `content[0].text` 里那一行结果的 JSON。
    fn row(out: &Value) -> Value {
        let text = out["content"][0]["text"].as_str().expect("text 块");
        serde_json::from_str::<Value>(text).expect("行结果是 JSON")
    }

    /// `expectCount` 不符：整条拒写，文件一个字节都不许变，并给出实际次数与位置。
    ///
    /// 🔴 「拒写」是本参数的全部价值：若允许它「照着第一次出现的位置改下去」，
    /// 调用方以为在改唯一一处、实际改错了地方，比不执行危险得多。
    #[tokio::test]
    async fn expect_count_mismatch_refuses_to_write() {
        use crate::mcp::tools::testutil::*;

        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("dup.txt");
        std::fs::write(&file, "foo\nbar\nfoo\n").expect("seed");
        let path = file.to_string_lossy().into_owned();

        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{ "path": path, "oldString": "foo", "newString": "zzz", "expectCount": 1 }]
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("工具调用本身成功");
        let r = row(&out);
        let err = r[0]["error"].as_str().unwrap_or_default();
        assert!(r[0]["ok"].as_bool() == Some(false), "应失败：{r}");
        assert!(err.contains("expectCount=1"), "应回显期望值：{err}");
        assert!(err.contains("出现 2 次"), "应报实际次数：{err}");
        assert!(err.contains("第 1、3 行"), "应给出行号：{err}");
        assert_eq!(
            std::fs::read_to_string(&file).expect("读回"),
            "foo\nbar\nfoo\n",
            "断言失败时文件必须原样"
        );
    }

    /// `expectCount` 相符：正常写盘，`replacements` 应是真实替换数（配合 replaceAll）。
    #[tokio::test]
    async fn expect_count_match_writes_all_occurrences() {
        use crate::mcp::tools::testutil::*;

        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("dup.txt");
        std::fs::write(&file, "foo\nbar\nfoo\n").expect("seed");
        let path = file.to_string_lossy().into_owned();

        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{
                "path": path, "oldString": "foo", "newString": "zzz",
                "replaceAll": true, "expectCount": 2
            }]
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("edit");
        let r = row(&out);
        assert_eq!(r[0]["ok"].as_bool(), Some(true), "应成功：{r}");
        assert_eq!(r[0]["replacements"].as_u64(), Some(2), "应替换 2 处：{r}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "zzz\nbar\nzzz\n");
    }

    /// `expectCount` 与 `replaceAll` 的组合校验：只错一处也不动文件。
    #[tokio::test]
    async fn expect_count_zero_occurrence_fails_without_write() {
        use crate::mcp::tools::testutil::*;

        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("a.txt");
        std::fs::write(&file, "alpha\n").expect("seed");
        let path = file.to_string_lossy().into_owned();

        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{ "path": path, "oldString": "beta", "newString": "x", "expectCount": 1 }]
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("工具调用本身成功");
        let err = row(&out)[0]["error"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(err.contains("not found"), "0 次仍是 not found：{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "alpha\n");
    }

    /// 显式 `encoding:"gbk"` 必须盖住「自动识别关闭」的默认值：
    /// 按 GBK 读、按 GBK + 原换行写回，中文不乱码、字节仍是 GBK。
    ///
    /// 这是本参数存在的理由——GBK 项目不必为了改一个文件去改全局设置。
    #[tokio::test]
    async fn explicit_encoding_overrides_toggle_and_preserves_gbk_crlf() {
        use crate::mcp::tools::testutil::*;

        let (state, dir) = make_state(|c| {
            c.backup_enabled = false;
            c.encoding_detect_enabled = false; // 默认：强制 UTF-8，GBK 文件本该解不开
        });
        let file = dir.join("Nc.java");
        let gbk = crate::encoding::label_to_encoding("gbk").expect("gbk 应可用");
        let bytes = crate::encoding::encode_string("// 中文注释\r\nclass A {}\r\n", gbk);
        std::fs::write(&file, &bytes).expect("seed");
        let path = file.to_string_lossy().into_owned();

        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{
                "path": path, "oldString": "class A {}", "newString": "class B {}",
                "encoding": "gbk"
            }]
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("edit");
        let r = row(&out);
        assert_eq!(r[0]["ok"].as_bool(), Some(true), "显式 gbk 应能编辑：{r}");
        assert_eq!(r[0]["encoding"].as_str(), Some("GBK"), "编码应是 GBK：{r}");
        assert_eq!(r[0]["newline"].as_str(), Some("CRLF"), "换行应保住：{r}");

        let after = std::fs::read(&file).expect("读回");
        let decoded = crate::encoding::read_text(&after, Some("gbk")).expect("按 gbk 解");
        let decoded_text = decoded.text.clone();
        assert!(
            decoded_text.contains("中文注释"),
            "中文必须完好：{decoded_text}"
        );
        assert!(decoded.text.contains("class B {}"), "替换应生效");
        assert!(decoded.crlf, "CRLF 必须保住");
        assert!(
            std::str::from_utf8(&after).is_err(),
            "落盘字节必须仍是 GBK（中文的 GBK 字节不是合法 UTF-8）"
        );
    }

    /// 编码标签拼错：报错要能自己解释，列出可用标签，而不是一句 Unknown encoding label。
    #[tokio::test]
    async fn unknown_encoding_label_lists_available_labels() {
        use crate::mcp::tools::testutil::*;

        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("a.txt");
        std::fs::write(&file, "alpha\n").expect("seed");
        let path = file.to_string_lossy().into_owned();

        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{ "path": path, "oldString": "alpha", "newString": "x", "encoding": "gb2312x" }]
        }))
        .expect("args");
        let out = handle(args, &state).await.expect("工具调用本身成功");
        let err = row(&out)[0]["error"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(err.contains("未知编码"), "应说是未知编码：{err}");
        assert!(err.contains("gb18030"), "应列出可用标签：{err}");
    }

    /// 分组形态也要能把 encoding / expectCount 透传到展平后的条目。
    #[test]
    fn flex_grouped_carries_encoding_and_expect_count() {
        let args: EditFilesArgs = serde_json::from_value(serde_json::json!({
            "files": [{
                "path": "a.java",
                "edits": [{ "oldString": "x", "newString": "y", "encoding": "gbk", "expectCount": 3 }]
            }]
        }))
        .expect("分组形态应被接受");
        assert_eq!(args.files.len(), 1);
        assert_eq!(args.files[0].encoding.as_deref(), Some("gbk"));
        assert_eq!(args.files[0].expect_count, Some(3));
    }
}
