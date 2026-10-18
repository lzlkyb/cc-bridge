//! 自动更新相关的 IPC 命令（`start_update` / `check_update`）与其私有辅助。
//!
//! 从 `commands.rs` 拆出来的第一块（D19 方案 C 第 1 批）。选它打头阵的理由：
//! 4 个私有辅助（`retry_with_backoff` / `resolve_update_endpoints` /
//! `candidate_endpoint_groups` / `build_updater`）**全部只被本模块调用**，与其它域零耦合，
//! 因此这一批能干净地验证「`pub use` 重导出 + `main.rs` 的 `invoke_handler!` 零改动」
//! 这套机制到底成不成立——机制若不成立，在这里暴露远比在大搬动里暴露好查。
//!
//! 本文件是**纯搬动**：函数体逐字节未改，可用 `tools/fingerprint.py` 比对哈希验证。
//! 唯一新增的是下面这行 import —— 区块内 13 处 `.emit()` 需要 `Emitter` trait 在作用域，
//! 其余外部符号（`url::Url` / `tauri_plugin_updater::` / `serde_json::` 等）原本就是全限定路径。

use tauri::Emitter;

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

/// 指数退避重试辅助函数
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
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
const GITEE_REPOSITORY: &str = "lzul/cc-bridge";

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

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端。
/// 按 `candidate_endpoint_groups` 的顺序依次尝试候选源（默认 Gitee 优先、ghproxy/GitHub
/// 回退），前一个候选检查或下载任一步失败就换下一个，全部失败才报错。内置指数退避重试：
/// 每个候选内检查最多重试 2 次、下载安装最多重试 2 次。
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    // 已有任务在跑就直接忽略本次触发（事件由在跑的那个推送，不重复发状态）。
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(guard) = SingleFlight::acquire(&RUNNING) else {
        log::info!("更新任务已在进行，忽略重复触发");
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard; // 持有到任务结束（含所有 early return）
        let _ = app.emit("update:checking", ());

        let groups = match candidate_endpoint_groups() {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        for endpoints in groups {
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    continue;
                }
            };

            let check_result = match retry_with_backoff(2, "检查更新", || updater.check()).await
            {
                Ok(r) => r,
                Err(e) => {
                    last_message = Some(format!("检查更新失败: {e}"));
                    continue;
                }
            };

            let update = match check_result {
                Some(u) => u,
                None => {
                    // 下载链路不负责"已是最新"判定（那是 check_update 的事）。
                    // 这里返回 None 说明下载前复查没拿到可用更新，发 error 而非 uptodate，
                    // 避免把用户手上已有的可用更新静默清空；不再尝试下一个候选（各源应给出一致结论，
                    // 换源重试只会徒增耗时）。
                    let _ = app.emit(
                        "update:error",
                        serde_json::json!({
                            "message": "下载前复查未找到可用更新，可能已发布新版本，请重新检查"
                        }),
                    );
                    return;
                }
            };

            let date_str = update.date.map(|d| d.to_string());
            let current_ver = update.current_version.clone();
            let _ = app.emit(
                "update:available",
                serde_json::json!({
                    "version": update.version,
                    "body": update.body,
                    "date": date_str,
                    "currentVersion": current_ver,
                }),
            );

            let _ = app.emit("update:downloading", ());

            let app_progress = app.clone();
            let result = retry_with_backoff(2, "下载安装", || {
                let u = update.clone();
                let ap = app_progress.clone();
                async move {
                    let mut downloaded_total: u64 = 0;
                    // 下载速度：窗口限流计算（~250ms 重算一次），不是每个 chunk 都重算——
                    // 快网速下 chunk 回调可能每秒触发好几十次，逐次算瞬时速率会跳得难看。
                    // downloaded/total 仍每 chunk 都发（百分比保持平滑），只有 bytesPerSec 在窗口
                    // 间隔内复用上一次算出的值。
                    let mut window_start = std::time::Instant::now();
                    let mut window_bytes: u64 = 0;
                    let mut last_bytes_per_sec: f64 = 0.0;
                    u.download_and_install(
                        move |chunk_len, total| {
                            downloaded_total += chunk_len as u64;
                            window_bytes += chunk_len as u64;
                            let elapsed = window_start.elapsed();
                            if elapsed.as_millis() >= 250 {
                                last_bytes_per_sec = window_bytes as f64 / elapsed.as_secs_f64();
                                window_start = std::time::Instant::now();
                                window_bytes = 0;
                            }
                            let _ = ap.emit(
                                "update:progress",
                                serde_json::json!({
                                    "downloaded": downloaded_total,
                                    "total": total,
                                    "bytesPerSec": last_bytes_per_sec,
                                }),
                            );
                        },
                        || {
                            // 🔴 插件这个回调是 on_download_finish（updater.rs:712），触发点在
                            // verify_signature **之前**。绝不能在这里发 update:ready——验签失败
                            // 时前端会误进自动重启倒计时并 relaunch，而更新根本没装上
                            // （2026-10-18 假签名实测：失败后 +9.2s app 被自行重启）。
                            // update:ready 改到 download_and_install 成功返回之后发（见 match）。
                        },
                    )
                    .await
                }
            })
            .await;

            match result {
                Ok(()) => {
                    // 下载 + 验签 + 安装全部成功才宣告 ready，前端据此起自动重启倒计时。
                    // Windows NSIS 路径走不到这里：install_inner 以 process::exit(0) 收尾，
                    // 重启由安装器负责；macOS/Linux 走到这里，事件才有意义。
                    let _ = app.emit("update:ready", ());
                    return; // 这个源成功，结束
                }
                Err(e) => {
                    last_message = Some(format!("下载安装失败: {e}"));
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
                )
            }),
        );
    });
}

/// 只检查更新、不下载，通过 Tauri event 把结果推给前端用于展示徽章。
/// 与 `start_update` 共用 `updater.check()`、指数退避重试与候选源回退顺序，确保检查逻辑
/// 只有这一处实现（单一真相源）。
#[tauri::command]
pub fn check_update(app: tauri::AppHandle) {
    // 与下载任务**分开**的闸：检查和下载可以并存，但各自不能重入。
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(guard) = SingleFlight::acquire(&RUNNING) else {
        log::info!("更新检查已在进行，忽略重复触发");
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let _ = app.emit("update:checking", ());

        let groups = match candidate_endpoint_groups() {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        for endpoints in groups {
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    continue;
                }
            };

            match retry_with_backoff(2, "检查更新", || updater.check()).await {
                Ok(Some(u)) => {
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
                )
            }),
        );
    });
}
