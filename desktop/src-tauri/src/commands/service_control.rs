use crate::state::AppState;
use serde::Serialize;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceControl {
    pub pending: Option<String>,
    pub error: Option<String>,
}

struct Operation {
    state: Arc<AppState>,
    app: AppHandle,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.state
            .service_control
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending = None;
        let _ = self.app.emit("mcp-status-changed", ());
    }
}

/// One lock covers bind confirmation as well as stop, so shortcuts cannot reverse another action.
pub async fn control_service(
    state: &Arc<AppState>,
    app: &AppHandle,
    action: &str,
) -> Result<(), String> {
    let _lock = state
        .service_operation
        .try_lock()
        .map_err(|_| "本机服务正在处理，请等待当前操作完成。")?;
    control_service_locked(state, app, action).await
}

/// Caller holds service_operation across configuration import and listener replacement.
pub(super) async fn control_service_locked(
    state: &Arc<AppState>,
    app: &AppHandle,
    action: &str,
) -> Result<(), String> {
    *state
        .service_control
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = ServiceControl {
        pending: Some(action.into()),
        error: None,
    };
    let _operation = Operation {
        state: state.clone(),
        app: app.clone(),
    };
    let _ = app.emit("mcp-status-changed", ());
    *state
        .local_access_probe
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    *state
        .startup_error
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    let result = if action == "stop" {
        if let Some(handle) = state.mcp_server_handle.lock().await.take() {
            handle.abort();
        }
        state.mcp_running.store(false, Ordering::SeqCst);
        Ok(())
    } else {
        state.mcp_running.store(false, Ordering::SeqCst);
        crate::mcp::http::restart_server(state).await;
        let ready =
            crate::mcp::http::wait_listening(state, std::time::Duration::from_secs(2)).await;
        if ready {
            Ok(())
        } else {
            Err(state
                .startup_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
                .unwrap_or_else(|| "本机服务未能开始监听，请查看日志后重试。".into()))
        }
    };
    state
        .service_control
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .error = result.as_ref().err().cloned();
    result
}
