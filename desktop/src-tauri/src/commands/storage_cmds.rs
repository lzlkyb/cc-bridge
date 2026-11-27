use crate::{config::BridgeConfig, state::AppState, storage_maintenance::*};
use chrono::Local;
use serde::Serialize;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub groups: Vec<GroupUsage>,
    pub volume: Option<VolumeUsage>,
    pub policy: StoragePolicy,
    pub history: Vec<CleanupRun>,
    pub warnings: Vec<String>,
    pub scanned_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePreview {
    pub token: Uuid,
    pub items: Vec<CleanupItem>,
    pub warnings: Vec<String>,
}

fn paths(app: &AppHandle, state: &AppState, config: &BridgeConfig) -> StoragePaths {
    StoragePaths {
        data: state.data_dir.clone(),
        // On Windows Tauri assigns app_local_data_dir as the WebView2 data directory.
        // This browser-owned tree is for usage only. It is never eligible for cleanup.
        webview: if cfg!(windows) {
            app.path().app_local_data_dir().ok()
        } else {
            None
        },
        backup: crate::backup::backup_dir_abs(&state.data_dir, &config.backup_dir),
        version: app.package_info().version.clone(),
        generation: state.storage.generation,
        audit_days: config.audit_retention_days,
        journal_days: config.journal_retention_days.max(1),
    }
}

async fn current_paths(app: &AppHandle, state: &AppState) -> StoragePaths {
    let config = state.config.read().await;
    paths(app, state, &config)
}

async fn inventory(paths: StoragePaths) -> Result<Inventory, String> {
    tokio::task::spawn_blocking(move || inspect(&paths))
        .await
        .map_err(|error| format!("存储扫描中断：{error}"))
}

async fn persisted(state: &AppState) -> Result<Persisted, String> {
    let db = state.db.lock().await;
    Persisted::load(&db)
}

async fn save(state: &AppState, persisted: &Persisted) -> Result<(), String> {
    let db = state.db.lock().await;
    persisted.save(&db)
}

#[tauri::command]
pub async fn get_storage_overview(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<StorageOverview, String> {
    let _guard = state.storage.gate.lock().await;
    let persisted = persisted(&state).await?;
    let inventory = inventory(current_paths(&app, &state).await).await?;
    Ok(StorageOverview {
        groups: inventory.groups,
        volume: inventory.volume,
        warnings: inventory.warnings,
        policy: persisted.policy,
        history: persisted.history,
        scanned_at: Local::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn preview_storage_cleanup(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<StoragePreview, String> {
    let mut slot = state.storage.gate.lock().await;
    let paths = current_paths(&app, &state).await;
    let plan = tokio::task::spawn_blocking(move || plan_cleanup(&paths))
        .await
        .map_err(|error| format!("存储扫描中断：{error}"))?;
    let response = StoragePreview {
        token: plan.token,
        items: plan.items(),
        warnings: plan.warnings(),
    };
    *slot = Some(plan);
    Ok(response)
}

#[tauri::command]
pub async fn apply_storage_cleanup(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    token: String,
    kinds: Vec<CleanupKind>,
) -> Result<CleanupRun, String> {
    let token = Uuid::parse_str(&token).map_err(|_| "清理预览无效，请重新预览")?;
    let mut slot = state.storage.gate.lock().await;
    if !slot
        .as_ref()
        .is_some_and(|plan| plan.accepts(token, &kinds))
    {
        return Err("清理预览已失效，请重新预览".into());
    }
    let mut persisted = persisted(&state).await?;
    let plan = slot
        .take()
        .expect("the preview was checked under the same lock");
    // Keep applied retention stable from revalidation through the actual deletion.
    let config = state.config.read().await;
    let paths = paths(&app, &state, &config);
    let mut result =
        tokio::task::spawn_blocking(move || plan.execute(&paths, CleanupSource::Manual, &kinds))
            .await
            .map_err(|error| format!("清理任务中断：{error}"))?;
    drop(config);
    persisted.record(result.clone());
    if let Err(error) = save(&state, &persisted).await {
        // Deletion has already happened. Keep the actual result visible instead of asking the
        // user to retry the operation just because the history could not be written.
        log::warn!("无法保存维护记录：{error}");
        result.recorded = false;
    }
    let _ = app.emit("storage:changed", ());
    Ok(result)
}

#[tauri::command]
pub async fn save_storage_policy(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    policy: StoragePolicy,
) -> Result<StoragePolicy, String> {
    policy.validate()?;
    let _guard = state.storage.gate.lock().await;
    let mut persisted = persisted(&state).await?;
    // Changing the displayed time should not unexpectedly trigger an immediate cleanup.
    if persisted.policy.daily_time != policy.daily_time
        || !persisted.policy.auto_clean && policy.auto_clean
    {
        persisted.last_slot = policy.scheduled_slot(Local::now());
    }
    persisted.policy = policy;
    save(&state, &persisted).await?;
    state
        .storage
        .last_reminder_probe
        .store(0, Ordering::Relaxed);
    let _ = app.emit("storage:changed", ());
    Ok(persisted.policy)
}

#[tauri::command]
pub fn take_storage_navigation(state: State<'_, Arc<AppState>>) -> bool {
    state
        .storage
        .pending_navigation
        .swap(false, Ordering::AcqRel)
}

pub fn request_storage_navigation(app: &AppHandle, state: &AppState) {
    state
        .storage
        .pending_navigation
        .store(true, Ordering::Release);
    let _ = app.emit("storage:navigate", ());
}

#[derive(Clone, Serialize)]
struct StorageAlert {
    title: &'static str,
    body: String,
}

pub async fn storage_maintenance_tick(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let Ok(_guard) = state.storage.gate.try_lock() else {
        return Ok(());
    };
    let now = Local::now();
    let mut persisted = persisted(state).await?;
    if let Some(slot) = persisted.policy.scheduled_slot(now) {
        if persisted.last_slot.is_none_or(|last| last < slot) {
            let config = state.config.read().await;
            let paths = paths(app, state, &config);
            let result = tokio::task::spawn_blocking(move || {
                let plan = plan_cleanup(&paths);
                let kinds: Vec<_> = plan.items().into_iter().map(|item| item.kind).collect();
                plan.execute(&paths, CleanupSource::Scheduled, &kinds)
            })
            .await
            .map_err(|error| format!("自动清理中断：{error}"))?;
            drop(config);
            persisted.last_slot = Some(slot);
            persisted.record(result);
            save(state, &persisted).await?;
            let _ = app.emit("storage:changed", ());
        }
    }

    let stamp = now.timestamp();
    let last_check = state.storage.last_reminder_probe.load(Ordering::Relaxed);
    if (0..900).contains(&stamp.saturating_sub(last_check)) {
        return Ok(());
    }
    let disk = persisted.policy.disk_alert && alert_due(persisted.disk_alert_at, stamp);
    let backups = persisted.policy.backup_alert && alert_due(persisted.backup_alert_at, stamp);
    if !disk && !backups {
        return Ok(());
    }
    let paths = current_paths(app, state).await;
    let (volume, backup_bytes) = tokio::task::spawn_blocking(move || {
        (
            disk.then(|| measure_volume(&paths.data)).flatten(),
            backups
                .then(|| measure_backup(&paths.backup).ok())
                .flatten(),
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    let mut alerts = Vec::new();
    if let Some(volume) =
        volume.filter(|v| v.free_bytes < u64::from(persisted.policy.min_free_gb) * GIB)
    {
        alerts.push(StorageAlert {
            title: "磁盘空间不足",
            body: format!(
                "{} 剩余 {:.2} GB。查看 CC Bridge 中可以清理的项目。",
                volume.label,
                volume.free_bytes as f64 / GIB as f64
            ),
        });
        persisted.disk_alert_at = Some(stamp);
    }
    if let Some(bytes) =
        backup_bytes.filter(|&bytes| bytes > u64::from(persisted.policy.backup_limit_gb) * GIB)
    {
        alerts.push(StorageAlert {
            title: "备份占用超过阈值",
            body: format!(
                "文件备份已占用 {:.2} GB，可打开存储设置查看。",
                bytes as f64 / GIB as f64
            ),
        });
        persisted.backup_alert_at = Some(stamp);
    }
    if !alerts.is_empty() {
        save(state, &persisted).await?;
    }
    state
        .storage
        .last_reminder_probe
        .store(stamp, Ordering::Relaxed);
    for alert in alerts {
        notify(app, alert);
    }
    Ok(())
}

#[cfg(feature = "notifications")]
const STORAGE_ACTIONS: &str = "storage-maintenance";
#[cfg(feature = "notifications")]
const OPEN_STORAGE: &str = "storage-maintenance-open";

#[cfg(feature = "notifications")]
pub fn register_storage_notification(
    app: &AppHandle,
    open: impl Fn() + Send + Sync + 'static,
) -> tauri_plugin_notification::Result<()> {
    use tauri_plugin_notification::{Action, ActionType, NotificationExt};
    let notification = app.notification();
    notification.register_action_types(vec![ActionType::builder(STORAGE_ACTIONS)
        .actions(vec![
            Action::builder(OPEN_STORAGE, "查看存储").build(),
            Action::builder("storage-maintenance-later", "稍后提醒").build(),
        ])
        .build()])?;
    notification.on_action(move |action| {
        if action.action_id() == OPEN_STORAGE
            || action.action_id() == "tap"
                && action
                    .notification()
                    .is_some_and(|item| (90_741..=90_742).contains(&item.id()))
        {
            open();
        }
    })
}

fn notify(app: &AppHandle, alert: StorageAlert) {
    // A user already looking at the window gets one actionable in-app alert. A hidden or
    // minimized window uses the native system notification instead of waking its webview.
    let visible = app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(true)
            && window.is_focused().unwrap_or(false)
    });
    if visible {
        let _ = app.emit("storage:alert", &alert);
    }
    #[cfg(feature = "notifications")]
    if !visible {
        use tauri_plugin_notification::NotificationExt;
        let id = if alert.title == "磁盘空间不足" {
            90_741
        } else {
            90_742
        };
        if let Err(error) = app
            .notification()
            .builder()
            .id(id)
            .title(alert.title)
            .body(alert.body)
            .action_type_id(STORAGE_ACTIONS)
            .show()
        {
            log::warn!("存储提醒发送失败：{error}");
        }
    }
}
