//! 自动更新的清单检查、安装包准备和用户确认后的安装。

use std::sync::{atomic::AtomicBool, Arc, LazyLock, Mutex};

use tauri::{Emitter, State};

use super::update_cache::{
    cached_package, download_verified_package, package_path, persist_package, read_metadata,
    save_metadata, PackageDownloadError, PreparedUpdate,
};
use super::update_policy::parse_version;
use super::update_safety::read_update_activity;
use super::update_sources::{check_sources, download_sources, updater, CheckError};
use crate::state::AppState;

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL_DOWNLOAD: LazyLock<tokio::sync::watch::Sender<u64>> =
    LazyLock::new(|| tokio::sync::watch::channel(0).0);
static UPDATE_SESSION: Mutex<UpdateSession> = Mutex::new(UpdateSession {
    prepared: None,
    installed: None,
});

struct UpdateSession {
    prepared: Option<PreparedUpdate>,
    installed: Option<tauri_plugin_updater::Update>,
}

fn update_notice(update: &tauri_plugin_updater::Update) -> serde_json::Value {
    serde_json::json!({
        "version": update.version,
        "body": update.body,
        "date": update.date.map(|date| date.to_string()),
        "currentVersion": update.current_version,
        "source": "download",
    })
}

fn report_pending_restart(app: &tauri::AppHandle) -> bool {
    let installed = UPDATE_SESSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .installed
        .clone();
    let Some(installed) = installed else {
        return false;
    };
    let _ = app.emit("update:available", update_notice(&installed));
    let _ = app.emit("update:ready", ());
    true
}

fn meets_minimum(version: &str, minimum: Option<(u64, u64, u64)>) -> bool {
    minimum.is_none_or(|min| parse_version(version).is_some_and(|version| version >= min))
}

async fn wait_until_obsolete(
    minimum: &mut tokio::sync::watch::Receiver<Option<String>>,
    version: &str,
) {
    let _ = minimum
        .wait_for(|current| !meets_minimum(version, current.as_deref().and_then(parse_version)))
        .await;
}

fn stage_update(app: &tauri::AppHandle, package: PreparedUpdate, flight: SingleFlight) {
    let mut notice = update_notice(&package.update);
    notice["size"] = serde_json::json!(package.size);
    UPDATE_SESSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .prepared = Some(package);
    // The event may immediately trigger another preparation if the minimum has changed.
    drop(flight);
    let _ = app.emit("update:staged", notice);
}

async fn reserve_cached_package(
    flag: &'static AtomicBool,
    verified_size: impl std::future::Future<Output = Option<usize>>,
) -> Option<(usize, SingleFlight)> {
    // A miss must never occupy the slot and swallow a simultaneous prepare request.
    let size = verified_size.await?;
    Some((size, SingleFlight::acquire(flag)?))
}

async fn restore_cached_update(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    update: &tauri_plugin_updater::Update,
) -> bool {
    let cache_path = path.to_owned();
    let candidate = update.clone();
    let Some((size, flight)) = reserve_cached_package(&UPDATE_RUNNING, async {
        tokio::task::spawn_blocking(move || {
            cached_package(
                &cache_path,
                &candidate.version,
                &candidate.signature,
                |bytes| candidate.verify(bytes).is_ok(),
            )
            .map(|bytes| bytes.len())
        })
        .await
        .ok()
        .flatten()
    })
    .await
    else {
        return false;
    };
    {
        let session = UPDATE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
        if session.installed.is_some()
            || session.prepared.as_ref().is_some_and(|prepared| {
                prepared.update.version != update.version
                    || prepared.update.signature != update.signature
            })
        {
            // A newer preparation or installation could have completed while we were reading.
            return false;
        }
    }
    stage_update(
        app,
        PreparedUpdate {
            update: update.clone(),
            path: path.to_owned(),
            memory: None,
            size,
        },
        flight,
    );
    true
}

// ===== 自动更新（后台线程，不阻塞 UI），採自 PastePanda 实现 =====

/// 单飞闸：同一时刻只允许一个更新 / 检查任务在跑。
///
/// 🔴 为什么需要（审查 P2）：`start_update` / `check_update` 是 **spawn 后立即返回**的，
/// 前端却把 `await invoke(...)` 当成「做完了」的信号。于是连点两次徽章 = 两个任务并发，
/// 一边下载一边又被另一个重试覆盖，`update:*` 事件交叉推送，前端状态机直接乱掉。
/// RAII 式持有：任务（含所有提前 return 分支）结束自动释放。
struct SingleFlight(&'static std::sync::atomic::AtomicBool);

impl SingleFlight {
    fn acquire(flag: &'static std::sync::atomic::AtomicBool) -> Option<Self> {
        flag.compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .ok()
        .map(|_| Self(flag))
    }
}

impl Drop for SingleFlight {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 指数退避重试辅助函数。
///
/// `should_retry` 决定某个错误是否值得再试一次。**不能无条件重试**：更新源返回
/// "没有可用 manifest" 这类确定性结论时，重试 N 次只会让用户多等 N 次退避
/// （2026-10-22 实测：Gitee 源的 releases 分支失效后 404，旧逻辑每次检查白等
/// 1s+2s 共 3.5 秒才回退到 ghproxy，用户感知就是"点更新要转半天"）。
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    should_retry: impl Fn(&E) -> bool,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                if !should_retry(&e) {
                    log::info!("[Update] {operation_name} 遇到不可重试错误，立即换源: {e}");
                    return Err(e);
                }
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                let delay_secs = 1u64 << (attempt - 1);
                log::warn!(
                    "[Update] {} 失败（第 {}/{} 次），{} 秒后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        }
    }
}

/// 给更新失败打一个**机器可读**的原因标签，随 `update:error` 一起发给前端。
///
/// 为什么不用字符串判断：前端原先靠 `includes("fetch")` 之类猜原因，而插件的错误文案
/// 是英文常量（`Could not fetch a valid release JSON from the remote`），一句文案改动
/// 就能让整套翻译失效 —— 2026-10-22 实测就是这样：源上 404（根本没有 manifest）被
/// 翻译成「网络连接失败，请检查网络后重试」，而真正的网络错误
/// （`error sending request`）反而落到兜底「更新失败，请重试」。
///
/// 返回的标签由前端 `ERROR_TEXT` 表消费，**不要在日志或 UI 里直接展示**。
pub(super) fn classify_update_error(err: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as UpdaterError;
    match err {
        // 源上没有可用 manifest：404 / 5xx（插件把非 2xx 都归到这里）/ JSON 结构不符 / 缺当前平台条目。
        UpdaterError::ReleaseNotFound
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_) => "manifest",
        // 验签失败：包可能被篡改或下载损坏，必须与「普通下载失败」区分开。
        UpdaterError::Minisign(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => "signature",
        UpdaterError::Reqwest(e) => {
            if e.is_timeout() {
                "timeout"
            } else {
                "network"
            }
        }
        UpdaterError::Network(_) => "network",
        // 更新源配置本身不合法（URL 协议错、没有端点、平台不支持），重试无意义。
        UpdaterError::EmptyEndpoints
        | UpdaterError::UnsupportedOs
        | UpdaterError::UnsupportedArch => "config",
        // 包已经下到本地，卡在落盘 / 解开 / 启动安装器。
        UpdaterError::Io(_)
        | UpdaterError::PackageInstallFailed
        | UpdaterError::DebInstallFailed
        | UpdaterError::TempDirNotOnSameMountPoint
        | UpdaterError::TempDirNotFound
        | UpdaterError::BinaryNotFoundInArchive
        | UpdaterError::InvalidUpdaterFormat
        | UpdaterError::FailedToDetermineExtractPath => "install",
        _ => "unknown",
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateInstallKind {
    Installed,
    #[cfg_attr(not(windows), allow(dead_code))]
    Portable,
}

#[tauri::command]
pub fn update_install_kind() -> UpdateInstallKind {
    #[cfg(windows)]
    if !matches!(
        tauri::utils::platform::bundle_type(),
        Some(tauri::utils::config::BundleType::Nsis)
    ) && !cfg!(debug_assertions)
    {
        return UpdateInstallKind::Portable;
    }
    UpdateInstallKind::Installed
}

/// Dropping the download future preserves its validated partial file for the next retry.
#[tauri::command]
pub fn cancel_update() {
    CANCEL_DOWNLOAD.send_modify(|generation| *generation = generation.wrapping_add(1));
}

fn emit_error(app: &tauri::AppHandle, message: String, code: &str, source: &str) {
    let _ = app.emit(
        "update:error",
        serde_json::json!({ "message": message, "code": code, "source": source }),
    );
}

fn retry_download(error: &PackageDownloadError) -> bool {
    matches!(error, PackageDownloadError::Updater(tauri_plugin_updater::Error::Reqwest(e))
        if e.is_connect() || e.is_timeout() || e.is_body())
}

async fn prepare_download(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    preferred: Option<&str>,
    live_minimum: &mut tokio::sync::watch::Receiver<Option<String>>,
) -> Result<Option<(tauri_plugin_updater::Update, Vec<u8>, bool)>, CheckError> {
    let (mut candidates, custom) = check_sources(app).await?;
    let minimum = preferred
        .and_then(parse_version)
        .max(live_minimum.borrow().as_deref().and_then(parse_version));
    candidates.retain(|update| meets_minimum(&update.version, minimum));
    let Some(newest) = candidates
        .first()
        .map(|candidate| candidate.version.clone())
    else {
        return Err((
            "更新源暂未提供所需版本，请重新检查或手动下载".into(),
            "stale",
        ));
    };
    // Once selected, a slower mirror may supply bytes only for this same version.
    candidates.retain(|update| update.version == newest);
    let mut last_error = ("没有可用的下载地址".into(), "manifest");
    for update in download_sources(candidates, custom) {
        let _ = app.emit("update:available", update_notice(&update));
        let candidate = update.clone();
        let cache_path = path.to_owned();
        let local = tokio::task::spawn_blocking(move || {
            cached_package(
                &cache_path,
                &candidate.version,
                &candidate.signature,
                |bytes| candidate.verify(bytes).is_ok(),
            )
        })
        .await
        .ok()
        .flatten();
        if let Some(bytes) = local {
            return Ok(Some((update, bytes, true)));
        }
        let preparation = retry_with_backoff(1, "下载更新", retry_download, || {
            download_verified_package(app, update.clone(), path)
        });
        let result = tokio::select! {
            biased;
            _ = wait_until_obsolete(live_minimum, &update.version) => return Ok(None),
            result = preparation => result,
        };
        match result {
            Ok(bytes) => return Ok(Some((update, bytes, false))),
            Err(error) => {
                let code = match &error {
                    PackageDownloadError::TooLarge => "package_size",
                    PackageDownloadError::Updater(error) => classify_update_error(error),
                    PackageDownloadError::InvalidRange => "network",
                };
                last_error = (format!("下载或校验更新失败: {error}"), code);
            }
        }
    }
    Err(last_error)
}

/// Prepare one package. Installation always requires a separate user action.
#[tauri::command]
pub fn start_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    min_supported_version: Option<String>,
    requested_version: Option<String>,
) {
    if report_pending_restart(&app) {
        return;
    }
    if matches!(update_install_kind(), UpdateInstallKind::Portable) {
        emit_error(
            &app,
            "请下载新的 Windows 便携版 ZIP".into(),
            "portable",
            "download",
        );
        return;
    }
    let Some(guard) = SingleFlight::acquire(&UPDATE_RUNNING) else {
        // The current preparation will emit its own result. Replaying an older cached
        // package here would replace the progress and version of a newer download.
        return;
    };
    let path = package_path(&state.data_dir);
    let mut minimum = state.update_minimum.subscribe();
    let mut cancel = CANCEL_DOWNLOAD.subscribe();
    let preferred = requested_version
        .as_deref()
        .into_iter()
        .chain(min_supported_version.as_deref())
        .max_by_key(|v| parse_version(v))
        .map(str::to_string);
    tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            biased;
            _ = cancel.changed() => {
                drop(guard);
                let _ = app.emit("update:cancelled", ());
                return;
            }
            result = tokio::time::timeout(
                std::time::Duration::from_secs(300),
                prepare_download(&app, &path, preferred.as_deref(), &mut minimum)
            ) => result,
        };
        match result {
            Ok(Ok(Some((update, bytes, cached)))) => {
                let size = bytes.len();
                let cache = path.clone();
                let metadata = update.clone();
                let memory = tokio::task::spawn_blocking(move || {
                    if !cached {
                        if let Err(error) =
                            persist_package(&cache, &metadata.version, &metadata.signature, &bytes)
                        {
                            log::warn!("[Update] 无法缓存更新: {error}");
                            return Some(Arc::<[u8]>::from(bytes));
                        }
                    }
                    if let Err(error) = save_metadata(&cache, &metadata) {
                        log::warn!("[Update] 无法缓存更新清单: {error}");
                    }
                    None
                })
                .await
                .unwrap_or_default();
                if cancel.has_changed().unwrap_or(false) {
                    drop(guard);
                    let _ = app.emit("update:cancelled", ());
                } else if !meets_minimum(
                    &update.version,
                    minimum.borrow().as_deref().and_then(parse_version),
                ) {
                    drop(guard);
                    let _ = app.emit("update:obsolete", ());
                } else {
                    stage_update(
                        &app,
                        PreparedUpdate {
                            update,
                            memory,
                            path,
                            size,
                        },
                        guard,
                    );
                }
            }
            Ok(Ok(None)) => {
                drop(guard);
                let _ = app.emit("update:obsolete", ());
            }
            Ok(Err((message, code))) => {
                drop(guard);
                emit_error(&app, message, code, "download");
            }
            Err(_) => {
                drop(guard);
                emit_error(&app, "安装包下载超时".into(), "timeout", "download");
            }
        }
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOutcome {
    #[cfg(not(windows))]
    Installed,
    #[cfg(windows)]
    Launching,
    Busy,
    Unavailable,
}

#[tauri::command]
pub async fn install_prepared_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    version: String,
) -> Result<InstallOutcome, String> {
    let Some(_flight) = SingleFlight::acquire(&UPDATE_RUNNING) else {
        return Ok(InstallOutcome::Busy);
    };
    let (update, memory, path) = {
        let slot = UPDATE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
        let Some(package) = slot
            .prepared
            .as_ref()
            .filter(|p| p.update.version == version)
        else {
            return Ok(InstallOutcome::Unavailable);
        };
        (
            package.update.clone(),
            package.memory.clone(),
            package.path.clone(),
        )
    };
    let payload = if let Some(bytes) = memory {
        Some(bytes)
    } else {
        let candidate = update.clone();
        tokio::task::spawn_blocking(move || {
            cached_package(&path, &candidate.version, &candidate.signature, |bytes| {
                candidate.verify(bytes).is_ok()
            })
            .map(Arc::<[u8]>::from)
        })
        .await
        .map_err(|err| err.to_string())?
    };
    let Some(payload) = payload else {
        return Ok(InstallOutcome::Unavailable);
    };
    // Check after loading and verifying the bytes: work may have started while disk I/O ran.
    if !read_update_activity(&state).await?.is_idle() {
        return Ok(InstallOutcome::Busy);
    }
    let minimum = state
        .update_minimum
        .borrow()
        .as_deref()
        .and_then(parse_version);
    if !meets_minimum(&update.version, minimum) {
        return Ok(InstallOutcome::Unavailable);
    }
    #[cfg(windows)]
    {
        if matches!(update_install_kind(), UpdateInstallKind::Portable) {
            return Ok(InstallOutcome::Unavailable);
        }
        let dir = state.data_dir.clone();
        tokio::task::spawn_blocking(move || {
            update.verify(&payload).map_err(|err| err.to_string())?;
            super::update_windows::launch_nsis(&dir, &payload)
        })
        .await
        .map_err(|err| err.to_string())??;
        // NSIS can wait for this process now that Windows has accepted the launch.
        // Use the normal exit path so the bridge can persist state and stop its children.
        app.exit(0);
        Ok(InstallOutcome::Launching)
    }
    #[cfg(not(windows))]
    {
        let installed = update.clone();
        tokio::task::spawn_blocking(move || update.install(&*payload))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?;
        let package = {
            let mut session = UPDATE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
            session.installed = Some(installed);
            session.prepared.take()
        };
        if let Some(package) = package {
            let _ = tokio::fs::remove_file(package.path.with_extension("manifest.json")).await;
            let _ = tokio::fs::remove_file(package.path).await;
        }
        let _ = app.emit("update:ready", ());
        Ok(InstallOutcome::Installed)
    }
}

/// Refresh the cached package and look for a newer release. IPC stays pending until this check ends.
#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if report_pending_restart(&app) {
        return Ok(());
    }
    static CHECK_RUNNING: AtomicBool = AtomicBool::new(false);
    let Some(_check) = SingleFlight::acquire(&CHECK_RUNNING) else {
        return Ok(());
    };
    let _ = app.emit("update:checking", ());
    #[cfg(windows)]
    if !UPDATE_RUNNING.load(std::sync::atomic::Ordering::Acquire) {
        super::update_windows::clean_installers(&state.data_dir);
    }
    let path = package_path(&state.data_dir);
    let portable = matches!(update_install_kind(), UpdateInstallKind::Portable);
    // Restore as soon as possible, including offline. The updater requires a version-bound
    // signature for restored metadata, and restoration verifies the payload before it is shown.
    if !portable {
        let load_path = path.clone();
        if let Some(raw) = tokio::task::spawn_blocking(move || read_metadata(&load_path))
            .await
            .ok()
            .flatten()
        {
            if let Ok(Some(update)) = updater(&app, None).and_then(|updater| {
                updater
                    .restore_update(raw)
                    .map_err(|error| error.to_string())
            }) {
                restore_cached_update(&app, &path, &update).await;
            }
        }
    }
    match check_sources(&app).await {
        Ok((updates, _)) => {
            if let Some(update) = updates.first() {
                // Older clients wrote only package bytes. A trusted online update can recover them.
                if portable || !restore_cached_update(&app, &path, update).await {
                    let mut notice = update_notice(update);
                    notice["source"] = serde_json::json!("check");
                    let _ = app.emit("update:available", notice);
                }
            } else {
                let _ = app.emit("update:uptodate", ());
            }
        }
        Err((message, code)) => emit_error(&app, message, code, "check"),
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri_plugin_updater::Error as UpdaterError;

    #[tokio::test]
    async fn cache_miss_does_not_reserve_the_download_slot() {
        static FLIGHT: AtomicBool = AtomicBool::new(false);
        let restored = reserve_cached_package(&FLIGHT, async {
            assert!(
                SingleFlight::acquire(&FLIGHT).is_some(),
                "强制下载必须能在缓存校验期间启动"
            );
            None
        })
        .await;
        assert!(restored.is_none());
    }

    #[tokio::test]
    async fn only_an_ineligible_download_is_cancelled_by_policy() {
        let (minimum, mut changes) = tokio::sync::watch::channel(None);
        let wait = wait_until_obsolete(&mut changes, "3.5.0");
        tokio::pin!(wait);
        assert!(futures_util::poll!(wait.as_mut()).is_pending());
        minimum.send_replace(Some("3.5.0".into()));
        assert!(futures_util::poll!(wait.as_mut()).is_pending());
        minimum.send_replace(Some("3.5.1".into()));
        assert!(futures_util::poll!(wait.as_mut()).is_ready());
    }

    /// 源上没有 manifest（404/5xx/缺当前平台条目）必须与「网络故障」区分开：
    /// 前者该告诉用户「服务暂时不可用」，后者才是「检查网络」。
    /// 前端按这个标签出文案，所以标签本身不能漂。
    #[test]
    fn classify_separates_manifest_from_network() {
        assert_eq!(
            classify_update_error(&UpdaterError::ReleaseNotFound),
            "manifest"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::TargetNotFound("windows-x86_64".into())),
            "manifest"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::Network("connection reset".into())),
            "network"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::EmptyEndpoints),
            "config"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::UnsupportedOs),
            "config"
        );
        // 未知错误走 unknown，前端回退到字符串启发式（不会把原因说死）。
        assert_eq!(classify_update_error(&UpdaterError::FormatDate), "unknown");
    }

    /// 不可重试错误必须**只调用一次**（改动前是 3 次，本测试即失败）。
    #[tokio::test]
    async fn non_retryable_error_is_attempted_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result: Result<(), UpdaterError> = retry_with_backoff(
            2,
            "检查更新",
            |_| false,
            || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(UpdaterError::ReleaseNotFound)
                }
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "404 类确定性错误不应重试（每次重试都要白等一轮退避）"
        );
    }

    /// 可重试错误保留原有语义：`max_retries=1` ⇒ 首次 + 重试 1 次 = 2 次调用。
    #[tokio::test]
    async fn retryable_error_is_attempted_again() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result: Result<(), UpdaterError> = retry_with_backoff(
            1,
            "检查更新",
            |_| true,
            || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(UpdaterError::Network("connection reset".into()))
                }
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2, "可重试错误应再试一次");
    }
}
