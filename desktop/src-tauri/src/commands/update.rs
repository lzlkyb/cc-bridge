//! 自动更新的清单检查、安装包准备和用户确认后的安装。

use std::{
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};

use tauri::{Emitter, State};

use super::update_cache::{
    cached_package, download_verified_package, package_path, persist_package, PackageDownloadError,
    PreparedUpdate,
};
use super::update_policy::parse_version;
use super::update_safety::read_update_activity;
use crate::state::AppState;

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);
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

fn stage_update(
    app: &tauri::AppHandle,
    package: PreparedUpdate,
    size: usize,
    flight: SingleFlight,
) {
    let mut notice = update_notice(&package.update);
    notice["size"] = serde_json::json!(size);
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
        },
        size,
        flight,
    );
    true
}

// ===== 自动更新（后台线程，不阻塞 UI），採自 PastePanda 实现 =====

/// 检查更新的整体时限。
///
/// 🔴 为什么需要（2026-11-10）：断网时（尤其「网卡连着但没有 Internet」）每个 HTTPS
/// 请求都要等 TCP 超时才失败，而检查链路是 3 个源 × 最多 3 次尝试 = 9 次请求，
/// 最坏能拖几分钟。这期间前端一直停在 `checking`（顶栏转圈），用户只会认为软件卡死。
/// 60s 足够覆盖「慢但能通」的正常场景；超过就是有问题，直接按 `timeout` 告知，
/// 让用户看到「连接更新服务器超时」而不是无限转圈。
const CHECK_DEADLINE: Duration = Duration::from_secs(60);

/// `start_update` 里「下载前复查」的时限。
///
/// 比独立检查更短：用户已经点了「下载安装」，卡 45s 还没开始下载，比直接告诉他
/// 「网络不可用，稍后重试」体验更差。
const PRE_DOWNLOAD_CHECK_DEADLINE: Duration = Duration::from_secs(45);

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

/// 判断「检查更新」的错误是否值得重试。
///
/// 这三类都是**确定性**结论 —— 源上压根没有可用 manifest（404 / 空响应），或者
/// manifest 里没有当前平台的条目。再请求一次还是同样的结果，唯一效果是让用户
/// 多等一轮退避。其余错误（连接超时、TLS 抖动、临时 5xx）保留重试。
fn is_retryable_check_error(err: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as UpdaterError;
    !matches!(
        err,
        UpdaterError::ReleaseNotFound
            | UpdaterError::TargetNotFound(_)
            | UpdaterError::TargetsNotFound(_)
    )
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
/// 注意 `is_retryable_check_error` 里的 `manifest` 三类与本函数保持一致。
fn classify_update_error(err: &tauri_plugin_updater::Error) -> &'static str {
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

/// 解析更新源端点：优先环境变量 `CCBRIDGE_UPDATE_ENDPOINT`（逗号分隔多 URL，按顺序故障转移），
/// 未设置或解析为空则返回 `None`（退回 `tauri.conf.json` 的 `plugins.updater.endpoints`）。
fn resolve_update_endpoints() -> Result<Option<Vec<url::Url>>, String> {
    let raw = match std::env::var("CCBRIDGE_UPDATE_ENDPOINT") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return Ok(None),
    };
    let mut eps = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        match url::Url::parse(trimmed) {
            Ok(u) => eps.push(u),
            Err(e) => return Err(format!("更新源 \"{trimmed}\" 不是合法 URL: {e}")),
        }
    }
    if eps.is_empty() {
        Ok(None)
    } else {
        Ok(Some(eps))
    }
}

/// Gitee 镜像仓库路径（owner/repo），CI 会把每次发版的产物 + manifest 同步到这里的
/// `releases` 分支 `latest/` 目录（见 .github/workflows/build.yml）。国内访问远比任何
/// 公共 GitHub 代理稳定，作为更新源的第一候选；失败时自动回退到 tauri.conf.json 配置的
/// ghproxy/GitHub 端点（见 candidate_endpoint_groups）。
///
/// 供同模块的 `update_policy` 复用，避免两处各写一份仓库路径、改一处忘另一处。
pub(super) const GITEE_REPOSITORY: &str = "lzul/cc-bridge";
/// GitHub 仓库（owner/repo），与 `tauri.conf.json` 的 updater 端点和发布脚本保持同一真源。
pub(super) const GITHUB_REPOSITORY: &str = "lzlkyb/cc-bridge";

/// 候选更新源分组，按顺序尝试：前一组检查或下载任一步失败，才换下一组。
/// 手动 env 覆盖（CCBRIDGE_UPDATE_ENDPOINT）存在时只用这一组、不做自动换源，保持覆盖语义单一可预期。
fn candidate_endpoint_groups() -> Result<Vec<Option<Vec<url::Url>>>, String> {
    if let Some(eps) = resolve_update_endpoints()? {
        return Ok(vec![Some(eps)]);
    }
    let gitee_url =
        format!("https://gitee.com/{GITEE_REPOSITORY}/raw/releases/latest/updater-gitee.json");
    let gitee = url::Url::parse(&gitee_url).map_err(|e| format!("Gitee 更新源 URL 无效: {e}"))?;
    Ok(vec![
        Some(vec![gitee]),
        None, // 退回 tauri.conf.json 配置的端点（现有 ghproxy → GitHub 两级）
    ])
}

/// A successful manifest response can still be stale. Try each mirror separately when enforcing
/// a minimum version so an older manifest cannot hide a usable package on the next mirror.
fn download_endpoint_groups(
    app: &tauri::AppHandle,
    forced: bool,
) -> Result<Vec<Option<Vec<url::Url>>>, String> {
    let groups = candidate_endpoint_groups()?;
    if !forced {
        return Ok(groups);
    }
    let mut sources = Vec::new();
    for group in groups {
        let endpoints = match group {
            Some(endpoints) => endpoints,
            None => app
                .config()
                .plugins
                .0
                .get("updater")
                .and_then(|config| config["endpoints"].as_array())
                .into_iter()
                .flatten()
                .filter_map(|item| item.as_str().and_then(|url| url::Url::parse(url).ok()))
                .collect(),
        };
        sources.extend(endpoints.into_iter().map(|endpoint| Some(vec![endpoint])));
    }
    Ok(sources)
}

/// 构造 `Updater`：注入指定的端点（若有），否则用配置端点。
/// 供 `check_update` / `start_update` 共用，确保更新源解析只有这一处实现（单一真相源）。
fn build_updater(
    app: &tauri::AppHandle,
    endpoints: Option<Vec<url::Url>>,
) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let app_handle = app.clone();
    let mut builder = app_handle.updater_builder();
    if let Some(eps) = endpoints {
        builder = builder
            .endpoints(eps)
            .map_err(|e| format!("更新源配置无效（需 https）: {e}"))?;
    }
    builder
        .build()
        .map_err(|e| format!("更新插件初始化失败: {e}"))
}

/// 后台检查、下载并验签。安装只能从 install_prepared_update 进入。
/// 按 `candidate_endpoint_groups` 的顺序依次尝试候选源（默认 Gitee 优先、ghproxy/GitHub
/// 回退），前一个候选检查或下载任一步失败就换下一个，全部失败才报错。内置指数退避重试：
/// 每个候选内检查最多重试 2 次、下载安装最多重试 2 次。
#[tauri::command]
pub fn start_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    min_supported_version: Option<String>,
) {
    let Some(guard) = SingleFlight::acquire(&UPDATE_RUNNING) else {
        log::info!("更新任务已在进行，忽略重复触发");
        return;
    };
    if report_pending_restart(&app) {
        return;
    }
    let path = package_path(&state.data_dir);
    let mut live_minimum = state.update_minimum.subscribe();
    tauri::async_runtime::spawn(async move {
        let _guard = guard; // 持有到任务结束（含所有 early return）
        let _ = app.emit("update:checking", ());

        let minimum = min_supported_version
            .as_deref()
            .and_then(parse_version)
            .max(live_minimum.borrow().as_deref().and_then(parse_version));
        let groups = match download_endpoint_groups(&app, minimum.is_some()) {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        // 最近一次失败的机器可读原因，随 update:error 一起发（见 classify_update_error）。
        let mut last_code: &'static str = "unknown";
        for endpoints in groups {
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    last_code = "config";
                    continue;
                }
            };

            // 复查同样要有上限：断网时 `updater.check()` 会一直等到 TCP 超时，
            // 而重试链条还会把它乘上 3 倍（每次尝试 + 1s/2s 退避）。
            let check_result = match tokio::time::timeout(
                PRE_DOWNLOAD_CHECK_DEADLINE,
                retry_with_backoff(2, "检查更新", is_retryable_check_error, || {
                    updater.check()
                }),
            )
            .await
            {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    last_code = classify_update_error(&e);
                    last_message = Some(format!("检查更新失败: {e}"));
                    continue;
                }
                Err(_) => {
                    log::warn!(
                        "[Update] 下载前复查超过 {}s 未完成，按超时换源",
                        PRE_DOWNLOAD_CHECK_DEADLINE.as_secs()
                    );
                    last_code = "timeout";
                    last_message = Some(format!(
                        "检查更新超时（{}s）",
                        PRE_DOWNLOAD_CHECK_DEADLINE.as_secs()
                    ));
                    continue;
                }
            };

            let update = match check_result {
                Some(u) if meets_minimum(&u.version, minimum) => u,
                _ if minimum.is_some() => {
                    log::warn!("[Update] 镜像尚未提供满足最低版本的安装包，改用下一源");
                    last_message = Some("镜像尚未同步到最低支持版本，请稍后重试".into());
                    last_code = "stale";
                    continue;
                }
                Some(u) => u,
                None => {
                    // 下载链路不负责"已是最新"判定（那是 check_update 的事）。
                    // 这里返回 None 说明下载前复查没拿到可用更新，发 error 而非 uptodate，
                    // 避免把用户手上已有的可用更新静默清空；不再尝试下一个候选（各源应给出一致结论，
                    // 换源重试只会徒增耗时）。
                    let _ = app.emit(
                        "update:error",
                        serde_json::json!({
                            "message": "下载前复查未找到可用更新，可能已发布新版本，请重新检查",
                            "code": "stale"
                        }),
                    );
                    return;
                }
            };

            let _ = app.emit("update:available", update_notice(&update));

            let local = {
                let path = path.clone();
                let candidate = update.clone();
                tokio::task::spawn_blocking(move || {
                    cached_package(&path, &candidate.version, &candidate.signature, |bytes| {
                        candidate.verify(bytes).is_ok()
                    })
                })
                .await
                .ok()
                .flatten()
            };

            let cached = local.is_some();
            let prepare = async {
                if let Some(bytes) = local {
                    Ok(bytes)
                } else {
                    retry_with_backoff(
                        2,
                        "下载更新",
                        |error| {
                            matches!(
                                error,
                                PackageDownloadError::Updater(
                                    tauri_plugin_updater::Error::Reqwest(_)
                                )
                            )
                        },
                        || download_verified_package(&app, update.clone()),
                    )
                    .await
                }
            };
            let result = tokio::select! {
                biased;
                _ = wait_until_obsolete(&mut live_minimum, &update.version) => {
                    drop(_guard);
                    let _ = app.emit("update:obsolete", ());
                    return;
                }
                result = prepare => result,
            };
            match result {
                Ok(bytes) => {
                    let size = bytes.len();
                    let version = update.version.clone();
                    let memory = if cached {
                        None
                    } else {
                        let cache_path = path.clone();
                        let version = version.clone();
                        let signature = update.signature.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Err(e) =
                                persist_package(&cache_path, &version, &signature, &bytes)
                            {
                                log::warn!("[Update] 无法缓存更新：{e}");
                                Some(Arc::<[u8]>::from(bytes))
                            } else {
                                None
                            }
                        })
                        .await
                        .unwrap_or_default()
                    };
                    let package = PreparedUpdate {
                        update,
                        memory,
                        path,
                    };
                    stage_update(&app, package, size, _guard);
                    return; // 这个源成功，结束
                }
                Err(e) => {
                    last_code = match &e {
                        PackageDownloadError::TooLarge => "package_size",
                        PackageDownloadError::Updater(error) => classify_update_error(error),
                    };
                    last_message = Some(format!("下载或校验更新失败: {e}"));
                    continue; // 换下一个候选源重试
                }
            }
        }

        let _ = app.emit(
            "update:error",
            serde_json::json!({
                "message": format!(
                    "全部更新源均失败（已依次尝试）: {}",
                    last_message.unwrap_or_else(|| "未知错误".into())
                ),
                "code": last_code
            }),
        );
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOutcome {
    Installed,
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
    let installed = update.clone();
    tokio::task::spawn_blocking(move || update.install(&*payload))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    let package = {
        let mut session = UPDATE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
        // macOS/Linux still need a restart after reopening a released webview.
        session.installed = Some(installed);
        session.prepared.take()
    };
    if let Some(package) = package {
        let _ = tokio::fs::remove_file(package.path).await;
    }
    let _ = app.emit("update:ready", ());
    Ok(InstallOutcome::Installed)
}

/// 只检查更新、不下载，通过 Tauri event 把结果推给前端用于展示徽章。
/// 与 `start_update` 共用 `updater.check()`、指数退避重试与候选源回退顺序，确保检查逻辑
/// 只有这一处实现（单一真相源）。
#[tauri::command]
pub fn check_update(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) {
    if report_pending_restart(&app) {
        return;
    }
    // 与下载任务**分开**的闸：检查和下载可以并存，但各自不能重入。
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(guard) = SingleFlight::acquire(&RUNNING) else {
        log::info!("更新检查已在进行，忽略重复触发");
        return;
    };
    let path = package_path(&state.data_dir);
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let _ = app.emit("update:checking", ());

        // 整体时限兜底（理由见 CHECK_DEADLINE 注释）：断网时 3 个源 × 最多 3 次尝试
        // = 9 次请求，每次都等 TCP 超时，前端会一直停在 checking（顶栏转圈），
        // 用户只能理解成"卡死"。`app` 被下面这个 async 块 move 走，超时分支还要用它
        // 发事件，所以先 clone 一份。
        let app_on_timeout = app.clone();
        let outcome = tokio::time::timeout(CHECK_DEADLINE, async move {
            let groups = match candidate_endpoint_groups() {
                Ok(g) => g,
                Err(e) => {
                    let _ = app.emit(
                        "update:error",
                        serde_json::json!({ "message": e, "source": "check" }),
                    );
                    return;
                }
            };

            let mut last_message: Option<String> = None;
            let mut last_code: &'static str = "unknown";
            for endpoints in groups {
                let updater = match build_updater(&app, endpoints) {
                    Ok(u) => u,
                    Err(e) => {
                        last_message = Some(e);
                        last_code = "config";
                        continue;
                    }
                };

                match retry_with_backoff(2, "检查更新", is_retryable_check_error, || {
                    updater.check()
                })
                .await
                {
                    Ok(Some(u)) => {
                        if restore_cached_update(&app, &path, &u).await {
                            return;
                        }
                        let date_str = u.date.map(|d| d.to_string());
                        let current_ver = u.current_version.clone();
                        let _ = app.emit(
                            "update:available",
                            serde_json::json!({
                                "version": u.version,
                                "body": u.body,
                                "date": date_str,
                                "currentVersion": current_ver,
                            }),
                        );
                        return;
                    }
                    Ok(None) => {
                        let _ = app.emit("update:uptodate", ());
                        return;
                    }
                    Err(e) => {
                        last_code = classify_update_error(&e);
                        last_message = Some(format!("检查更新失败: {e}"));
                        continue;
                    }
                }
            }

            let _ = app.emit(
                "update:error",
                serde_json::json!({
                    "message": format!(
                        "全部更新源均检查失败（已依次尝试）: {}",
                        last_message.unwrap_or_else(|| "未知错误".into())
                    ),
                    "code": last_code,
                    "source": "check"
                }),
            );
        })
        .await;

        if outcome.is_err() {
            log::warn!(
                "[Update] 检查更新超过 {}s 未完成，按超时处理",
                CHECK_DEADLINE.as_secs()
            );
            let _ = app_on_timeout.emit(
                "update:error",
                serde_json::json!({
                    "message": format!(
                        "连接更新服务器超时（{}s），请检查网络后重试",
                        CHECK_DEADLINE.as_secs()
                    ),
                    "code": "timeout",
                    "source": "check"
                }),
            );
        }
    });
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

    /// 源上找不到 manifest（Gitee releases 分支失效时的真实形态）不该重试：
    /// 重试只会让用户多等一轮 1s+2s 退避。
    #[test]
    fn manifest_missing_is_not_retryable() {
        assert!(!is_retryable_check_error(&UpdaterError::ReleaseNotFound));
        assert!(!is_retryable_check_error(&UpdaterError::TargetNotFound(
            "windows-x86_64".into()
        )));
        assert!(!is_retryable_check_error(&UpdaterError::TargetsNotFound(
            vec!["windows-x86_64".into()]
        )));
    }

    /// 链路抖动值得再试一次：换源前多试一轮是划算的。
    #[test]
    fn transient_errors_stay_retryable() {
        assert!(is_retryable_check_error(&UpdaterError::Network(
            "connection reset".into()
        )));
        assert!(is_retryable_check_error(&UpdaterError::FormatDate));
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
        let result: Result<(), UpdaterError> =
            retry_with_backoff(2, "检查更新", is_retryable_check_error, || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(UpdaterError::ReleaseNotFound)
                }
            })
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
        let result: Result<(), UpdaterError> =
            retry_with_backoff(1, "检查更新", is_retryable_check_error, || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(UpdaterError::Network("connection reset".into()))
                }
            })
            .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2, "可重试错误应再试一次");
    }
}
