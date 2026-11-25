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
    /// 厂商画像 id。空串 = 交给 host 自动推断。
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    /// 工具 schema `\0` 归一化：`auto` = 跟随厂商画像，`on` / `off` = 显式指定。
    ///
    /// 用字符串而不是 `Option<bool>`：后者只有「没传」与「传了」，没法表达
    /// 「改回跟随画像」——而三态里真正需要的正是这一格。
    #[serde(rename = "normalizeToolPatterns")]
    pub normalize_tool_patterns: Option<String>,
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

#[tauri::command]
pub async fn relay_history(state: State<'_, Arc<AppState>>) -> Result<Vec<RelayLogEntry>, String> {
    let log = state.relay.log();
    tauri::async_runtime::spawn_blocking(move || log.history())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// 保存配置。写盘 → 更新内存 → 热生效；监听地址变了才要求重启。
#[tauri::command]
pub async fn relay_save(
    state: State<'_, Arc<AppState>>,
    patch: RelayPatch,
) -> Result<RelaySaveResult, String> {
    let mut warnings: Vec<String> = Vec::new();

    // 监听方式的最终值（patch 里没提就沿用现有）
    let (restart_required, configured, missing) = {
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

        apply_upstream_patch(provider, &patch)?;

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

        // Publish while holding the same configuration lock as provider changes.
        state.relay.reload_settings(settings).await;
        state
            .relay
            .set_listen(host_after, relay_config::DEFAULT_PORT)
            .await;
        (restart_required, configured, missing)
    };

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
        super::relay_tunnel_cmds::sync_relay_tunnels(state.inner()).await;
    }

    Ok(RelaySaveResult {
        ok: true,
        configured,
        missing,
        restart_required,
        warnings,
    })
}

fn apply_upstream_patch(provider: &mut Provider, patch: &RelayPatch) -> Result<(), String> {
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
    if let Some(v) = patch.profile_id.as_ref() {
        // 空串 = 回到自动推断。写进去之前先确认 id 存在：未知 id 会让
        // `profile()` 落回 host 推断，用户以为自己选了 A、实际跑的是 B。
        let trimmed = v.trim();
        if trimmed.is_empty() {
            provider.profile_id.clear();
        } else if relay::profile::by_id(trimmed).is_some() {
            provider.profile_id = trimmed.to_string();
        } else {
            return Err(format!("未知的厂商类型：{trimmed}。请重新选择。"));
        }
    }
    if let Some(v) = patch.normalize_tool_patterns.as_ref() {
        provider.normalize_tool_patterns = match v.as_str() {
            "on" => Some(true),
            "off" => Some(false),
            _ => None,
        };
    }
    if let Some(v) = patch.max_tokens_limit {
        provider.max_tokens_limit = if v == 0 { None } else { Some(v) };
    }
    if let Some(v) = patch.fold_tool_blocks {
        provider.fold_tool_blocks = v;
    }
    Ok(())
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

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum RelayProviderChange {
    Save {
        id: Option<String>,
        name: String,
        patch: Box<RelayPatch>,
    },
    Activate {
        id: String,
    },
    Remove {
        id: String,
    },
}

#[derive(Serialize)]
pub struct RelayProviderResult {
    pub id: String,
    pub snapshot: RelaySnapshot,
}

#[tauri::command]
pub async fn relay_manage_provider(
    state: State<'_, Arc<AppState>>,
    change: RelayProviderChange,
) -> Result<RelayProviderResult, String> {
    let id = {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;
        let mut settings = config.relay.clone();
        let id = change_provider(&mut settings, change)?;
        save_config_field(&db, KEY_RELAY, &serde_json::to_value(&settings).unwrap())?;
        config.relay = settings.clone();
        // The listener stays up. A request that already captured a snapshot keeps using it.
        state.relay.reload_settings(settings).await;
        id
    };
    Ok(RelayProviderResult {
        id,
        snapshot: state.relay.snapshot(50).await,
    })
}

fn provider_index(settings: &RelaySettings, id: &str) -> Result<usize, String> {
    settings
        .providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| "这套上游已不存在，请重新选择。".into())
}

fn upstream_url(raw: &str) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(raw.trim()).map_err(|_| "请输入有效的 HTTP 或 HTTPS 上游地址。")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("上游地址应使用 HTTP 或 HTTPS，密钥请填写在单独的输入框。".into());
    }
    if relay_config::is_self_forward(
        url.as_str(),
        relay_config::DEFAULT_PORT,
        &crate::network::get_lan_ips(),
    ) {
        return Err("上游地址指向本机中转，请填写实际的上游服务地址。".into());
    }
    Ok(url)
}

fn same_upstream_origin(old: &str, new: &reqwest::Url) -> bool {
    reqwest::Url::parse(old.trim()).is_ok_and(|old| old.origin() == new.origin())
}

fn change_provider(
    settings: &mut RelaySettings,
    change: RelayProviderChange,
) -> Result<String, String> {
    match change {
        RelayProviderChange::Save { id, name, patch } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 48 {
                return Err("请填写配置名称，最多 48 个字符。".into());
            }
            let position = id
                .as_deref()
                .map(|id| provider_index(settings, id))
                .transpose()?;
            let mut provider = position
                .map(|i| settings.providers[i].clone())
                .unwrap_or_else(|| Provider {
                    id: uuid::Uuid::new_v4().to_string(),
                    ..Provider::default()
                });
            let endpoint = upstream_url(patch.base_url.as_deref().unwrap_or(&provider.base_url))?;
            if !provider.api_key.is_empty()
                && !same_upstream_origin(&provider.base_url, &endpoint)
                && patch
                    .api_key
                    .as_deref()
                    .is_none_or(|key| key.trim().is_empty())
            {
                return Err("上游地址已变更，请重新填写该服务的 API 密钥。".into());
            }
            apply_upstream_patch(&mut provider, &patch)?;
            provider.base_url = endpoint.to_string();
            provider.name = name.to_string();
            relay_config::normalize_provider(&mut provider);
            provider
                .validate()
                .map_err(|field| format!("请填写{}。", field.label()))?;
            let id = provider.id.clone();
            if let Some(i) = position {
                settings.providers[i] = provider;
            } else if !settings.is_configured() {
                settings.providers.insert(0, provider);
            } else {
                settings.providers.push(provider);
            }
            Ok(id)
        }
        RelayProviderChange::Activate { id } => {
            let i = provider_index(settings, &id)?;
            let provider = &settings.providers[i];
            upstream_url(&provider.base_url)?;
            provider
                .validate()
                .map_err(|field| format!("请先填写{}并保存。", field.label()))?;
            let mut provider = settings.providers.remove(i);
            provider.enabled = true;
            settings.providers.insert(0, provider);
            Ok(id)
        }
        RelayProviderChange::Remove { id } => {
            let i = provider_index(settings, &id)?;
            if settings.active().is_some_and(|p| p.id == id) {
                return Err("请先切换到其他上游，再删除当前上游。".into());
            }
            settings.providers.remove(i);
            Ok(id)
        }
    }
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
    let (old_host, old_port) = runtime.current_listen().await;
    runtime.reload_settings(cfg.relay.clone()).await;
    runtime.set_token(token).await;
    let host = crate::state::relay_listen_host(cfg);
    // 配置里只有 host（`listen_mode` / `lan_ip`），端口不归它管：沿用运行时当前的
    // 端口。写死 `DEFAULT_PORT` 会把「runtime 的端口不是 4100」这类情形静默改回去
    // （测试用 0 拿系统分配口，就会撞上本机正在跑的那个 4100）。
    runtime.set_listen(host.clone(), old_port).await;

    let running = runtime.running_addr().await.is_some();
    if cfg.relay_enabled {
        if !running {
            if let Err(e) = runtime.start(ban_threshold, ban_window_min).await {
                ::log::warn!("导入配置后启动模型中转失败：{e}");
            }
        } else if old_host != host {
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
        let started = state.relay.start(threshold, window).await;
        super::relay_tunnel_cmds::sync_relay_tunnels(state.inner()).await;
        match started {
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
        super::relay_tunnel_cmds::sync_relay_tunnels(state.inner()).await;
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
    let result = state.relay.start(threshold, window).await;
    super::relay_tunnel_cmds::sync_relay_tunnels(state.inner()).await;
    result
}

/// 页面内的「停止中转」。**不动开关**：停了之后页面还在，可以再起来。
#[tauri::command]
pub async fn relay_stop(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let result = state.relay.stop().await;
    super::relay_tunnel_cmds::sync_relay_tunnels(state.inner()).await;
    result
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
    let result = state.relay.restart(threshold, window).await;
    super::relay_tunnel_cmds::sync_relay_tunnels(state.inner()).await;
    result
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
    /// 厂商画像 id。空 = 跟随已保存的配置 / 按地址推断。
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
}

/// 表单草稿补全后的实际值。
///
/// 抽出来是因为「测连通」与「列模型」用的是同一套补全规则：草稿里有的用草稿，
/// 没有的用已保存值。两处各写一遍，迟早会出现「测连通能通、列模型用的是另一个
/// 地址」这种只在特定顺序下复现的问题。
struct EffectiveDraft {
    base_url: String,
    api_key: String,
    model: String,
    auth_style: AuthStyle,
    profile_id: String,
}

fn effective_draft(draft: RelayDraft, provider: &Provider) -> EffectiveDraft {
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
    // 后端认不出这个 id 时落回 host 推断，不因此拒绝——探测的目的就是
    // 「看看这么填能不能通」，不必先过一遍配置校验。
    let profile_id = draft
        .profile_id
        .unwrap_or_else(|| provider.profile_id.clone());
    EffectiveDraft {
        base_url,
        api_key,
        model,
        auth_style,
        profile_id,
    }
}

/// 用当前表单值打一发最小请求。
///
/// 这是「测连通」而不是「发一次真请求」：`max_tokens: 8`，一句话 ping。
/// 失败时自动换另一种鉴权头重试一次，成功就说明该把 `auth_style` 改成那个。
#[tauri::command]
pub async fn relay_test_upstream(
    state: State<'_, Arc<AppState>>,
    draft: RelayDraft,
    provider_id: Option<String>,
) -> Result<relay::ProbeOutcome, String> {
    let effective = resolve_draft(&state, draft, provider_id.as_deref()).await?;

    if effective.base_url.trim().is_empty() {
        return Err("上游地址还没填。".into());
    }
    if effective.api_key.trim().is_empty() {
        return Err("密钥还没填。".into());
    }
    if effective.model.trim().is_empty() {
        return Err("模型还没填。".into());
    }
    relay::probe(
        &effective.base_url,
        &effective.api_key,
        &effective.model,
        effective.auth_style,
        &effective.profile_id,
    )
    .await
}

/// 问上游要模型列表。失败只让下拉退化，不影响保存与转发。
#[tauri::command]
pub async fn relay_list_models(
    state: State<'_, Arc<AppState>>,
    draft: RelayDraft,
    provider_id: Option<String>,
) -> Result<Vec<String>, String> {
    let effective = resolve_draft(&state, draft, provider_id.as_deref()).await?;

    if effective.base_url.trim().is_empty() {
        return Err("上游地址还没填。".into());
    }
    if effective.api_key.trim().is_empty() {
        return Err("密钥还没填。".into());
    }
    relay::catalog::fetch(
        &effective.base_url,
        &effective.api_key,
        effective.auth_style,
        &effective.profile_id,
    )
    .await
}

async fn resolve_draft(
    state: &AppState,
    draft: RelayDraft,
    id: Option<&str>,
) -> Result<EffectiveDraft, String> {
    let provider = {
        let config = state.config.read().await;
        let settings = &config.relay;
        match id {
            Some("") => Provider::default(),
            Some(id) => settings.providers[provider_index(settings, id)?].clone(),
            None => settings.active().cloned().unwrap_or_default(),
        }
    };
    let uses_saved_key = draft
        .api_key
        .as_deref()
        .is_none_or(|key| key.trim().is_empty());
    let effective = effective_draft(draft, &provider);
    let endpoint = upstream_url(&effective.base_url)?;
    if uses_saved_key
        && !provider.api_key.is_empty()
        && !same_upstream_origin(&provider.base_url, &endpoint)
    {
        return Err("上游地址已变更，请重新填写该服务的 API 密钥。".into());
    }
    Ok(effective)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_test_provider(
        id: Option<&str>,
        name: &str,
        url: &str,
        key: Option<&str>,
    ) -> RelayProviderChange {
        RelayProviderChange::Save {
            id: id.map(str::to_owned),
            name: name.into(),
            patch: Box::new(RelayPatch {
                base_url: Some(url.into()),
                api_key: key.map(str::to_owned),
                model: Some(name.into()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn provider_changes_preserve_legacy_config_and_scope_credentials() {
        let mut settings: RelaySettings = serde_json::from_value(serde_json::json!({"providers": [{
            "name": "legacy", "base_url": "https://one.test/v1/messages", "api_key": "first-key",
            "tiers": [{"tier":"default", "upstream_model":"first-model"}]
        }]})).unwrap();
        let standby = change_provider(
            &mut settings,
            save_test_provider(None, "standby", "https://two.test", Some("second-key")),
        )
        .unwrap();
        assert_eq!(settings.active().unwrap().id, "default");
        assert!(change_provider(
            &mut settings,
            save_test_provider(Some(&standby), "standby", "https://different.test", None)
        )
        .is_err());
        assert!(change_provider(
            &mut settings,
            RelayProviderChange::Remove {
                id: "default".into()
            }
        )
        .is_err());
        change_provider(
            &mut settings,
            RelayProviderChange::Activate {
                id: standby.clone(),
            },
        )
        .unwrap();
        let restored: RelaySettings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(restored.active().unwrap().id, standby);
        assert_eq!(restored.active().unwrap().api_key, "second-key");
        assert_eq!(restored.providers[1].api_key, "first-key");
        change_provider(
            &mut settings,
            RelayProviderChange::Remove {
                id: "default".into(),
            },
        )
        .unwrap();
        assert_eq!(settings.providers.len(), 1);
    }

    #[tokio::test]
    async fn switch_routes_new_requests_without_interrupting_existing_requests() {
        use axum::{routing::post, Router};
        use std::time::Duration;
        use tokio::sync::Notify;
        let arrived = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let old_route = {
            let (arrived, release) = (arrived.clone(), release.clone());
            move |headers: axum::http::HeaderMap| async move {
                assert_eq!(headers["x-api-key"], "old-key");
                arrived.notify_one();
                release.notified().await;
                axum::Json(serde_json::json!({"id":"old-response"}))
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = Router::new()
            .route("/old/v1/messages", post(old_route))
            .route(
                "/new/v1/messages",
                post(|headers: axum::http::HeaderMap| async move {
                    assert_eq!(headers["x-api-key"], "new-key");
                    axum::Json(serde_json::json!({"id":"new-response"}))
                }),
            );
        let upstream = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let rt = test_runtime();
        let mut settings = RelaySettings::default();
        let previous = change_provider(
            &mut settings,
            save_test_provider(None, "old", &format!("http://{addr}/old"), Some("old-key")),
        )
        .unwrap();
        let next = change_provider(
            &mut settings,
            save_test_provider(None, "new", &format!("http://{addr}/new"), Some("new-key")),
        )
        .unwrap();
        rt.reload_settings(settings.clone()).await;
        let relay = rt.start(5, 15).await.unwrap();
        let client = reqwest::Client::new();
        let request = || {
            client.post(format!("http://{relay}/v1/messages")).timeout(Duration::from_secs(5))
            .header("x-api-key", "rly_old").json(&serde_json::json!({"model":"claude-sonnet-5-5", "max_tokens":8,"messages":[{"role":"user","content":"ping"}]}))
        };
        let old_request = tokio::spawn(request().send());
        tokio::time::timeout(Duration::from_secs(5), arrived.notified())
            .await
            .unwrap();
        change_provider(
            &mut settings,
            RelayProviderChange::Activate { id: next.clone() },
        )
        .unwrap();
        rt.reload_settings(settings).await;
        assert_eq!(rt.running_addr().await.as_deref(), Some(relay.as_str()));
        assert!(!rt.snapshot(5).await.client_verified);
        let response = request()
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(response.contains("new-response"), "{response}");
        release.notify_one();
        let response = old_request
            .await
            .unwrap()
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(response.contains("old-response"), "{response}");
        assert!(rt.snapshot(5).await.client_verified);
        let rows = rt.log().recent(2);
        assert_eq!(rows[0].upstream_config_id.as_deref(), Some(next.as_str()));
        assert_eq!(rows[0].upstream_config_name.as_deref(), Some("new"));
        assert_eq!(
            rows[1].upstream_config_id.as_deref(),
            Some(previous.as_str())
        );
        assert_eq!(rows[1].upstream_config_name.as_deref(), Some("old"));
        rt.stop().await.unwrap();
        upstream.abort();
    }

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
