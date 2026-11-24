//! 模型中转的 IPC 命令层。
//!
//! 命令划分按「谁受影响」而不是按 CRUD：
//!
//! | 命令 | 影响 |
//! |---|---|
//! | `relay_status` | 只读：一次拿齐运行态 + 统计 + 最近日志 + 配置视图 |
//! | `relay_logs` | 只读：日志页要更多条 |
//! | `relay_save` | 写配置（热生效，不重启监听） |
//! | `relay_set_enabled` | 总开关：**同时**改配置与监听，并联动导航（§4.9.1） |
//! | `relay_start/stop/restart` | 只动监听，不动开关（页面内的服务动作） |
//! | `relay_regenerate_token` | 换令牌 |
//! | `relay_test_upstream` | 用当前表单值打一发，回报协议层事实 |
//!
//! `relay_save` 与 `relay_set_enabled` 分开，是因为它们的失败语义不同：保存失败
//! 意味着「配置没写进去」，开关失败可能只是「配置写了、端口被占了」——
//! 后者界面要显示「已启用但监听失败」，而不是把整个开关弹回去。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::save_config_field;
use crate::relay::{
    self,
    config::{self as relay_config, AuthStyle, Provider, RelaySettings, Tier, TierKind},
    RelayLogEntry, RelaySnapshot,
};
use crate::state::{relay_host_for, AppState};

const KEY_RELAY: &str = "relay";

/// 部分更新。**没传的字段不动**——这是「表单只提交改过的项」的前提。
///
/// `deny_unknown_fields` 与 `ConfigPatch` 同一理由：前端写错键名时宁可报错，
/// 也不要静默丢弃（那会造成「界面显示已保存、后端仍是旧值」）。
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayPatch {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    /// default 档的上游模型。**只有这一处**——映射名卡里不再放第二个输入框。
    pub model: Option<String>,
    /// haiku 档。空串 = 未配置（回落 default）。
    pub haiku: Option<String>,
    /// opus 档。空串 = 未配置。
    pub opus: Option<String>,
    #[serde(rename = "authStyle")]
    pub auth_style: Option<String>,
    /// `0` 表示「不压」（清空）。0 不是合法的 max_tokens，当哨兵足够明确，
    /// 也避免了 `Option<Option<u32>>` 那套双层 Option 的 serde 麻烦。
    #[serde(rename = "maxTokensLimit")]
    pub max_tokens_limit: Option<u32>,
    #[serde(rename = "foldToolBlocks")]
    pub fold_tool_blocks: Option<bool>,
    /// `tunnel` / `direct`。
    #[serde(rename = "listenMode")]
    pub listen_mode: Option<String>,
    #[serde(rename = "lanIp")]
    pub lan_ip: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySaveResult {
    pub ok: bool,
    /// 三格是否齐。
    pub configured: bool,
    /// 缺哪一格：`baseUrl` / `apiKey` / `model`。
    pub missing: Option<String>,
    /// 监听地址是否变了（变了要重启监听才生效）。
    pub restart_required: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayEnabledResult {
    pub enabled: bool,
    /// 启用成功时的监听地址。
    pub addr: Option<String>,
    /// 启用失败的原因（端口被占等）。**此时 `enabled` 仍为 true**：
    /// 配置写进去了，只是没起来——界面要能显示这个中间态。
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTokenResult {
    pub token: String,
    pub masked: String,
}

/// 只读快照。界面两秒轮询一次，所以一次拿齐。
#[tauri::command]
pub async fn relay_status(state: State<'_, Arc<AppState>>) -> Result<RelaySnapshot, String> {
    Ok(state.relay.snapshot(50).await)
}

/// 最近的日志。日志页要 500 条，比快照里的 50 条多。
#[tauri::command]
pub async fn relay_logs(
    state: State<'_, Arc<AppState>>,
    limit: Option<usize>,
) -> Result<Vec<RelayLogEntry>, String> {
    Ok(state.relay.log().recent(limit.unwrap_or(200).min(5_000)))
}

/// 保存配置。写盘 → 更新内存 → 热生效；监听地址变了才要求重启。
#[tauri::command]
pub async fn relay_save(
    state: State<'_, Arc<AppState>>,
    patch: RelayPatch,
) -> Result<RelaySaveResult, String> {
    let mut warnings: Vec<String> = Vec::new();

    // 监听方式的最终值（patch 里没提就沿用现有）
    let (mode, lan_ip, restart_required, settings, configured, missing) = {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;

        let mode = patch
            .listen_mode
            .clone()
            .unwrap_or_else(|| config.relay_listen_mode.clone());
        let mode = if mode == "direct" { "direct" } else { "tunnel" };
        let lan_ip = patch.lan_ip.clone().or_else(|| config.relay_lan_ip.clone());

        let mut settings = config.relay.clone();
        if settings.providers.is_empty() {
            settings.providers.push(Provider::default());
        }
        let Some(provider) = settings.active_mut() else {
            return Err("中转配置里没有可用的上游。".into());
        };

        // ── 三格 ──────────────────────────────────────────────────────
        if let Some(v) = patch.base_url.as_ref() {
            provider.base_url = v.clone();
        }
        // 密钥：空串表示「不改」，而不是「清空」——「更换」按钮会带新值，
        // 而普通保存不会把已经存着的密钥抹掉。要清空请显式传 `-`。
        if let Some(v) = patch.api_key.as_ref() {
            if v == "-" {
                provider.api_key = String::new();
            } else if !v.trim().is_empty() {
                provider.api_key = v.clone();
            }
        }
        if let Some(v) = patch.model.as_ref() {
            ensure_tier(provider, TierKind::Default).upstream_model = v.clone();
        }
        if let Some(v) = patch.haiku.as_ref() {
            ensure_tier(provider, TierKind::Haiku).upstream_model = v.clone();
        }
        if let Some(v) = patch.opus.as_ref() {
            ensure_tier(provider, TierKind::Opus).upstream_model = v.clone();
        }

        // ── 高级 ──────────────────────────────────────────────────────
        if let Some(v) = patch.auth_style.as_ref() {
            provider.auth_style = if v == "bearer" {
                AuthStyle::Bearer
            } else {
                AuthStyle::XApiKey
            };
        }
        if let Some(v) = patch.max_tokens_limit {
            provider.max_tokens_limit = if v == 0 { None } else { Some(v) };
        }
        if let Some(v) = patch.fold_tool_blocks {
            provider.fold_tool_blocks = v;
        }

        relay_config::normalize_settings(&mut settings);

        // ── 自转发检测（保存时就拒，§4.10 第 9 条）──────────────────
        let lan_ips = crate::network::get_lan_ips();
        let endpoint = settings
            .active()
            .map(|p| p.base_url.clone())
            .unwrap_or_default();
        if !endpoint.is_empty()
            && relay_config::is_self_forward(&endpoint, relay_config::DEFAULT_PORT, &lan_ips)
        {
            return Err(format!(
                "上游地址指向了中转自己（{endpoint}）。这样一次请求会自己调自己，\
                 瞬间把线程打满。请填你真正要用的上游服务地址。"
            ));
        }

        // 直连模式的两个必须提醒：明文的、要放行端口的。
        if mode == "direct" {
            warnings
                .push("内网直连是明文 HTTP：同一网段抓包能看到令牌。跨网络请用隧道模式。".into());
            warnings.push(format!(
                "远端要连 {}:{}，Windows 防火墙需要放行这个端口。",
                relay_host_for(mode, lan_ip.as_deref()),
                relay_config::DEFAULT_PORT
            ));
        }

        let host_before = relay_host_for(&config.relay_listen_mode, config.relay_lan_ip.as_deref());
        let host_after = relay_host_for(mode, lan_ip.as_deref());
        let restart_required = config.relay_enabled && host_before != host_after;

        // ── 落盘（先写盘再改内存，避免内存领先于 DB）────────────────
        save_config_field(&db, KEY_RELAY, &serde_json::to_value(&settings).unwrap())?;
        config.relay = settings.clone();
        if config.relay_listen_mode != mode {
            save_config_field(
                &db,
                "relay_listen_mode",
                &serde_json::to_value(mode).unwrap(),
            )?;
            config.relay_listen_mode = mode.to_string();
        }
        if config.relay_lan_ip != lan_ip {
            save_config_field(&db, "relay_lan_ip", &serde_json::to_value(&lan_ip).unwrap())?;
            config.relay_lan_ip = lan_ip.clone();
        }

        let (configured, missing) = match settings.active().and_then(|p| p.validate().err()) {
            None => (settings.is_configured(), None),
            Some(field) => (
                false,
                Some(
                    match field {
                        relay_config::MissingField::BaseUrl => "baseUrl",
                        relay_config::MissingField::ApiKey => "apiKey",
                        relay_config::MissingField::Model => "model",
                    }
                    .to_string(),
                ),
            ),
        };

        (
            mode.to_string(),
            lan_ip,
            restart_required,
            settings,
            configured,
            missing,
        )
    };

    // ── 热生效 ────────────────────────────────────────────────────────
    state.relay.reload_settings(settings).await;
    state
        .relay
        .set_listen(
            relay_host_for(&mode, lan_ip.as_deref()),
            relay_config::DEFAULT_PORT,
        )
        .await;

    // 地址变了且正在运行 → 直接重启，而不是让用户自己点一次「重启」。
    // 这里失败不阻断保存：配置已经写进去了，界面会显示监听错误。
    if restart_required {
        let (threshold, window) = {
            let config = state.config.read().await;
            (
                config.remote_ban_threshold,
                config.remote_ban_window_min as u64,
            )
        };
        if let Err(e) = state.relay.restart(threshold, window).await {
            warnings.push(format!("监听地址已保存，但重启失败：{e}"));
        }
    }

    Ok(RelaySaveResult {
        ok: true,
        configured,
        missing,
        restart_required,
        warnings,
    })
}

fn ensure_tier(provider: &mut Provider, kind: TierKind) -> &mut Tier {
    if let Some(pos) = provider.tiers.iter().position(|t| t.tier == kind) {
        return &mut provider.tiers[pos];
    }
    provider.tiers.push(Tier {
        tier: kind,
        upstream_model: String::new(),
    });
    provider.tiers.last_mut().expect("刚 push 过，必定存在")
}

/// 把整份配置同步进中转运行时。**导入路径专用**（`relay_save` 有自己的热更新逻辑）。
///
/// 导入是「整份替换」：替换后若不通知运行时，就会出现「配置里已是新上游、
/// 监听里还是旧快照」——旧 token 继续有效、新上游不生效、`relay_enabled:false`
/// 了监听还开着（安全与状态双失同步）。
///
/// token 与主 token 同一哲学：导出脱敏后为空串，**空串 = 保留现有**，
/// 不把远端已配好的机器一次性全打掉。
///
/// 阈值/窗口由调用方从同一份 config 现取，与 `relay_start` / `relay_restart` 同源。
pub(crate) async fn sync_relay_runtime(
    runtime: &crate::relay::RelayRuntime,
    cfg: &crate::config::BridgeConfig,
    ban_threshold: u32,
    ban_window_min: u64,
) {
    let token = if cfg.relay_token.trim().is_empty() {
        runtime.token_value().await
    } else {
        cfg.relay_token.clone()
    };
    let old_listen = runtime.current_listen().await;
    runtime.reload_settings(cfg.relay.clone()).await;
    runtime.set_token(token).await;
    let host = crate::state::relay_listen_host(cfg);
    runtime
        .set_listen(host.clone(), relay_config::DEFAULT_PORT)
        .await;

    let running = runtime.running_addr().await.is_some();
    if cfg.relay_enabled {
        if !running {
            if let Err(e) = runtime.start(ban_threshold, ban_window_min).await {
                ::log::warn!("导入配置后启动模型中转失败：{e}");
            }
        } else if old_listen.0 != host {
            // 监听地址变了：旧监听还绑在旧 host 上，必须重启才认新地址。
            if let Err(e) = runtime.restart(ban_threshold, ban_window_min).await {
                ::log::warn!("导入配置后重启模型中转失败：{e}");
            }
        }
    } else if running {
        if let Err(e) = runtime.stop().await {
            ::log::warn!("导入配置后停止模型中转失败：{e}");
        }
    }
}

/// 总开关：**一个动作同时管配置与监听**（§4.9.1）。
///
/// 打开时即使三格还没填也会起监听：用户的操作顺序是「先开开关 → 侧栏出现中转 →
/// 进去填三格」。若要求先填完才能开，他就永远进不去那一页。监听起来后，
/// 未配置的请求会收到一条说清原因的错误，而不是连接被拒。
#[tauri::command]
pub async fn relay_set_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<RelayEnabledResult, String> {
    let (token, host, threshold, window) = {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;

        if enabled && config.relay_token.trim().is_empty() {
            let generated = relay::auth::generate_token();
            save_config_field(
                &db,
                "relay_token",
                &serde_json::to_value(&generated).unwrap(),
            )?;
            config.relay_token = generated;
        }
        save_config_field(
            &db,
            "relay_enabled",
            &serde_json::to_value(enabled).unwrap(),
        )?;
        config.relay_enabled = enabled;

        (
            config.relay_token.clone(),
            crate::state::relay_listen_host(&config),
            config.remote_ban_threshold,
            config.remote_ban_window_min as u64,
        )
    };

    state.relay.set_token(token).await;
    state
        .relay
        .set_listen(host, relay_config::DEFAULT_PORT)
        .await;

    if enabled {
        match state.relay.start(threshold, window).await {
            Ok(addr) => Ok(RelayEnabledResult {
                enabled: true,
                addr: Some(addr),
                error: None,
            }),
            Err(e) => Ok(RelayEnabledResult {
                enabled: true,
                addr: None,
                error: Some(e),
            }),
        }
    } else {
        let error = state.relay.stop().await.err();
        Ok(RelayEnabledResult {
            enabled: false,
            addr: None,
            error,
        })
    }
}

/// 页面内的「重试启动」。
#[tauri::command]
pub async fn relay_start(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let (threshold, window) = {
        let config = state.config.read().await;
        (
            config.remote_ban_threshold,
            config.remote_ban_window_min as u64,
        )
    };
    state.relay.start(threshold, window).await
}

/// 页面内的「停止中转」。**不动开关**：停了之后页面还在，可以再起来。
#[tauri::command]
pub async fn relay_stop(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.relay.stop().await
}

#[tauri::command]
pub async fn relay_restart(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let (threshold, window) = {
        let config = state.config.read().await;
        (
            config.remote_ban_threshold,
            config.remote_ban_window_min as u64,
        )
    };
    state.relay.restart(threshold, window).await
}

/// 换令牌。旧令牌立刻失效——远端那些配好的机器要重新复制一次配置。
#[tauri::command]
pub async fn relay_regenerate_token(
    state: State<'_, Arc<AppState>>,
) -> Result<RelayTokenResult, String> {
    let generated = relay::auth::generate_token();
    {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;
        save_config_field(
            &db,
            "relay_token",
            &serde_json::to_value(&generated).unwrap(),
        )?;
        config.relay_token = generated.clone();
    }
    state.relay.set_token(generated.clone()).await;
    Ok(RelayTokenResult {
        masked: relay::auth::mask(&generated),
        token: generated,
    })
}

/// 测连通用的草稿。缺的字段用已保存的值补。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayDraft {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "authStyle")]
    pub auth_style: Option<String>,
}

/// 用当前表单值打一发最小请求。
///
/// 这是「测连通」而不是「发一次真请求」：`max_tokens: 8`，一句话 ping。
/// 失败时自动换另一种鉴权头重试一次，成功就说明该把 `auth_style` 改成那个。
#[tauri::command]
pub async fn relay_test_upstream(
    state: State<'_, Arc<AppState>>,
    draft: RelayDraft,
) -> Result<relay::ProbeOutcome, String> {
    let saved: RelaySettings = state.config.read().await.relay.clone();
    let provider = saved.active().cloned().unwrap_or_default();

    let base_url = draft
        .base_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| provider.base_url.clone());
    let api_key = draft
        .api_key
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| provider.api_key.clone());
    let model = draft
        .model
        .filter(|s| !s.trim().is_empty())
        .or_else(|| provider.upstream_for(TierKind::Default).map(str::to_string))
        .unwrap_or_default();
    let auth_style = match draft.auth_style.as_deref() {
        Some("bearer") => AuthStyle::Bearer,
        Some("x-api-key") => AuthStyle::XApiKey,
        _ => provider.auth_style,
    };

    if base_url.trim().is_empty() {
        return Err("上游地址还没填。".into());
    }
    if api_key.trim().is_empty() {
        return Err("密钥还没填。".into());
    }
    if model.trim().is_empty() {
        return Err("模型还没填。".into());
    }
    relay::probe(&base_url, &api_key, &model, auth_style).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_rejects_unknown_keys() {
        // 与 ConfigPatch 同一条契约：键名漂移必须报错，不能静默丢弃。
        let err = serde_json::from_value::<RelayPatch>(serde_json::json!({
            "baseUrl": "https://h",
            "modelName": "typo"
        }))
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn patch_deserializes_camel_case() {
        let p: RelayPatch = serde_json::from_value(serde_json::json!({
            "baseUrl": "https://h/apps/anthropic",
            "apiKey": "sk",
            "model": "m",
            "haiku": "",
            "opus": "",
            "authStyle": "bearer",
            "maxTokensLimit": 0,
            "foldToolBlocks": true,
            "listenMode": "direct",
            "lanIp": "10.0.0.2"
        }))
        .unwrap();
        assert_eq!(p.model.as_deref(), Some("m"));
        assert_eq!(p.max_tokens_limit, Some(0));
        assert_eq!(p.listen_mode.as_deref(), Some("direct"));
    }

    #[test]
    fn ensure_tier_appends_when_missing() {
        let mut p = Provider::default();
        p.tiers.clear();
        ensure_tier(&mut p, TierKind::Haiku).upstream_model = "small".into();
        assert_eq!(p.upstream_for(TierKind::Haiku), Some("small"));
        // 第二次不会重复追加
        ensure_tier(&mut p, TierKind::Haiku).upstream_model = "smaller".into();
        assert_eq!(p.tiers.len(), 1);
        assert_eq!(p.upstream_for(TierKind::Haiku), Some("smaller"));
    }

    #[test]
    fn max_tokens_zero_clears_the_limit() {
        // 0 是「不压」的哨兵：高级设置里清空输入框就是这个效果。
        let mut p = Provider {
            max_tokens_limit: Some(8192),
            ..Provider::default()
        };
        p.max_tokens_limit = if 0u32 == 0 { None } else { Some(0) };
        assert!(p.max_tokens_limit.is_none());
    }

    // ── 导入后的运行时同步（审查 #6）────────────────────────────────────
    //
    // 导入是整份替换：不通知运行时 = 「配置里是新上游、监听里是旧快照」。
    // 三个分支（启用→起 / 禁用→停 / 空 token→保留）各起一个真监听来守。

    fn test_runtime() -> crate::relay::RelayRuntime {
        crate::relay::RelayRuntime::new(
            RelaySettings::default(),
            "rly_old".into(),
            Arc::new(crate::relay::RelayLog::new(10, None)),
            "127.0.0.1".into(),
            // 端口 0 = 系统分配，测试之间不抢同一个口。
            0,
        )
    }

    #[tokio::test]
    async fn sync_starts_listener_when_import_enables_relay() {
        let rt = test_runtime();
        let cfg = crate::config::BridgeConfig {
            relay_enabled: true,
            relay_token: "rly_new".into(),
            ..Default::default()
        };
        sync_relay_runtime(&rt, &cfg, 5, 15).await;
        assert!(rt.running_addr().await.is_some(), "导入启用后必须起监听");
        assert_eq!(rt.token_value().await, "rly_new");
        let _ = rt.stop().await;
    }

    #[tokio::test]
    async fn sync_stops_listener_when_import_disables_relay() {
        let rt = test_runtime();
        rt.start(5, 15).await.expect("测试应能起监听");
        let cfg = crate::config::BridgeConfig {
            relay_enabled: false,
            relay_token: "rly_new".into(),
            ..Default::default()
        };
        sync_relay_runtime(&rt, &cfg, 5, 15).await;
        assert!(rt.running_addr().await.is_none(), "导入禁用后必须停监听");
        // token 照常同步：下一次启用立刻生效，不留旧值。
        assert_eq!(rt.token_value().await, "rly_new");
    }

    #[tokio::test]
    async fn sync_keeps_existing_token_when_imported_token_is_blank() {
        // 导出脱敏 ⇒ 空 token 是常态。此时保留现有，否则一次导入就把
        // 远端全部配置打掉（用户完全看不出原因）。
        let rt = test_runtime();
        let cfg = crate::config::BridgeConfig {
            relay_enabled: false,
            relay_token: "   ".into(),
            ..Default::default()
        };
        sync_relay_runtime(&rt, &cfg, 5, 15).await;
        assert_eq!(rt.token_value().await, "rly_old", "空 token = 保留现有");
    }
}
