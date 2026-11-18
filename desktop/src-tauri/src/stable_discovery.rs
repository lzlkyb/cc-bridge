//! Read-only discovery receipts and precise, reviewed Claude MCP targets.
use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::config::BridgeConfig;
use crate::stable_connect::{fingerprint, shell_quote};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableTarget {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub project_path: String,
    pub project_key: Option<String>,
    pub config_file: String,
    pub url: String,
    pub fingerprint: String,
    pub recognized: bool,
    pub token_matches: bool,
}

#[derive(Deserialize)]
pub struct ConfiguredTarget {
    #[serde(flatten)]
    pub target: StableTarget,
    pub replaced: Option<ReplacedTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedTarget {
    pub config_file: String,
    pub url: String,
    pub backup: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigProof {
    pub scope: String,
    pub project_path: String,
    pub config_file: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableInspection {
    pub signature: String,
    pub complete: bool,
    pub files: Vec<ConfigProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableAccessRequest {
    pub target: Option<StableTarget>,
    pub inspection: StableInspection,
    #[serde(default)]
    pub scope_change: bool,
    /// 检查阶段服务器给该账号分配的隧道端口，配置时直接用它建隧道。
    #[serde(default)]
    pub tunnel_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteProject {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableDiscovery {
    pub signature: String,
    pub complete: bool,
    pub home: String,
    /// 服务器为该账号固定下来的反向隧道端口（共享服务器上每账号一个）。
    /// 老版本服务器不返回该字段，缺省为 None 时退回历史候选列表。
    #[serde(default)]
    pub tunnel_port: Option<u16>,
    pub inspected_project_path: Option<String>,
    pub projects: Vec<RemoteProject>,
    pub targets: Vec<StableTarget>,
    pub files: Vec<ConfigProof>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableFolders {
    pub signature: String,
    pub home: String,
    pub path: String,
    pub parent: String,
    pub directories: Vec<RemoteProject>,
    pub truncated: bool,
}

pub(crate) const REMOTE_INSPECT: &str = concat!(
    include_str!("stable_remote/common.py"),
    "\n",
    include_str!("stable_remote/inspect.py")
);
pub(crate) const REMOTE_FOLDERS: &str = concat!(
    include_str!("stable_remote/common.py"),
    "\n",
    include_str!("stable_remote/folders.py")
);

pub fn read_script(
    config: &BridgeConfig,
    id: &str,
    path: Option<&str>,
    folders: bool,
    source_path: Option<&str>,
) -> (String, String) {
    let saved = config
        .stable_connect
        .connections
        .iter()
        .find(|s| s.connection_id == id);
    let payload = serde_json::json!({
        "signature": fingerprint(config, id), "path": path, "sourceProjectPath": source_path,
        "deviceId": config.device_id, "token": config.token,
        "ports": [config.port, saved.map_or(config.port, |s| s.port)],
        "hints": [saved.map_or("", |s| s.project_path.as_str())],
    });
    let source = if folders {
        REMOTE_FOLDERS
    } else {
        REMOTE_INSPECT
    };
    (format!("command -v python3 >/dev/null 2>&1 || {{ echo CCB_PYTHON_MISSING; exit 42; }}; python3 -c {}", shell_quote(source)), payload.to_string())
}

/// Only framed, whitelisted output reaches this parser; neither PTY echo nor auth headers are returned.
pub fn parse_result<T: DeserializeOwned>(output: &str, marker: &str) -> Result<T, String> {
    if !output.lines().any(|line| line == marker) || output.contains("CCB_RESULT_OVERFLOW") {
        return Err("服务器检查没有返回完整结果，请重新检查。".into());
    }
    let encoded: String = output
        .lines()
        .filter_map(|line| line.strip_prefix("CCB_DATA "))
        .collect();
    if encoded.len() > 40 * 1024 {
        return Err("服务器检查结果过大，请选择一个项目后重新检查。".into());
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "服务器检查结果不完整，请重新检查。")?;
    if raw.len() > 28 * 1024 {
        return Err("服务器检查结果过大，请选择一个项目后重新检查。".into());
    }
    serde_json::from_slice(&raw).map_err(|_| "服务器检查结果无法读取，请重新检查。".into())
}

pub fn validate_access(
    config: &BridgeConfig,
    id: &str,
    scope: &str,
    path: &str,
    access: &StableAccessRequest,
) -> Result<(), String> {
    if access.inspection.signature != fingerprint(config, id) || !access.inspection.complete {
        return Err("服务器检查已失效或未完成，请重新检查后继续。".into());
    }
    if access.inspection.files.is_empty() || access.inspection.files.len() > 33 {
        return Err("服务器检查不完整，请重新检查。".into());
    }
    if let Some(target) = &access.target {
        let expected_scope = if target.scope == "local" {
            "project"
        } else {
            &target.scope
        };
        if (!access.scope_change && (scope != expected_scope || target.project_path != path.trim()))
            || target.name.is_empty()
            || target.name.len() > 256
            || target.name.contains(['\0', '\r', '\n'])
            || !["user", "project", "local"].contains(&target.scope.as_str())
            || target.fingerprint.len() != 64
            || !access
                .inspection
                .files
                .iter()
                .any(|f| f.config_file == target.config_file)
        {
            return Err("所选接入与检查结果不一致，请重新选择。".into());
        }
        if access.scope_change
            && (scope == expected_scope && target.project_path == path.trim()
                || !access
                    .inspection
                    .files
                    .iter()
                    .any(|f| f.scope == scope && f.project_path == path.trim()))
        {
            return Err("请先选择并检查新的使用范围，再应用更改。".into());
        }
    } else if access.scope_change {
        return Err("请先选择要更改范围的原接入。".into());
    } else if !access
        .inspection
        .files
        .iter()
        .any(|f| f.scope == scope && f.project_path == path.trim())
    {
        return Err("请先检查所选项目，再进行首次接入。".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "stable_discovery_tests.rs"]
mod tests;
