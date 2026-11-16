//! Stable-card reads use the pinned SSH identity and temporary credentials, with no remote mutations.
use crate::stable_connect::{fingerprint, friendly_error};
use crate::stable_discovery::{self as discovery, StableDiscovery, StableFolders};
use crate::state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::State;

async fn read_remote(
    state: &Arc<AppState>,
    id: &str,
    paths: (Option<&str>, Option<&str>),
    folders: bool,
    signature: Option<&str>,
    password: Option<String>,
    passphrase: Option<String>,
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
    let script = discovery::read_script(&config, id, path, folders, source_path);
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
pub async fn stable_connect_inspect(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    project_path: Option<String>,
    source_project_path: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<StableDiscovery, String> {
    let (output, signature) = read_remote(
        state.inner(),
        &connection_id,
        (project_path.as_deref(), source_project_path.as_deref()),
        false,
        None,
        password,
        passphrase,
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
    )
    .await?;
    let result: StableFolders = discovery::parse_result(&output, "CCB_LISTED")?;
    if result.signature != expected {
        return Err("服务器检查结果已失效，请重新检查。".into());
    }
    Ok(result)
}
