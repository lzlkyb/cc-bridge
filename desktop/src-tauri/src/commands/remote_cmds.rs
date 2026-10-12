//! P1 远程访问命令：TLS 证书状态与重生成。
//!
//! 只读/触发型薄封装，逻辑全部在 `mcp::tls`——本文件保持零业务逻辑，
//! 便于后续接「远程接入向导」时直接复用。

use std::sync::Arc;

use tauri::State;

use crate::mcp::tls;
use crate::state::AppState;

/// 当前 TLS 证书信息 + 开关状态（设置页「HTTPS 远程访问」区）。
#[tauri::command(rename_all = "snake_case")]
pub async fn get_tls_status(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let (enabled, host, ban_enabled, ban_threshold, ban_window_min) = {
        let c = state.config.read().await;
        (
            c.remote_tls_enabled,
            c.host.clone(),
            c.remote_ban_enabled,
            c.remote_ban_threshold,
            c.remote_ban_window_min,
        )
    };
    let cert =
        tls::ensure_cert(&state.data_dir, &tls::detect_local_ips()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "enabled": enabled,
        "boundToAll": host == "0.0.0.0",
        "fingerprintSha256": cert.fingerprint_sha256,
        "fingerprintShort": cert.fingerprint_short(),
        "notAfterEpoch": cert.not_after_epoch,
        "sans": cert.sans,
        "regenerated": cert.regenerated,
        "regenerateReason": cert.regenerate_reason,
        "banEnabled": ban_enabled,
        "banThreshold": ban_threshold,
        "banWindowMin": ban_window_min,
    }))
}

/// 手动重新生成自签证书（怀疑泄露 / 想换指纹场景），返回新证书信息。
#[tauri::command(rename_all = "snake_case")]
pub async fn regen_tls_cert(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let ips = tls::detect_local_ips();
    // 重生成 = 删三件套后 ensure_cert（走「缺失」分支）。
    let dir = state.data_dir.join("certs");
    let _ = std::fs::remove_file(dir.join("self-signed.crt"));
    let _ = std::fs::remove_file(dir.join("self-signed.key"));
    let _ = std::fs::remove_file(dir.join("meta.json"));
    let cert = tls::ensure_cert(&state.data_dir, &ips).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "fingerprintSha256": cert.fingerprint_sha256,
        "fingerprintShort": cert.fingerprint_short(),
        "notAfterEpoch": cert.not_after_epoch,
        "sans": cert.sans,
    }))
}
