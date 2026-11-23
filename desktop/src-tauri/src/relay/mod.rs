//! 模型中转：把 Anthropic 协议请求透传到自配的上游。
//!
//! 模块划分（§4.1）：
//!
//! ```text
//! config.rs    配置模型 + 派生（alias / 名称 / 地址归一化 / 自转发检测）
//! route.rs     客户端模型名 → 档位 → 上游模型
//! rules.rs     确定性改写（strip_model_suffix / clamp_max_tokens）
//! fold.rs      tool_addition / tool_removal 折叠（本方案的立身之本）
//! sanitize.rs  三态清洗：Unchanged / Sanitized / Refused
//! guard.rs     来源守卫（拒浏览器、拒 DNS rebinding）
//! auth.rs      中转 token 校验（两种头都认）
//! log.rs       内存环形 + 按天 JSONL + 今日聚合
//! server.rs    axum Router、监听生命周期、请求主流程
//! ```
//!
//! 这一个文件是**对外 API**：启停、热更新、状态快照。上层（`commands::relay_cmds`
//! 与 `AppState`）只跟它打交道，不直接碰 `server`。
//!
//! P1 只做 Anthropic 透传。OpenAI 兼容（`upstream/openai/*`）是 P3 的事，
//! 现在不建那些空目录——空壳会让人以为已经支持。

pub mod auth;
pub mod config;
pub mod fold;
pub mod guard;
pub mod log;
pub mod route;
pub mod rules;
pub mod sanitize;
pub mod server;

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

pub use self::log::{RelayLog, RelayLogEntry, RelayStats, TierHit};
pub use config::{AuthStyle, MissingField, Provider, RelaySettings, Tier, TierKind, UpstreamKind};
pub use server::RunningServer;

/// 中转的运行时。放在 `AppState` 里，活过页面卸载。
///
/// 三层共享都用 `Arc`：监听任务、IPC 命令、状态快照分别持有引用。热更新换的是
/// `Arc<RelaySettings>` 快照，**不重启监听**（§4.6「配置热生效」）。
pub struct RelayRuntime {
    settings: Arc<tokio::sync::RwLock<Arc<RelaySettings>>>,
    token: Arc<tokio::sync::RwLock<String>>,
    log: Arc<RelayLog>,
    running: tokio::sync::Mutex<Option<RunningServer>>,
    listen_host: tokio::sync::RwLock<String>,
    listen_port: tokio::sync::RwLock<u16>,
}

impl RelayRuntime {
    pub fn new(
        settings: RelaySettings,
        token: String,
        log: Arc<RelayLog>,
        listen_host: String,
        listen_port: u16,
    ) -> Self {
        Self {
            settings: Arc::new(tokio::sync::RwLock::new(Arc::new(settings))),
            token: Arc::new(tokio::sync::RwLock::new(token)),
            log,
            running: tokio::sync::Mutex::new(None),
            listen_host: tokio::sync::RwLock::new(listen_host),
            listen_port: tokio::sync::RwLock::new(listen_port),
        }
    }

    /// 日志句柄。命令层要拿它读最近记录。
    pub fn log(&self) -> Arc<RelayLog> {
        self.log.clone()
    }

    /// 启用中转：起监听。**幂等**——已在运行返回 409 语义的错误，不起第二个
    /// 监听（否则两次点击会两个实例抢同一端口，日志交错）。
    pub async fn start(&self, ban_threshold: u32, ban_window_min: u64) -> Result<String, String> {
        let mut guard = self.running.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Err(format!(
                "中转已经在运行（{}），不需要重复启动。",
                existing.addr
            ));
        }
        let host = self.listen_host.read().await.clone();
        let port = *self.listen_port.read().await;
        let started = server::start(
            self.settings.clone(),
            self.token.clone(),
            self.log.clone(),
            &host,
            port,
            ban_threshold,
            ban_window_min,
        )
        .await?;
        let addr = started.addr.clone();
        *guard = Some(started);
        ::log::info!("模型中转已启动：{addr}");
        Ok(addr)
    }

    /// 停监听。已在停止状态时返回 `Ok`（幂等）。
    pub async fn stop(&self) -> Result<(), String> {
        let server = { self.running.lock().await.take() };
        match server {
            None => Ok(()),
            Some(s) => {
                let addr = s.addr.clone();
                let clean = s.stop().await;
                ::log::info!("模型中转已停止：{addr}");
                if clean {
                    Ok(())
                } else {
                    Err("停止超时（可能还有流式响应在进行），已强制断开。".into())
                }
            }
        }
    }

    /// 重启：先停再起。用于改监听地址后应用新配置。
    pub async fn restart(&self, ban_threshold: u32, ban_window_min: u64) -> Result<String, String> {
        self.stop().await?;
        // Windows 上端口释放有延迟，重启必报 10048 的坑（§4.11）。这里给一小段
        // 退避重试，比让用户手动点第二次好。
        let mut last_err = String::new();
        for attempt in 0..5 {
            match self.start(ban_threshold, ban_window_min).await {
                Ok(addr) => return Ok(addr),
                Err(e) => {
                    last_err = e;
                    tokio::time::sleep(std::time::Duration::from_millis(200 * (attempt + 1))).await;
                }
            }
        }
        Err(last_err)
    }

    /// 热更新配置。不重启监听，只换快照。
    pub async fn reload_settings(&self, settings: RelaySettings) {
        *self.settings.write().await = Arc::new(settings);
    }

    /// 热更新 token。
    pub async fn set_token(&self, token: String) {
        *self.token.write().await = token;
    }

    /// 改监听地址。**只更新值，不自动重启**——调用方（命令层）决定是否 restart，
    /// 因为「改地址」与「现在要不要重启」是两件事。
    pub async fn set_listen(&self, host: String, port: u16) {
        *self.listen_host.write().await = host;
        *self.listen_port.write().await = port;
    }

    pub async fn token_value(&self) -> String {
        self.token.read().await.clone()
    }

    /// 是否有监听在跑，返回地址。
    pub async fn running_addr(&self) -> Option<String> {
        self.running.lock().await.as_ref().map(|s| s.addr.clone())
    }

    async fn running_uptime(&self) -> Option<u64> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|s| s.started_at.elapsed().as_secs())
    }

    /// 状态快照：界面一次拿齐「在跑没 / 地址 / 统计 / 最近几条 / 配置」。
    ///
    /// 一次返回而不是分四个命令，是因为界面两秒轮询一次，四个命令就是四倍 IPC
    /// 与四处可能不同步的时序。
    pub async fn snapshot(&self, recent_n: usize) -> RelaySnapshot {
        let settings = self.settings.read().await.clone();
        let token = self.token.read().await.clone();
        let addr = self.running_addr().await;
        let uptime = if addr.is_some() {
            self.running_uptime().await
        } else {
            None
        };
        RelaySnapshot {
            running: addr.is_some(),
            addr,
            uptime_secs: uptime,
            listen_host: self.listen_host.read().await.clone(),
            port: *self.listen_port.read().await,
            token_masked: auth::mask(&token),
            token,
            stats: self.log.stats_today(),
            recent: self.log.recent(recent_n),
            provider: settings.active().map(ProviderView::from_provider),
            tiers: settings
                .active()
                .map(|p| {
                    TierKind::ALL
                        .into_iter()
                        .map(|kind| TierView {
                            tier: kind.as_str().to_string(),
                            alias: kind.alias().to_string(),
                            env_var: kind.env_var().to_string(),
                            upstream_model: p
                                .upstream_for(kind)
                                .map(str::to_string)
                                .unwrap_or_default(),
                            configured: p.upstream_for(kind).is_some(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// 界面要的全部状态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySnapshot {
    pub running: bool,
    pub addr: Option<String>,
    pub uptime_secs: Option<u64>,
    pub listen_host: String,
    pub port: u16,
    /// 掩码形态，界面标题栏用。
    pub token_masked: String,
    /// 完整令牌。与 MCP token 一致：界面自己 mask，但要能复制。
    pub token: String,
    pub stats: RelayStats,
    pub recent: Vec<RelayLogEntry>,
    /// 当前生效的 provider 视图。没配时是 `None`。
    pub provider: Option<ProviderView>,
    /// 三档映射（含未配置的行，界面要据此显示占位）。
    ///
    /// **不回传原始配置**：表单需要的每个值都在 `provider` / `tiers` 里，
    /// 多传一份 `RelaySettings` 只会多出「snake_case 和 camelCase 两套字段名」
    /// 这个坑，还得担心密钥重复下发。
    pub tiers: Vec<TierView>,
}

/// provider 的界面视图。**密钥只给掩码与「有没有」**，完整值不下发——
/// 上游密钥比中转 token 更没有下发的理由：界面不需要它就能完成全部操作。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub name: String,
    pub base_url: String,
    pub api_key_masked: String,
    pub has_api_key: bool,
    pub kind: String,
    pub auth_style: String,
    pub max_tokens_limit: Option<u32>,
    pub fold_tool_blocks: bool,
    /// 三格是否齐。
    pub configured: bool,
    /// 缺哪一格（`baseUrl` / `apiKey` / `model`）。
    pub missing: Option<String>,
}

impl ProviderView {
    fn from_provider(p: &Provider) -> Self {
        let missing = p.validate().err();
        Self {
            name: if p.name.is_empty() {
                config::derive_name(&p.base_url)
            } else {
                p.name.clone()
            },
            base_url: p.base_url.clone(),
            api_key_masked: auth::mask(&p.api_key),
            has_api_key: !p.api_key.trim().is_empty(),
            kind: match p.kind {
                UpstreamKind::Anthropic => "anthropic",
                UpstreamKind::Openai => "openai",
            }
            .into(),
            auth_style: p.auth_style.as_str().into(),
            max_tokens_limit: p.max_tokens_limit,
            fold_tool_blocks: p.fold_tool_blocks,
            configured: missing.is_none(),
            missing: missing.map(|m| {
                match m {
                    MissingField::BaseUrl => "baseUrl",
                    MissingField::ApiKey => "apiKey",
                    MissingField::Model => "model",
                }
                .to_string()
            }),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierView {
    pub tier: String,
    /// 远端要填的映射名，**只由档位定**（§4.6.3）。
    pub alias: String,
    pub env_var: String,
    /// 上游真名，未配置时为空串。
    pub upstream_model: String,
    pub configured: bool,
}

/// 测连通的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub status: u16,
    pub ok: bool,
    /// 首字节耗时。这是人真正感知的「快不快」。
    pub first_byte_ms: Option<u64>,
    pub total_ms: u64,
    /// 非 2xx 时上游的原文（截断）。用户要看到原始报错，不要我们转述。
    pub error_head: Option<String>,
    /// 用 x-api-key 失败、换成 Bearer 成功了。
    pub switched_auth: Option<String>,
}

/// 打一发最小请求验证上游能不能通。
///
/// 存在的理由：上游地址少写一段路径、密钥类型不对、模型名不存在，这三种错在
/// 中转页上都表现成「远端 400」，很难定位。这里用当前表单值直接打一发，
/// 把状态码与上游原文原样带回来。
///
/// 失败时**自动换一种鉴权头重试一次**（§4.6 表：`auth_style` 的默认值就是这么
/// 定下来的）——很多网关只认 Bearer，而只认 x-api-key 的也不少，让人自己去
/// 试两种头是白白多一个排查步骤。
pub async fn probe(
    base_url: &str,
    api_key: &str,
    model: &str,
    auth_style: AuthStyle,
) -> Result<ProbeOutcome, String> {
    let url = config::normalize_endpoint(base_url);
    if url.is_empty() {
        return Err("上游地址还没填。".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let payload = serde_json::json!({
        "model": model,
        "max_tokens": 8,
        "messages": [{ "role": "user", "content": "ping" }]
    });

    let first = send_probe(&client, &url, api_key, auth_style, &payload).await;
    let outcome = match first {
        Ok(o) if o.ok => return Ok(o),
        Ok(o) => o,
        Err(e) => return Err(e),
    };

    // 401 / 403 时换另一种鉴权头再试一次
    let alt = match auth_style {
        AuthStyle::XApiKey => AuthStyle::Bearer,
        AuthStyle::Bearer => AuthStyle::XApiKey,
    };
    match send_probe(&client, &url, api_key, alt, &payload).await {
        Ok(retry) if retry.ok => Ok(ProbeOutcome {
            switched_auth: Some(alt.as_str().to_string()),
            ..retry
        }),
        _ => Ok(outcome),
    }
}

async fn send_probe(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    style: AuthStyle,
    payload: &serde_json::Value,
) -> Result<ProbeOutcome, String> {
    let started = Instant::now();
    let mut req = client.post(url).json(payload);
    req = match style {
        AuthStyle::XApiKey => req.header("x-api-key", api_key),
        AuthStyle::Bearer => req.header("authorization", format!("Bearer {api_key}")),
    };
    let resp = req
        .send()
        .await
        .map_err(|e| server::describe_send_error(&e, url))?;
    let status = resp.status().as_u16();
    let first_byte_ms = Some(started.elapsed().as_millis() as u64);
    let text = resp.text().await.unwrap_or_default();
    let ok = (200..300).contains(&status);
    Ok(ProbeOutcome {
        status,
        ok,
        first_byte_ms,
        total_ms: started.elapsed().as_millis() as u64,
        error_head: if ok { None } else { Some(truncate(&text, 512)) },
        switched_auth: None,
    })
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_addr_is_reused_from_server() {
        assert_eq!(server::socket_addr("::1", 4100), "[::1]:4100");
    }

    #[test]
    fn provider_view_masks_key() {
        let p = Provider {
            base_url: "https://host/apps/anthropic/v1/messages".into(),
            api_key: "sk-1234567890abcdef".into(),
            tiers: vec![Tier {
                tier: TierKind::Default,
                upstream_model: "m".into(),
            }],
            ..Provider::default()
        };
        let view = ProviderView::from_provider(&p);
        assert!(view.has_api_key);
        assert!(!view.api_key_masked.contains("1234567890"));
        assert!(view.configured);
        assert!(view.missing.is_none());
    }

    #[test]
    fn provider_view_reports_missing_field() {
        let p = Provider::default();
        let view = ProviderView::from_provider(&p);
        assert!(!view.configured);
        assert_eq!(view.missing.as_deref(), Some("baseUrl"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let text = "中文中文中文";
        let cut = truncate(text, 4);
        assert!(cut.ends_with('…'));
        // 不能切出半个字符
        assert!(cut.trim_end_matches('…').len() <= 4);
    }

    #[test]
    fn tier_views_always_list_three_rows() {
        let p = Provider {
            tiers: vec![Tier {
                tier: TierKind::Default,
                upstream_model: "m".into(),
            }],
            ..Provider::default()
        };
        let views: Vec<TierView> = TierKind::ALL
            .into_iter()
            .map(|kind| TierView {
                tier: kind.as_str().to_string(),
                alias: kind.alias().to_string(),
                env_var: kind.env_var().to_string(),
                upstream_model: p.upstream_for(kind).unwrap_or("").to_string(),
                configured: p.upstream_for(kind).is_some(),
            })
            .collect();
        assert_eq!(views.len(), 3);
        assert!(views[0].configured);
        assert!(!views[1].configured, "未配置的档也要出现，界面要显示占位");
        assert_eq!(views[0].alias, "claude-sonnet-5-5");
    }
}
