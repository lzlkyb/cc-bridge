//! Stable-card reads use the pinned SSH identity and temporary credentials, with no remote mutations.
use crate::stable_connect::{fingerprint, friendly_error, same_saved_endpoint, StableSaved};
use crate::stable_discovery::{self as discovery, StableDiscovery, StableFolders, StableTarget};
use crate::state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// 服务器上的条目才是事实。按「id → 同名 → 可识别的桥条目」逐级收窄，每级都要求唯一；
/// 多条命中时返回 None —— 宁可不判，也不猜错改写用户记录。
fn same_entry(saved: &StableSaved, targets: &[StableTarget]) -> Option<StableTarget> {
    if let Some(previous) = saved.target.as_ref() {
        if let Some(hit) = targets.iter().find(|target| target.id == previous.id) {
            return Some(hit.clone());
        }
    }
    let in_scope = |target: &&StableTarget| {
        target.scope == saved.scope
            && (saved.scope == "user" || target.project_path == saved.project_path)
    };
    let name = saved
        .target
        .as_ref()
        .map_or("cc-bridge", |target| target.name.as_str());
    let named: Vec<&StableTarget> = targets
        .iter()
        .filter(|t| in_scope(t) && t.name == name)
        .collect();
    // 用户在服务器上改过名字时，靠 inspect 已判定为桥条目的结果兜底。
    let candidates = if named.is_empty() {
        targets
            .iter()
            .filter(|t| in_scope(t) && t.recognized)
            .collect::<Vec<_>>()
    } else {
        named
    };
    match candidates.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// 把 inspect 读到的真实条目写回本地记录（只改 target，不动指纹与 verified_at）。
/// 不改这一步，状态卡就会一直拿「上次写进去的地址」当「服务器现在的地址」报已连通。
async fn sync_observed_target(
    state: &Arc<AppState>,
    saved: &StableSaved,
    signature: &str,
    targets: &[StableTarget],
) -> bool {
    let Some(observed) = same_entry(saved, targets) else {
        return false;
    };
    if saved.target.as_ref() == Some(&observed) {
        return false;
    }
    let db = state.db.lock().await;
    let mut current = state.config.write().await;
    if fingerprint(&current, &saved.connection_id) != signature {
        return false;
    }
    let mut next = current.stable_connect.clone();
    let Some(slot) = next
        .connections
        .iter_mut()
        .find(|entry| entry.connection_id == saved.connection_id)
    else {
        return false;
    };
    // Discovery may finish after an automatic repair has written the new endpoint.
    if !same_saved_endpoint(slot, saved)
        || slot.target != saved.target
        || slot.verified_at != saved.verified_at
    {
        return false;
    }
    slot.target = Some(observed);
    let Ok(value) = serde_json::to_value(&next) else {
        return false;
    };
    let Ok(tx) = db.unchecked_transaction() else {
        return false;
    };
    if crate::config::save_config_field(&tx, "stable_connect", &value).is_err()
        || tx.commit().is_err()
    {
        return false;
    }
    current.stable_connect = next;
    true
}

/// 读一次服务器上的接入配置。
///
#[allow(clippy::too_many_arguments)]
pub(super) async fn read_remote(
    state: &Arc<AppState>,
    id: &str,
    paths: (Option<&str>, Option<&str>),
    folders: bool,
    signature: Option<&str>,
    password: Option<String>,
    passphrase: Option<String>,
    multi: Option<bool>,
) -> Result<(String, String), String> {
    let (path, source_path) = paths;
    if let Some(path) = path {
        crate::stable_connect::validate_setup("project", path, false)?;
    }
    if let Some(path) = source_path.filter(|path| !path.is_empty()) {
        crate::stable_connect::validate_setup("project", path, false)?;
    }
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return Err("请先在设置中开启 SSH。".into());
    }
    let expected = fingerprint(&config, id);
    if signature.is_some_and(|value| value != expected) {
        return Err("服务器配置已变化，请重新检查。".into());
    }
    let link = super::ssh_cmds::SshLink::from_config(&config, id)?;
    // 多设备开关由调用方给（草稿可能还没落库）；没给就按已保存的连接记录取。
    let multi = multi.unwrap_or_else(|| {
        config
            .stable_connect
            .connections
            .iter()
            .find(|saved| saved.connection_id == id)
            .is_some_and(|saved| saved.multi_device)
    });
    let script = discovery::read_script(&config, id, path, folders, source_path, multi);
    let output = super::ssh_cmds::run_stable_setup(
        state,
        &link,
        script,
        password,
        passphrase,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .map_err(|error| friendly_error(&error, &config.token))?;
    if fingerprint(&*state.config.read().await, id) != expected {
        return Err("服务器配置在检查期间发生变化，请重新检查。".into());
    }
    Ok((output, expected))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields: the web side passes them by name.
pub async fn stable_connect_inspect(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    project_path: Option<String>,
    source_project_path: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
    multi_device: Option<bool>,
) -> Result<StableDiscovery, String> {
    let saved = if project_path.is_none() && source_project_path.is_none() {
        state
            .config
            .read()
            .await
            .stable_connect
            .connections
            .iter()
            .find(|entry| {
                entry.connection_id == connection_id
                    && multi_device.is_none_or(|multi| multi == entry.multi_device)
            })
            .cloned()
    } else {
        None
    };
    let (output, signature) = read_remote(
        state.inner(),
        &connection_id,
        (project_path.as_deref(), source_project_path.as_deref()),
        false,
        None,
        password,
        passphrase,
        multi_device,
    )
    .await?;
    let mut result: StableDiscovery = discovery::parse_result(&output, "CCB_DISCOVERED")?;
    if result.signature != signature {
        return Err("服务器检查结果已失效，请重新检查。".into());
    }
    result.warnings = result
        .warnings
        .iter()
        .map(|warning| friendly_error(warning, ""))
        .collect();
    // 常规核对（不是「改范围」或「换项目」）读到完整结果时，把服务器真值同步进记录，
    // 让状态卡据此判定；范围编辑分支可能只看了另一个项目，不能拿它覆盖当前连接的记录。
    if let Some(saved) = saved.filter(|_| result.complete) {
        if sync_observed_target(state.inner(), &saved, &signature, &result.targets).await {
            super::stable_connect_cmds::changed(&app, Some(&connection_id));
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn stable_connect_folders(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: Option<String>,
    signature: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<StableFolders, String> {
    let (output, expected) = read_remote(
        state.inner(),
        &connection_id,
        (path.as_deref(), None),
        true,
        signature.as_deref(),
        password,
        passphrase,
        None,
    )
    .await?;
    let result: StableFolders = discovery::parse_result(&output, "CCB_LISTED")?;
    if result.signature != expected {
        return Err("服务器检查结果已失效，请重新检查。".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, name: &str, scope: &str, path: &str, url: &str) -> StableTarget {
        StableTarget {
            id: id.into(),
            name: name.into(),
            scope: scope.into(),
            project_path: path.into(),
            project_key: None,
            config_file: format!("{path}/.mcp.json"),
            url: url.into(),
            fingerprint: "a".repeat(64),
            recognized: true,
            token_matches: true,
        }
    }

    fn saved(previous: Option<StableTarget>, scope: &str, path: &str) -> StableSaved {
        StableSaved {
            connection_id: "conn".into(),
            port: 7823,
            scope: scope.into(),
            project_path: path.into(),
            multi_device: false,
            enabled: true,
            fingerprint: "f".repeat(64),
            token_fingerprint: "t".repeat(64),
            target: previous,
            verified_at: None,
        }
    }

    #[test]
    fn observed_entry_wins_by_id_even_when_its_url_changed() {
        let previous = target(
            "old-id",
            "cc-bridge",
            "project",
            "/srv/a",
            "http://127.0.0.1:7823/mcp",
        );
        let remote = vec![
            target(
                "old-id",
                "cc-bridge",
                "project",
                "/srv/a",
                "http://10.0.0.2:7823/mcp",
            ),
            target(
                "other",
                "cc-bridge",
                "project",
                "/srv/b",
                "http://127.0.0.1:7823/mcp",
            ),
        ];
        let hit = same_entry(&saved(Some(previous), "project", "/srv/a"), &remote).unwrap();
        assert_eq!(hit.id, "old-id");
        assert_eq!(hit.url, "http://10.0.0.2:7823/mcp");
    }

    #[test]
    fn observed_entry_falls_back_to_unique_name_scope_and_project() {
        // 用户在服务器上改过内容后 id 会变，只能靠名称 + 范围 + 项目定位。
        let remote = vec![
            target(
                "new-id",
                "cc-bridge",
                "project",
                "/srv/a",
                "http://10.0.0.2:7823/mcp",
            ),
            target(
                "other",
                "unrelated",
                "project",
                "/srv/a",
                "http://127.0.0.1:7823/mcp",
            ),
        ];
        let hit = same_entry(&saved(None, "project", "/srv/a"), &remote).unwrap();
        assert_eq!(hit.id, "new-id");
    }

    #[test]
    fn ambiguous_entries_are_never_guessed() {
        let remote = vec![
            target(
                "a",
                "cc-bridge",
                "project",
                "/srv/a",
                "http://10.0.0.2:7823/mcp",
            ),
            target(
                "b",
                "cc-bridge",
                "project",
                "/srv/a",
                "http://10.0.0.3:7823/mcp",
            ),
        ];
        assert!(same_entry(&saved(None, "project", "/srv/a"), &remote).is_none());
    }

    #[test]
    fn a_renamed_entry_is_matched_through_its_bridge_identity() {
        // 用户在服务器上改了条目名，id 也随内容变化，只剩 inspect 判定的桥身份可用。
        let remote = vec![target(
            "renamed",
            "my-bridge",
            "project",
            "/srv/a",
            "http://10.0.0.2:7823/mcp",
        )];
        let hit = same_entry(&saved(None, "project", "/srv/a"), &remote).unwrap();
        assert_eq!(hit.id, "renamed");
    }

    #[test]
    fn a_user_scope_entry_matches_without_a_project_path() {
        let remote = vec![target(
            "user-entry",
            "cc-bridge",
            "user",
            "/home/lizuliang",
            "http://10.0.0.2:7823/mcp",
        )];
        let hit = same_entry(&saved(None, "user", ""), &remote).unwrap();
        assert_eq!(hit.id, "user-entry");
    }
}
