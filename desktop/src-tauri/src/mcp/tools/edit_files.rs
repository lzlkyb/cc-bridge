use std::sync::Arc;

use serde::Deserialize;
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
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct EditFilesArgs {
    pub files: Vec<EditEntry>,
}

pub async fn handle(args: EditFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for f in &args.files {
        match edit_single(f, &config, state).await {
            Ok(outcome) => results.push(json!({
                "path": f.path,
                "ok": true,
                "replacements": outcome.replacements,
                "encoding": outcome.encoding,
                "newline": outcome.newline,
                "diff": outcome.diff,
                "warning": outcome.warning,
            })),
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
    diff: String,
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

    let resolved = security::path::resolve_safe_path_cached(
        &f.path,
        &state.cached_roots(),
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
    let effective_encoding = if config.encoding_detect_enabled {
        None
    } else {
        Some("utf-8")
    };
    let ft = encoding::read_text(&raw, effective_encoding)?;
    let content = &ft.text;

    let match_count = content.matches(&needle).take(2).count(); // E-P0-5: 早停在 >1，避免全文件扫描
    if match_count == 0 {
        return Err(EditError {
            message: "oldString not found in file".into(),
            warning: warning.clone(),
        });
    }

    let (updated, replacements) = if f.replace_all {
        // match_count 因 take(2) 早停最多为 2（仅用于唯一性判定）；replaceAll 需上报真实
        // 替换次数，这里重新全量计数（replace 本身也会全串扫描，代价可忽）。
        let actual = content.matches(&needle).count();
        (content.replace(&needle, &f.new_string), actual)
    } else {
        if match_count > 1 {
            return Err(EditError {
                message: format!(
                    "oldString matched {match_count} times, not unique; add more surrounding context or set replaceAll=true"
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

    let diff = diff_utils::unified_diff(&f.path, content, &updated);

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
}
