//! 强制更新策略（最低可用版本）的拉取与判定。
//!
//! ## 为什么单独一份文件，而不塞进 updater.json
//!
//! `updater.json` 由 `tauri-plugin-updater` 解析，往里加自定义字段是拿别人的 schema
//! 赌未来；而且 GitHub / Gitee 两份清单要分别维护。策略与安装包解耦还有一个运维收益：
//! 改「是否强制」不需要重新构建、重新发版。
//!
//! ## 判定原则：fail-open
//!
//! **只有明确拿到一份结构合法、语义自洽的策略时才可能锁界面。** 网络失败、文件缺失、
//! 字段非法、`min > latest`（发布侧手滑）一律判为「不强制」。理由：一次 CDN 抖动
//! 或一次配置写错就让所有用户打不开软件，风险远大于有人靠断网绕过。
//!
//! 离线时优先用本地缓存 —— 已经下发过的强制策略在断网期间继续生效，但缓存本身
//! 也走同一套合法性校验。
//!
//! 这不是 DRM：本地软件挡不住决心，改 hosts / 断网 / 装旧包都能绕过。它的作用是
//! 「正常路径下无法忽略」，不是安全边界。

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{stream::FuturesOrdered, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

use super::update::{GITEE_REPOSITORY, GITHUB_REPOSITORY};

/// 策略文件的远端文件名（与 updater.json 同目录发布）。
const POLICY_FILE: &str = "update-policy.json";
/// 本地缓存文件名，落在 `data_dir` 下。
const CACHE_FILE: &str = "update-policy-cache.json";
/// 拉取策略的整体时限，超时即放弃并回退缓存。
/// 它在启动路径上，不能像检查更新那样等 60 秒。
const FETCH_DEADLINE: Duration = Duration::from_secs(8);
/// 单个源的上限。失效的优先源不能一直拦截后面已经拿到的结果。
const REQUEST_DEADLINE: Duration = Duration::from_secs(4);
/// 本地缓存的有效期。过期即当作没有缓存（fail-open）。
///
/// 为什么必须有上限：发布方撤销强制（`enforced:false`）后，网络受限的用户
/// （公司白名单、代理只放行特定域）会一直读到旧缓存 ⇒ 永久锁死；而遮罩上
/// 「立即更新」走的是同一条网络，也救不回来。`graceUntil` 只管「何时开始锁」，
/// 管不到「何时停止锁」，TTL 是唯一能自愈的出口。
const CACHE_TTL_DAYS: i64 = 7;
/// 认得的策略版本。未来改结构时递增，旧客户端会把新文件判为 invalid（fail-open）。
const SUPPORTED_SCHEMA: u32 = 1;

/// 远端策略文件（`update-policy.json`）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    pub schema: u32,
    /// 本次发布的最新版本，仅用于展示与自洽校验（`min <= latest`）。
    pub latest_version: String,
    /// 低于此版本的客户端必须升级后才能继续使用。
    pub min_supported_version: String,
    /// 是否启用强制。发版默认 `false`，只有显式选择强制发版时才为 `true`。
    #[serde(default)]
    pub enforced: bool,
    /// 缓冲截止时间（RFC 3339）。在此之前只提示、不锁；缺省视为立即可锁。
    #[serde(default)]
    pub grace_until: Option<String>,
    /// 强制遮罩上展示给用户的原因。
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// 返回给前端的判定结果。`source` 只用于日志与排查，不进 UI。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceUpdateVerdict {
    pub mandatory: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub min_supported_version: Option<String>,
    pub message: Option<String>,
    pub grace_until: Option<String>,
    /// `network`（远端命中）/ `cache`（离线用缓存）/ `network-miss`（都没有，放行）/
    /// `invalid`（策略不合法，放行）/ `skip`（逃生开关）
    pub source: String,
}

/// 本地缓存：记下 `fetchedAt` 便于排查「为什么这台机器还在强制」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPolicy {
    fetched_at: String,
    policy: UpdatePolicy,
}

/// 解析 `x.y.z` / `vX.Y.Z`。刻意只接受三段数字：
/// 项目版本号没有 prerelease，把 `3.4.0-beta` 判成非法（⇒ fail-open）比猜语义安全。
pub(super) fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let s = raw.trim();
    let s = s
        .strip_prefix('v')
        .or_else(|| s.strip_prefix('V'))
        .unwrap_or(s);
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn base_verdict(
    current: &str,
    policy: &UpdatePolicy,
    source: &str,
    mandatory: bool,
) -> ForceUpdateVerdict {
    ForceUpdateVerdict {
        mandatory,
        current_version: current.to_string(),
        latest_version: Some(policy.latest_version.clone()),
        min_supported_version: Some(policy.min_supported_version.clone()),
        message: policy.message.clone(),
        grace_until: policy.grace_until.clone(),
        source: source.to_string(),
    }
}

/// 纯函数：给定当前版本、策略与时刻，判定是否必须更新。
///
/// 抽成纯函数是为了把「缓冲期、min>latest、非法版本」这些容易回归的边界钉在单测里——
/// 它们全都是「一旦判错就把用户锁在门外」的路径。
fn evaluate(
    current: &str,
    policy: &UpdatePolicy,
    now: chrono::DateTime<chrono::Utc>,
    source: &str,
) -> ForceUpdateVerdict {
    if policy.schema != SUPPORTED_SCHEMA {
        return base_verdict(current, policy, "invalid", false);
    }
    let (Some(cur), Some(min), Some(latest)) = (
        parse_version(current),
        parse_version(&policy.min_supported_version),
        parse_version(&policy.latest_version),
    ) else {
        return base_verdict(current, policy, "invalid", false);
    };
    // 发布侧写错（要求升到一个还不存在的版本）会把所有人锁死且无法通过更新解除，
    // 必须整份策略作废。
    if min > latest {
        return base_verdict(current, policy, "invalid", false);
    }
    let grace_passed = match policy.grace_until.as_deref() {
        None | Some("") => true,
        Some(raw) => match chrono::DateTime::parse_from_rfc3339(raw) {
            Ok(at) => now >= at.with_timezone(&chrono::Utc),
            // 缓冲时间写坏时保守放行：宁可晚锁一天，也不要因为一个字符串把用户挡住。
            Err(_) => return base_verdict(current, policy, "invalid", false),
        },
    };
    let mandatory = policy.enforced && cur < min && grace_passed;
    base_verdict(current, policy, source, mandatory)
}

/// 候选源，与更新清单同序：env 覆盖（测试/支持用）→ Gitee → gh-proxy → GitHub。
fn policy_endpoints() -> Vec<String> {
    if let Ok(raw) = std::env::var("CCBRIDGE_UPDATE_POLICY_ENDPOINT") {
        let eps: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if !eps.is_empty() {
            return eps;
        }
    }
    vec![
        format!("https://gitee.com/{GITEE_REPOSITORY}/raw/releases/latest/{POLICY_FILE}"),
        format!(
            "https://gh-proxy.com/https://github.com/{GITHUB_REPOSITORY}/releases/latest/download/{POLICY_FILE}"
        ),
        format!("https://github.com/{GITHUB_REPOSITORY}/releases/latest/download/{POLICY_FILE}"),
    ]
}

fn policy_timestamp(policy: &UpdatePolicy) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(policy.updated_at.as_deref()?).ok()
}

/// 相同时间戳保留源优先级。已经撤销的策略不能被仍在传播的旧镜像盖回去。
fn prefer_policy(candidate: &UpdatePolicy, current: &UpdatePolicy) -> bool {
    let now = chrono::Utc::now();
    let version = env!("CARGO_PKG_VERSION");
    let valid = |policy| evaluate(version, policy, now, "network").source != "invalid";
    (valid(candidate), policy_timestamp(candidate)) > (valid(current), policy_timestamp(current))
}

/// 并发拉取，等待各源在各自的超时内返回，再选最新的有效策略。
async fn fetch_policy(
    endpoints: Vec<String>,
    request_deadline: Duration,
) -> Result<UpdatePolicy, String> {
    let client = reqwest::Client::builder()
        .timeout(request_deadline)
        .build()
        .map_err(|e| format!("策略请求客户端初始化失败: {e}"))?;
    let mut requests: FuturesOrdered<_> = endpoints
        .into_iter()
        .map(|url| {
            let client = client.clone();
            async move {
                let response = client.get(url).send().await?.error_for_status()?;
                response.json::<UpdatePolicy>().await
            }
        })
        .collect();
    let mut last = String::from("无可用更新源");
    let mut best = None;
    while let Some(result) = requests.next().await {
        match result {
            Ok(policy) => {
                if best
                    .as_ref()
                    .is_none_or(|current| prefer_policy(&policy, current))
                {
                    best = Some(policy);
                }
            }
            Err(e) => last = e.to_string(),
        }
    }
    best.ok_or(last)
}

fn write_cache(path: &Path, policy: &UpdatePolicy) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&CachedPolicy {
        fetched_at: chrono::Utc::now().to_rfc3339(),
        policy: policy.clone(),
    })
    .map_err(|e| e.to_string())?;
    // tmp + rename：半截文件会被下一次启动当成损坏缓存、直接丢失强制能力。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("写缓存失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换缓存失败: {e}"))
}

/// 纯函数：缓存是否仍在有效期内。
///
/// 只有「时间戳可解析、且落在 `[now, now - TTL]` 这个闭区间内」才算新鲜，其余一律
/// 视为过期 —— 过期只会导致「本次不强制」（fail-open），而错判成新鲜会让用户被
/// 一份早已撤销的策略永久锁住。两种错的代价不对称，所以这里全部倒向放行。
fn cache_is_fresh(fetched_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(fetched_at) else {
        return false;
    };
    let age = now.signed_duration_since(at.with_timezone(&chrono::Utc));
    let ttl = chrono::TimeDelta::try_days(CACHE_TTL_DAYS).unwrap_or_default();
    // age 为负说明 fetchedAt 在未来（系统时钟被改过）：这种缓存能绕过 TTL，直接作废。
    age >= chrono::TimeDelta::zero() && age <= ttl
}

fn read_cache(path: &Path) -> Option<UpdatePolicy> {
    let raw = std::fs::read_to_string(path).ok()?;
    let cached = match serde_json::from_str::<CachedPolicy>(&raw) {
        Ok(cached) => cached,
        Err(e) => {
            log::warn!("[UpdatePolicy] 缓存解析失败，按无缓存处理: {e}");
            return None;
        }
    };
    if !cache_is_fresh(&cached.fetched_at, chrono::Utc::now()) {
        log::warn!(
            "[UpdatePolicy] 缓存已失效（fetchedAt={}，TTL={CACHE_TTL_DAYS} 天），按无缓存放行",
            cached.fetched_at
        );
        return None;
    }
    Some(cached.policy)
}

/// 拉取失败时的统一出口：能用缓存就用缓存判定，否则明确放行。
fn fallback_to_cache(cache_path: &Path, current: &str) -> ForceUpdateVerdict {
    match read_cache(cache_path) {
        Some(policy) => evaluate(current, &policy, chrono::Utc::now(), "cache"),
        None => ForceUpdateVerdict {
            mandatory: false,
            current_version: current.to_string(),
            latest_version: None,
            min_supported_version: None,
            message: None,
            grace_until: None,
            source: "network-miss".into(),
        },
    }
}

/// 检查「是否必须更新才能继续使用」。
///
/// 前端在启动时调用一次（缓存命中会很快返回）；判定为 `mandatory` 时显示不可关闭的
/// 更新遮罩。
///
/// 返回值用 `Result` 只是为了满足 Tauri 对「带引用参数的 async 命令」的要求，
/// **本命令不会返回 `Err`**：这是启动路径上的判定，错误必须落成「放行」，
/// 让前端再写一层兜底只会多一个可能判错的地方。
#[tauri::command(rename_all = "snake_case")]
pub async fn check_update_policy(
    state: State<'_, Arc<AppState>>,
) -> Result<ForceUpdateVerdict, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    // 支持排查用的逃生开关：只影响本次判定，不写任何状态。
    if std::env::var("CCBRIDGE_SKIP_FORCE_UPDATE")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        log::warn!("[UpdatePolicy] CCBRIDGE_SKIP_FORCE_UPDATE 已设置，本次跳过强制更新判定");
        apply_minimum(&state, None);
        return Ok(ForceUpdateVerdict {
            mandatory: false,
            current_version: current,
            latest_version: None,
            min_supported_version: None,
            message: None,
            grace_until: None,
            source: "skip".into(),
        });
    }

    let cache_path = state.data_dir.join(CACHE_FILE);
    let fetched = tokio::time::timeout(
        FETCH_DEADLINE,
        fetch_policy(policy_endpoints(), REQUEST_DEADLINE),
    )
    .await;
    let verdict = match fetched {
        Ok(Ok(policy)) => {
            let now = chrono::Utc::now();
            let verdict = if let Some(cached) = read_cache(&cache_path).filter(|cached| {
                policy_timestamp(cached).is_some() && prefer_policy(cached, &policy)
            }) {
                evaluate(&current, &cached, now, "cache")
            } else {
                if let Err(e) = write_cache(&cache_path, &policy) {
                    log::warn!("[UpdatePolicy] 缓存写入失败（不影响本次判定）: {e}");
                }
                evaluate(&current, &policy, now, "network")
            };
            log::info!(
                "[UpdatePolicy] 远端策略命中 → mandatory={} current={} min={} source={}",
                verdict.mandatory,
                verdict.current_version,
                verdict.min_supported_version.as_deref().unwrap_or("-"),
                verdict.source
            );
            verdict
        }
        Ok(Err(e)) => {
            log::warn!("[UpdatePolicy] 拉取策略失败，回退缓存: {e}");
            fallback_to_cache(&cache_path, &current)
        }
        Err(_) => {
            log::warn!(
                "[UpdatePolicy] 拉取策略超时（>{}s），回退缓存",
                FETCH_DEADLINE.as_secs()
            );
            fallback_to_cache(&cache_path, &current)
        }
    };
    apply_minimum(
        &state,
        verdict
            .min_supported_version
            .clone()
            .filter(|_| verdict.mandatory),
    );
    Ok(verdict)
}

fn apply_minimum(state: &AppState, minimum: Option<String>) {
    let enforced = minimum.is_some();
    state.update_minimum.send_if_modified(|value| {
        if *value == minimum {
            false
        } else {
            *value = minimum;
            true
        }
    });
    state.force_update_active.store(enforced, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn policy(enforced: bool, min: &str, latest: &str, grace: Option<&str>) -> UpdatePolicy {
        UpdatePolicy {
            schema: SUPPORTED_SCHEMA,
            latest_version: latest.into(),
            min_supported_version: min.into(),
            enforced,
            grace_until: grace.map(str::to_string),
            message: Some("测试用强制说明".into()),
            updated_at: None,
        }
    }

    fn at(rfc3339: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn parses_plain_and_prefixed_versions() {
        assert_eq!(parse_version("3.4.0"), Some((3, 4, 0)));
        assert_eq!(parse_version("v3.4.0"), Some((3, 4, 0)));
        assert_eq!(parse_version(" 3.4.10 "), Some((3, 4, 10)));
        // 只认三段数字：两段、四段、prerelease 一律判非法（⇒ fail-open）。
        assert_eq!(parse_version("3.4"), None);
        assert_eq!(parse_version("3.4.0.1"), None);
        assert_eq!(parse_version("3.4.0-beta"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn older_version_is_blocked_after_grace() {
        let p = policy(true, "3.4.2", "3.5.0", Some("2026-11-25T00:00:00Z"));
        let v = evaluate("3.4.1", &p, at("2026-11-26T00:00:00Z"), "network");
        assert!(v.mandatory);
        assert_eq!(v.source, "network");
    }

    #[test]
    fn grace_window_only_warns() {
        let p = policy(true, "3.4.2", "3.5.0", Some("2026-12-01T00:00:00Z"));
        let v = evaluate("3.4.0", &p, at("2026-11-26T00:00:00Z"), "network");
        assert!(!v.mandatory, "缓冲期内不能锁界面");
        // 缓冲信息仍要带给前端，遮罩/提示可展示「将于某时开始强制」。
        assert_eq!(v.grace_until.as_deref(), Some("2026-12-01T00:00:00Z"));
    }

    #[test]
    fn exact_min_version_is_allowed() {
        let p = policy(true, "3.4.2", "3.5.0", None);
        assert!(!evaluate("3.4.2", &p, chrono::Utc::now(), "network").mandatory);
        assert!(evaluate("3.4.1", &p, chrono::Utc::now(), "network").mandatory);
    }

    #[test]
    fn disabled_policy_never_blocks() {
        let p = policy(false, "3.4.2", "3.5.0", None);
        assert!(!evaluate("3.0.0", &p, chrono::Utc::now(), "network").mandatory);
    }

    /// 发布侧手滑把 min 写到比 latest 还高 —— 整份策略作废，否则用户被锁死且
    /// 「更新到最新」也解除不了。
    #[test]
    fn min_above_latest_is_invalid() {
        let p = policy(true, "9.9.9", "3.5.0", None);
        let v = evaluate("3.4.0", &p, chrono::Utc::now(), "network");
        assert!(!v.mandatory);
        assert_eq!(v.source, "invalid");
    }

    #[test]
    fn unknown_schema_is_invalid() {
        let mut p = policy(true, "3.4.2", "3.5.0", None);
        p.schema = 2;
        let v = evaluate("3.4.0", &p, chrono::Utc::now(), "network");
        assert!(!v.mandatory);
        assert_eq!(v.source, "invalid");
    }

    /// 缓冲时间写坏不能变成「已过缓冲」——那会在发布瞬间锁死所有人。
    #[test]
    fn broken_grace_until_fails_open() {
        let p = policy(true, "3.4.2", "3.5.0", Some("2026-13-40T00:00:00Z"));
        let v = evaluate("3.4.0", &p, chrono::Utc::now(), "network");
        assert!(!v.mandatory);
        assert_eq!(v.source, "invalid");
    }

    #[test]
    fn cache_source_is_reported() {
        let p = policy(true, "3.4.2", "3.5.0", None);
        let v = evaluate("3.0.0", &p, chrono::Utc::now(), "cache");
        assert!(v.mandatory);
        assert_eq!(v.source, "cache");
    }

    #[test]
    fn newer_revoke_wins_over_stale_mirror() {
        let mut old = policy(true, "3.4.2", "3.5.0", None);
        old.updated_at = Some("2026-11-25T08:00:00Z".into());
        let mut revoked = policy(false, "3.5.0", "3.5.0", None);
        revoked.updated_at = Some("2026-11-26T08:00:00Z".into());
        assert!(prefer_policy(&revoked, &old));
        assert!(!prefer_policy(&old, &revoked));
        revoked.schema = 999;
        assert!(!prefer_policy(&revoked, &old));
    }

    #[test]
    fn newer_current_version_is_allowed() {
        let p = policy(true, "3.4.2", "3.5.0", None);
        assert!(!evaluate("3.5.0", &p, chrono::Utc::now(), "network").mandatory);
        assert!(!evaluate("3.6.0", &p, chrono::Utc::now(), "network").mandatory);
    }

    #[test]
    fn endpoints_put_gitee_first() {
        // env 未设置时（测试进程通常没有），第一候选必须是国内最稳的 Gitee raw。
        let eps = policy_endpoints();
        assert!(eps[0].contains("gitee.com"), "首候选应为 Gitee：{eps:?}");
        assert!(eps.iter().all(|u| u.ends_with(POLICY_FILE)));
    }

    #[tokio::test]
    async fn two_stalled_mirrors_leave_time_for_direct_source() {
        let server = axum::Router::new()
            .route(
                "/slow",
                axum::routing::get(|| async {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                }),
            )
            .route(
                "/ready",
                axum::routing::get(|| async { axum::Json(policy(true, "3.4.2", "3.5.0", None)) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, server).await });
        let direct = tokio::time::timeout(
            Duration::from_millis(1500),
            fetch_policy(
                ["slow", "slow", "ready"]
                    .map(|route| format!("http://{addr}/{route}"))
                    .to_vec(),
                Duration::from_secs(1),
            ),
        )
        .await;
        server.abort();
        assert_eq!(direct.unwrap().unwrap().latest_version, "3.5.0");
    }

    #[test]
    fn grace_boundary_is_inclusive_at_deadline() {
        let p = policy(true, "3.4.2", "3.5.0", Some("2026-11-26T00:00:00Z"));
        let deadline = chrono::Utc.with_ymd_and_hms(2026, 11, 26, 0, 0, 0).unwrap();
        assert!(evaluate("3.4.0", &p, deadline, "network").mandatory);
    }

    /// 缓存过期必须整份作废：这是「发布方撤销强制后，网络受限用户还能自愈」的
    /// 唯一出口。少了它，一次 `--force` 就能把这类用户永久锁在门外。
    #[test]
    fn cache_expires_after_ttl() {
        let now = at("2026-11-26T00:00:00Z");
        assert!(
            cache_is_fresh("2026-11-25T23:00:00Z", now),
            "1 小时内应新鲜"
        );
        assert!(
            cache_is_fresh("2026-11-20T00:00:00Z", now),
            "6 天前仍在 7 天窗口内"
        );
        assert!(
            !cache_is_fresh("2026-11-18T00:00:00Z", now),
            "8 天前必须判过期"
        );
        assert!(
            !cache_is_fresh("2026-11-27T00:00:00Z", now),
            "未来时间戳不可信（时钟被改过），必须作废"
        );
        assert!(!cache_is_fresh("not-a-date", now), "非法时间戳按过期处理");
    }

    /// 过期缓存走到判定层应当是「无缓存 → 放行」，而不是带着旧策略继续锁。
    #[test]
    fn expired_cache_yields_no_policy() {
        let dir = std::env::temp_dir().join(format!("ccbridge-policy-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CACHE_FILE);
        // 8 天前的强制策略：内容本身会让 3.4.0 被锁，但时间戳已过期。
        let stale = CachedPolicy {
            fetched_at: (chrono::Utc::now() - chrono::TimeDelta::try_days(8).unwrap()).to_rfc3339(),
            policy: policy(true, "3.4.2", "3.5.0", None),
        };
        std::fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();
        assert!(read_cache(&path).is_none(), "过期缓存不能被读出来");

        // 同一份策略换个新鲜时间戳，就应该能读到并触发强制。
        let fresh = CachedPolicy {
            fetched_at: chrono::Utc::now().to_rfc3339(),
            ..stale
        };
        std::fs::write(&path, serde_json::to_vec(&fresh).unwrap()).unwrap();
        let policy = read_cache(&path).expect("新鲜缓存应可读");
        assert!(evaluate("3.4.0", &policy, chrono::Utc::now(), "cache").mandatory);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
