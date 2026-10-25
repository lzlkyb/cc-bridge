//! 会话内的改动还原（批 4-2「审批即审计」）的 IPC 层。
//!
//! ## 为什么需要这一层
//!
//! 前端从**会话事件流**知道「哪个审批点放行了哪次工具调用、改了哪个文件」，
//! 但它不知道这些改动**有没有备份** —— 备份是审计日志里的 `backupPath`，
//! 只有走桥的写工具才有（CC 内置的 Edit / Write 根本不经过桥）。
//!
//! 所以还原能力是两条数据源拼起来的：
//!
//! ```text
//! 事件流（前端）  → 审批点、工具名、入参、diff     ← 决定「改了什么」
//! 审计日志（后端）→ 带 backupPath 的条目           ← 决定「能不能还原」
//! ```
//!
//! 关联键分两层，精度不一样，不能混着说：
//!
//! - **审批 ↔ 工具调用**：精确。协议里有 `tool_use_id`，前端拿
//!   `permissionAsk.toolUseId === CcMessage(kind:"tool").id` 直接对上，不猜。
//! - **工具调用 ↔ 审计条目**：只能按「工具名 + 目标路径 + 先后顺序」。审计条目里
//!   没有 `toolUseId`（MCP 请求不带它），所以这层是在前端按顺序**认领**的，
//!   而且一份备份只许被认领一次（见 `ccApprovalAudit` 的备份池）。
//!
//! 这个命令只回答后者的原料，也就是「这条会话里，哪些改动有备份」。返回的是
//! **清单**，不是「全部调用」：读文件、搜索、失败的调用都不在里面。
//! 至于「这轮都干了什么」，事件流自己知道。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audit::{self, AuditEntry};
use crate::backup;
use crate::security::path;
use crate::state::AppState;

/// 一条「可还原」的改动：审计里同时有备份与目标的那次调用。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcSessionBackup {
    /// 产生这次备份的工具名（`write_files` / `edit_files` / `delete_files` …）。
    pub tool: String,
    /// 被改的文件（还原时写回这里）。
    pub target_path: String,
    /// 操作**前**的快照文件。
    pub backup_path: String,
    /// 审计时间戳（ISO 8601）。前端按它排先后 —— 与事件流里的出现顺序对齐用。
    pub timestamp: String,
}

/// 从全量审计里挑出某条会话的可还原项，保持**原始顺序**（= 发生顺序）。
///
/// 单独抽成纯函数是为了可测：命令本身要拿 `State` 与 `spawn_blocking`，
/// 逻辑藏在里面就只能靠起一个真 app 来测。
///
/// 🔴 `ccSessionId` 对不上的一律不要。审计里绝大多数条目（读、搜索、命令）
/// 属于别的会话或不归属任何会话，按会话过滤是唯一正确的口径。
fn pick_backups(all: &[AuditEntry], session_id: &str) -> Vec<CcSessionBackup> {
    all.iter()
        .filter(|e| e.cc_session_id.as_deref() == Some(session_id))
        .filter_map(|e| match (&e.backup_path, &e.target_path) {
            // 两个字段要么都有要么都没有（写工具成对写入）。只有一个时按不可还原处理：
            // 拿半个信息去调 `restore_file` 只会换来一句校验失败。
            (Some(b), Some(t)) if !b.is_empty() && !t.is_empty() => Some(CcSessionBackup {
                tool: e.tool.clone(),
                target_path: t.clone(),
                backup_path: b.clone(),
                timestamp: e.timestamp.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// 这条会话里所有带备份的改动，按发生顺序。
///
/// `session_id` 是 **CC 的** session id（`system/init` 给的那个，即审计里的
/// `ccSessionId`）—— 与 `cc_context_tax` 同一口径。传内部会话 id 会永远查到 0 条，
/// 而且不会报错。重新打开的历史会话拿不到当时那份审计（内部 id 已经换了），
/// 这个限制在方案 §2.4 里写明，前端要据此把话说软。
#[tauri::command]
pub async fn cc_session_backups(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Vec<CcSessionBackup>, String> {
    let data_dir = state.data_dir.clone();
    // 只碰 data_dir 里的 audit.log，不碰数据库 ⇒ 不拿 db 锁。
    tauri::async_runtime::spawn_blocking(move || {
        audit::with_cached_entries(&data_dir, |all| pick_backups(all, &session_id))
    })
    .await
    .map_err(|e| format!("任务加入失败：{e}"))?
}

/// 一处反向补丁：把 `new_string` 换回 `old_string`（与 CC 内置 Edit 的入参同形）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPatchArg {
    pub old_string: String,
    pub new_string: String,
}

/// 把补丁**逆序**应用到文本。全部预检通过才返回新文本，否则原样报错。
///
/// ## 为什么逆序
///
/// 一次 MultiEdit 的几处改动是按顺序发生的，后一处的定位基于前一处已经改好的状态。
/// 撤销就得倒着来：先撤最后一处，再往前。字符串搜索本身不看偏移量，所以顺序在
/// 大多数情况下不改变结果 —— 但当前一处的**新文本包含后一处的新文本**时，
/// 正序会命中错误的那个位置。逆序没有这个问题。
///
/// ## 为什么要求「恰好一次」
///
/// 0 次：文件已经被后续改动覆盖，或者这不是原来那个文件。此时**不能猜** ——
/// 猜错就是悄悄改坏一处无关的代码。
/// 多次：同一个片段在文件里出现多次，无法判断当时改的是哪一处。
///
/// 两种都整体拒绝。函数是纯的（不碰磁盘），所以「拒绝」天然意味着文件一个字节都没动。
fn apply_patches(text: &str, patches: &[EditPatchArg]) -> Result<String, String> {
    let mut out = text.to_string();
    for (i, p) in patches.iter().enumerate().rev() {
        let nth = i + 1;
        if p.new_string.is_empty() {
            return Err(format!(
                "第 {nth} 处改动没有「写入后的内容」，无法在文件里定位它。已停止，文件未改动。"
            ));
        }
        match out.matches(p.new_string.as_str()).count() {
            0 => {
                return Err(format!(
                    "第 {nth} 处改动对不上：文件里找不到这次写入的内容，它可能已被后续改动覆盖。已停止，文件未改动。"
                ))
            }
            1 => {}
            c => {
                return Err(format!(
                    "第 {nth} 处改动在文件里有 {c} 个匹配位置，无法确定该撤哪一个。已停止，文件未改动。"
                ))
            }
        }
        out = out.replacen(p.new_string.as_str(), p.old_string.as_str(), 1);
    }
    Ok(out)
}

/// 用反向补丁撤销一次 CC 内置 Edit / MultiEdit。
///
/// 与 `restore_file` 的关系：那条路还原的是**备份**（走桥的写工具有备份），
/// 这条还原的是**内容**（内置工具没有备份，但它把 old/new 都写在了入参里）。
/// 两条路的安全语义必须一致，所以白名单 / 只读 / 扩展名校验是从 `restore_file`
/// 原样搬来的，一处不少。
///
/// 写前再备份一次（`backup_before_overwrite`），所以**撤销本身也能再撤销**。
#[tauri::command]
pub async fn restore_edit_patch(
    state: State<'_, Arc<AppState>>,
    target_path: String,
    patches: Vec<EditPatchArg>,
) -> Result<(), String> {
    if patches.is_empty() {
        return Err("没有要还原的改动".into());
    }
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();
    let backup_retention = config.backup_retention;
    let readonly_mode = config.readonly_mode;
    let allowed_extensions = config.allowed_extensions.clone();
    // 排除规则只约束远程 MCP 访问，不拦本机面板的还原（与 restore_file 同一条理由）。
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        &[],
        config.whitelist_enabled,
    )?;
    drop(config);

    if readonly_mode {
        return Err("只读模式已开启，禁止还原（写操作被拦截）".into());
    }
    crate::security::extension::assert_extension_allowed(&resolved, &allowed_extensions)?;

    if !resolved.exists() {
        return Err(format!("目标文件不存在：{target_path}"));
    }
    // 只处理 UTF-8：`read_to_string` 失败时明确拒绝，而不是 lossy 转换后写回去
    // （那会把 GBK 文件的其余部分改成替换字符，是静默的数据损坏）。
    let original = std::fs::read_to_string(&resolved)
        .map_err(|e| format!("读取目标文件失败（反向补丁只支持 UTF-8 编码）：{e}"))?;

    // 预检 + 计算都在内存里完成：任何一处对不上就整个失败，磁盘没被碰过。
    let restored = apply_patches(&original, &patches)?;
    if restored == original {
        // 补丁是空转（new == old），没必要造一份备份再写一遍同样的内容。
        return Ok(());
    }

    // 写前备份：撤销也是写操作，必须能再撤销。
    // 大括号只为了让 db 锁在这几句之后立刻释放，别扩到 fs 写。
    let new_backup: Option<PathBuf> = {
        let db = state.db.lock().await;
        let made = backup::backup_before_overwrite(&resolved, &backup_dir, &data_dir, &db)?;
        backup::prune_backups(&resolved, &backup_dir, &data_dir, backup_retention, &db)?;
        made
    };

    // 原子写：临时文件 + rename（与 restore_file 同一做法，避免写一半留残文）。
    let tmp = resolved.with_extension("tmp_patch");
    std::fs::write(&tmp, restored.as_bytes()).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::fs::rename(&tmp, &resolved).map_err(|e| format!("写回目标文件失败：{e}"))?;

    let mut entry = audit::new_entry(
        "restore_patch",
        &serde_json::json!({
            "targetPath": target_path,
            "patches": patches.len(),
        })
        .to_string(),
        true,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        // 还原是本地面板发起的，不归属任何 CC 对话会话 —— 它不该进那条会话的
        // 「改动」账，否则用户会看到「我的撤销」被当成一次新的 AI 改动。
        None,
    );
    entry.backup_path = new_backup
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    entry.target_path = Some(target_path.clone());
    audit::write_audit_log(&data_dir, &entry)?;

    Ok(())
}

/// 撤销一次「新建文件」：删掉它。
///
/// ## 为什么要传 `expected_content` 而不是见文件就删
///
/// 「这次 Write 是新建」这个判断来自工具结果文案（见前端 `ccApprovalAudit`），
/// 而文案是会变的。判错方向是**删掉用户原有的文件**，代价远大于「撤不回来」。
///
/// 所以再加一道硬证据：文件当前内容必须**逐字节等于**当时写进去的内容。
/// 不相等说明已经被人改过（改过就更不能删），直接拒绝。
///
/// 删之前照例备份 —— 删错了还能用 `restore_file` 拿回来。
#[tauri::command]
pub async fn restore_delete_created(
    state: State<'_, Arc<AppState>>,
    target_path: String,
    expected_content: String,
) -> Result<(), String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();
    let backup_retention = config.backup_retention;
    let readonly_mode = config.readonly_mode;
    let allowed_extensions = config.allowed_extensions.clone();
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        &[],
        config.whitelist_enabled,
    )?;
    drop(config);

    if readonly_mode {
        return Err("只读模式已开启，禁止删除（写操作被拦截）".into());
    }
    crate::security::extension::assert_extension_allowed(&resolved, &allowed_extensions)?;
    if !resolved.exists() {
        // 已经不在了：撤销本来就是「让它消失」，结果已经达成。
        return Ok(());
    }

    let current = std::fs::read_to_string(&resolved)
        .map_err(|e| format!("读取目标文件失败（只支持 UTF-8 编码）：{e}"))?;
    if current != expected_content {
        return Err(
            "文件内容已经不是当时写入的样子（被人改过），不删除。请自己确认后再处理。".into(),
        );
    }

    let new_backup: Option<PathBuf> = {
        let db = state.db.lock().await;
        let made = backup::backup_before_overwrite(&resolved, &backup_dir, &data_dir, &db)?;
        backup::prune_backups(&resolved, &backup_dir, &data_dir, backup_retention, &db)?;
        made
    };
    std::fs::remove_file(&resolved).map_err(|e| format!("删除文件失败：{e}"))?;

    let mut entry = audit::new_entry(
        "restore_delete",
        &serde_json::json!({ "targetPath": target_path }).to_string(),
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
    entry.backup_path = new_backup
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    entry.target_path = Some(target_path.clone());
    audit::write_audit_log(&data_dir, &entry)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(
        tool: &str,
        sid: Option<&str>,
        backup: Option<&str>,
        target: Option<&str>,
    ) -> AuditEntry {
        AuditEntry {
            timestamp: "2026-10-25T12:00:00+08:00".into(),
            tool: tool.into(),
            params: "{}".into(),
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
            cc_session_id: sid.map(str::to_string),
            backup_path: backup.map(str::to_string),
            target_path: target.map(str::to_string),
            result_bytes: None,
            result_chars: None,
        }
    }

    #[test]
    fn only_entries_with_both_paths_are_listed() {
        let all = vec![
            entry(
                "write_files",
                Some("s1"),
                Some("/bak/a.bak"),
                Some("/src/a.rs"),
            ),
            // 读操作：没有备份，不该出现在清单里（前端问的是「哪些能还原」）
            entry("read_files", Some("s1"), None, None),
            // 只写了一半：宁可当不可还原，也不拿半个信息去调 restore_file
            entry("edit_files", Some("s1"), Some("/bak/b.bak"), None),
            entry(
                "delete_files",
                Some("s2"),
                Some("/bak/c.bak"),
                Some("/src/c.rs"),
            ),
        ];
        let got = pick_backups(&all, "s1");
        assert_eq!(got.len(), 1, "只有 s1 且两个路径齐全的那条：{got:?}");
        assert_eq!(got[0].tool, "write_files");
        assert_eq!(got[0].target_path, "/src/a.rs");
        assert_eq!(got[0].backup_path, "/bak/a.bak");
    }

    /// 同一文件改两次 ⇒ 两条备份，顺序是发生顺序（前端靠它和事件流对齐）。
    #[test]
    fn repeated_edits_keep_chronological_order() {
        let mut first = entry(
            "edit_files",
            Some("s1"),
            Some("/bak/1.bak"),
            Some("/src/a.rs"),
        );
        first.timestamp = "2026-10-25T12:00:01+08:00".into();
        let mut second = entry(
            "edit_files",
            Some("s1"),
            Some("/bak/2.bak"),
            Some("/src/a.rs"),
        );
        second.timestamp = "2026-10-25T12:00:05+08:00".into();
        let got = pick_backups(&[first, second], "s1");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].timestamp, "2026-10-25T12:00:01+08:00");
        assert_eq!(got[1].timestamp, "2026-10-25T12:00:05+08:00");
    }

    #[test]
    fn empty_strings_are_not_backups() {
        let all = vec![entry("write_files", Some("s1"), Some(""), Some(""))];
        assert!(pick_backups(&all, "s1").is_empty());
    }

    // ===== 反向补丁 =====

    fn patch(old: &str, new: &str) -> EditPatchArg {
        EditPatchArg {
            old_string: old.into(),
            new_string: new.into(),
        }
    }

    #[test]
    fn single_patch_swaps_new_back_to_old() {
        let out = apply_patches("头\n新的\n尾", &[patch("旧的", "新的")]).unwrap();
        assert_eq!(out, "头\n旧的\n尾");
    }

    /// 逆序是必须的：前一处的**新文本包含**后一处的新文本时，正序会命中错的位置。
    #[test]
    fn patches_apply_in_reverse_so_containment_does_not_misplace() {
        // 原操作：a→x，b→xy，得到 "x" + "xy" + "y"
        let after = "xxyy";
        let out = apply_patches(after, &[patch("a", "x"), patch("b", "xy")]).unwrap();
        // 还原成 "a" + "b" + "y"
        assert_eq!(out, "aby");
    }

    #[test]
    fn zero_match_is_rejected_and_names_the_patch() {
        let err = apply_patches("内容已经变了", &[patch("旧", "当年写进去的")]).unwrap_err();
        assert!(err.contains("第 1 处"), "{err}");
        assert!(err.contains("找不到"), "{err}");
        assert!(err.contains("文件未改动"), "错误信息要让人敢重试：{err}");
    }

    #[test]
    fn ambiguous_match_is_rejected_rather_than_guessing() {
        let err = apply_patches("同\n同", &[patch("旧", "同")]).unwrap_err();
        assert!(err.contains("2 个匹配位置"), "{err}");
    }

    #[test]
    fn empty_new_string_is_rejected() {
        let err = apply_patches("任意", &[patch("旧", "")]).unwrap_err();
        assert!(err.contains("没有「写入后的内容」"), "{err}");
    }

    /// 后面一处失败时，前面已经算好的替换不能在返回结果里残留 ——
    /// 调用方拿到 Err 就一个字节都不写，这条靠「纯函数 + 不落盘」保证。
    #[test]
    fn failure_on_second_patch_yields_err_not_partial_text() {
        let err = apply_patches("只改了第一处", &[patch("a", "只改了第一处")]).err();
        assert!(err.is_none(), "单处应该成功");
        let err = apply_patches(
            "只改了第一处",
            &[patch("a", "只改了第一处"), patch("b", "根本没写过")],
        )
        .unwrap_err();
        assert!(err.contains("第 2 处"), "逆序先撤第 2 处，报的是它：{err}");
    }
}
