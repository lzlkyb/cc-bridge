//! 中转配置模型：一个 provider、三档映射、派生出来的映射名。
//!
//! 存储形态是**一条 JSON**（`config` 表里的 `relay` 键），不是三张关系表。
//! 方案文档 §4.6 给的是字段结构，不是表数量：单 provider、单 token 的自建场景下，
//! 三张表只会换来三次联表查询和一套没人用的 CRUD。字段名与语义保持与文档一致，
//! 将来真要多 provider（P4）时，`providers` 已经是数组，不用改结构。
//!
//! 这里**不存任何派生值**——映射名由档位算、provider 名由域名算。存下来就会
//! 出现「改了档位但映射名还是旧的」这类只有重启才能发现的问题。

use serde::{Deserialize, Serialize};

use super::profile::{self, Dialect, Profile, Quirks};

/// 默认监听端口。不暴露给用户（§4.6：端口冲突极少见，真冲突时错误里给建议）。
pub const DEFAULT_PORT: u16 = 4100;
/// 默认日志保留条数。不暴露给用户。
pub const DEFAULT_LOG_KEEP: usize = 5_000;
/// 请求体上限 32MB。axum 默认 2MB，Claude Code 带工具定义的大 payload 会破。
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// 档位。
///
/// **只有三档，`sonnet` 被 `default` 吸收了。** 理由见 §4.6.1：默认档的映射名
/// `claude-sonnet-5-5` 本身就在 sonnet 的位置上，再给一个独立 sonnet 档，两档会
/// 争同一个名字，只能靠「谁先匹配」决定。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TierKind {
    Haiku,
    Opus,
    // `#[serde(other)]` 按 serde 约束必须挂在最后一个 variant 上——variant 的
    // **书写顺序与逻辑顺序无关**（逻辑顺序见 `ALL`，`alias`/`as_str`/`env_var`
    // 都是 match 全覆盖，不依赖位置）。
    //
    // 未知档位（旧版本残留的 "sonnet"、手改错的拼写）落到 default，而不是让
    // **整份** RelaySettings 反序列化失败。失败会被 `parse_or_warn` 吞成
    // `Default::default()`——那会把 base_url / api_key / 三档一起重置，
    // 且下一次保存把空值永久写回 DB。
    #[default]
    #[serde(other)]
    Default,
}

impl TierKind {
    /// 全部档位，顺序即 UI 与日志展示顺序。
    pub const ALL: [TierKind; 3] = [TierKind::Default, TierKind::Haiku, TierKind::Opus];

    /// 映射名。**只由档位决定，绝不拼上游真名**（§4.6.3 第 2 条）。
    ///
    /// 上游叫 `qwen4-max-preview`，映射名照样是 `claude-sonnet-5-5`：拼上游名既
    /// 暴露了上游，又会让关键词匹配多出一种误判来源。
    pub fn alias(self) -> &'static str {
        match self {
            TierKind::Default => "claude-sonnet-5-5",
            TierKind::Haiku => "claude-haiku-5-5",
            TierKind::Opus => "claude-opus-5-5",
        }
    }

    /// 用于识别客户端自己拼的原生模型名的关键词。
    ///
    /// `default` 返回 `None`——它没有关键词，它是兜底。而 `sonnet` **故意不在
    /// 任何档位的关键词里**：Claude Code 发 `claude-sonnet-4-5-20250929` 时，
    /// 语义上就是「要主力模型」，也就是 `default`。把它当成「sonnet 档未配置已
    /// 回落」会制造一条假的回落信号，把「配错 alias 一眼能看出来」废掉。
    pub fn keyword(self) -> Option<&'static str> {
        match self {
            TierKind::Default => None,
            TierKind::Haiku => Some("haiku"),
            TierKind::Opus => Some("opus"),
        }
    }

    /// 客户端要注入的环境变量名。`default` 用 `ANTHROPIC_MODEL`。
    ///
    /// **没有 `ANTHROPIC_DEFAULT_SONNET_MODEL`，永远不加**（§4.8.3）。
    pub fn env_var(self) -> &'static str {
        match self {
            TierKind::Default => "ANTHROPIC_MODEL",
            TierKind::Haiku => "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            TierKind::Opus => "ANTHROPIC_DEFAULT_OPUS_MODEL",
        }
    }

    /// 日志与 UI 里的短名。
    pub fn as_str(self) -> &'static str {
        match self {
            TierKind::Default => "default",
            TierKind::Haiku => "haiku",
            TierKind::Opus => "opus",
        }
    }
}

/// 一档映射。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Tier {
    // 缺这一行字段 = 按 default 档读。没有 default 时缺字段会让整个
    // `RelaySettings` 解析失败并被重置（见 `TierKind` 上的注释）。
    #[serde(default)]
    pub tier: TierKind,
    /// 上游真名。留空 = 该档未配置，请求落 `default`。
    #[serde(default)]
    pub upstream_model: String,
}

impl Tier {
    /// 是否算「已配置」。空白串与缺行同义——用户在输入框里删干净就该当没配。
    pub fn is_configured(&self) -> bool {
        !self.upstream_model.trim().is_empty()
    }

    /// UI 与远端配置要用的映射名。
    pub fn alias(&self) -> &'static str {
        self.tier.alias()
    }
}

/// 上游鉴权头形态。
///
/// 默认 `x-api-key`；首次测连通失败时自动换 `bearer` 再试一次，成功即写回
/// （§4.6 表）。用户不用碰这一项，排障时才在「高级」里露出来。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthStyle {
    /// `x-api-key: <token>`（Anthropic 官方形态）
    #[default]
    XApiKey,
    /// `Authorization: Bearer <token>`
    Bearer,
}

impl AuthStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthStyle::XApiKey => "x-api-key",
            AuthStyle::Bearer => "bearer",
        }
    }
}

/// 上游协议族。P1 恒为 Anthropic 透传；OpenAI 兼容是 P3 的事。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamKind {
    #[default]
    Anthropic,
    Openai,
}

/// 一个上游 provider。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Provider {
    /// 稳定 id。P1 只有一个，固定 `default`，但保留字段以便 P4 多上游。
    #[serde(default = "default_provider_id")]
    pub id: String,
    /// 显示名。**由 `base_url` 的域名推导，不问用户**（§4.6.2「能推导的不出现」）。
    #[serde(default)]
    pub name: String,
    /// 上游 Messages 端点。存**归一化后**的完整地址（含 `/v1/messages`）。
    // 缺字段按空串读（`validate` 会报「缺上游地址」），而不是拖垮整份配置。
    #[serde(default)]
    pub base_url: String,
    /// 上游密钥。
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub kind: UpstreamKind,
    /// 用户显式选的厂商画像 id（`profile::PRESETS` 里的 id）。
    ///
    /// 空 = 按 `base_url` 的 host 自动推断。**推断结果不回写这里**：它是由地址
    /// 派生的值，存下来就会出现「改了地址但画像还是旧的」这种只有重启才发现的问题。
    /// 只有用户从下拉里主动选了厂商时才写入。
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub auth_style: AuthStyle,
    /// `max_tokens` 上限。`None` = 不压。
    #[serde(default)]
    pub max_tokens_limit: Option<u32>,
    /// 是否折叠 `tool_*` 变更块（§4.4.1 默认预折叠）。
    #[serde(default = "default_true")]
    pub fold_tool_blocks: bool,
    /// 是否把工具 schema 里的 `\0` 归一化成 `\x00`（语义等价，见 `schema.rs`）。
    ///
    /// **三态**：`None` = 跟随厂商画像（`profile::Quirks::normalize_null_escape`，
    /// 默认为真）；`Some(v)` = 用户显式指定，压过画像。三态而不是布尔，是因为
    /// 「用户关掉」和「还没表态」必须能区分——否则画像想替某家上游关掉时，
    /// 会被旧配置里写死的 `true` 顶掉。
    #[serde(default)]
    pub normalize_tool_patterns: Option<bool>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 档位映射。至少要有 `default` 一行才算配好。
    #[serde(default)]
    pub tiers: Vec<Tier>,
}

fn default_provider_id() -> String {
    "default".into()
}

fn default_true() -> bool {
    true
}

impl Default for Provider {
    fn default() -> Self {
        Self {
            id: default_provider_id(),
            name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            kind: UpstreamKind::Anthropic,
            profile_id: String::new(),
            auth_style: AuthStyle::XApiKey,
            max_tokens_limit: None,
            fold_tool_blocks: true,
            normalize_tool_patterns: None,
            enabled: true,
            tiers: vec![Tier::default()],
        }
    }
}

impl Provider {
    /// 取某一档；没有那一行就返回 `None`。
    pub fn tier(&self, kind: TierKind) -> Option<&Tier> {
        self.tiers.iter().find(|t| t.tier == kind)
    }

    /// 该档的上游模型名，未配置返回 `None`。
    pub fn upstream_for(&self, kind: TierKind) -> Option<&str> {
        self.tier(kind)
            .filter(|t| t.is_configured())
            .map(|t| t.upstream_model.trim())
    }

    /// 已配置的档位，按 `TierKind::ALL` 顺序。
    pub fn configured_tiers(&self) -> Vec<TierKind> {
        TierKind::ALL
            .into_iter()
            .filter(|k| self.upstream_for(*k).is_some())
            .collect()
    }

    /// 三个必填项是否齐全。返回第一个缺的那一项供 UI 定位。
    pub fn validate(&self) -> Result<(), MissingField> {
        if self.base_url.trim().is_empty() {
            return Err(MissingField::BaseUrl);
        }
        if self.api_key.trim().is_empty() {
            return Err(MissingField::ApiKey);
        }
        if self.upstream_for(TierKind::Default).is_none() {
            return Err(MissingField::Model);
        }
        Ok(())
    }

    /// 该 provider 是否可以直接转发。
    pub fn is_usable(&self) -> bool {
        self.enabled && self.validate().is_ok()
    }

    /// 解析后的厂商画像。用户显式选的 id 优先，否则按 host 推断，认不出落 `custom`。
    pub fn profile(&self) -> &'static Profile {
        profile::resolve(&self.base_url, &self.profile_id)
    }

    /// 实际生效的怪癖：画像给默认，`Provider` 上的显式字段压过它。
    ///
    /// 这是「表驱动」的关键一步——规则读这里，不再读一个个散落的布尔字段。
    pub fn quirks(&self) -> Quirks {
        let base = self.profile().quirks;
        Quirks {
            normalize_null_escape: self
                .normalize_tool_patterns
                .unwrap_or(base.normalize_null_escape),
            clamp_max_tokens: self.max_tokens_limit.or(base.clamp_max_tokens),
            ..base
        }
    }

    /// 上游协议方言。转发层按它决定「透传」还是「转换」。
    ///
    /// 老字段 `kind` 不再参与运行时判定：它是派生值，`normalize_settings` 会
    /// 按方言回写，只为了让界面与日志显示一致。
    pub fn dialect(&self) -> Dialect {
        self.profile().dialect
    }

    /// 真正要 POST 的地址。
    ///
    /// - Anthropic 方言：按客户端过来的路径换后缀，`/v1/messages` 与
    ///   `/v1/messages/count_tokens` 共用同一个前缀。
    /// - OpenAI 方言：`base_url` 本身就是 `/chat/completions`，没有可换的后缀。
    ///   `count_tokens` 这类 Anthropic 独有的路径由上层自行处理（本地估算），
    ///   不能塞给 OpenAI 上游。
    pub fn endpoint_for(&self, path: &str) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        match self.dialect() {
            Dialect::Anthropic => {
                let root = base.strip_suffix("/v1/messages").unwrap_or(base);
                format!("{root}{path}")
            }
            Dialect::OpenAi => base.to_string(),
        }
    }
}

/// 三格必填项里的哪一个缺了。UI 据此把焦点与错误指向那一格。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissingField {
    BaseUrl,
    ApiKey,
    Model,
}

impl MissingField {
    pub fn label(self) -> &'static str {
        match self {
            MissingField::BaseUrl => "上游地址",
            MissingField::ApiKey => "密钥",
            MissingField::Model => "模型",
        }
    }
}

/// 单条模型覆盖（§4.6 的 `relay_override`）。
///
/// P1 不暴露 UI，但解析器已经认它——留着是因为它是「某个客户端模型名要固定走
/// 某个上游模型」的唯一出口，去掉会让将来加回来时改解析顺序。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OverrideRule {
    #[serde(default)]
    pub client_model: String,
    #[serde(default)]
    pub upstream_model: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// 中转的全部可持久化配置。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RelaySettings {
    /// 上游列表。P1 只用第一个（`active()`）。
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// 精确覆盖规则。
    #[serde(default)]
    pub overrides: Vec<OverrideRule>,
}

impl RelaySettings {
    /// 当前生效的 provider。P1 单 provider，取第一个启用的；都没有则取第一个。
    pub fn active(&self) -> Option<&Provider> {
        self.providers
            .iter()
            .find(|p| p.enabled)
            .or_else(|| self.providers.first())
    }

    /// 可变引用，供保存时就地修补（归一化地址、补 name）。
    pub fn active_mut(&mut self) -> Option<&mut Provider> {
        let idx =
            self.providers
                .iter()
                .position(|p| p.enabled)
                .or(if self.providers.is_empty() {
                    None
                } else {
                    Some(0)
                })?;
        self.providers.get_mut(idx)
    }

    /// 是否已经配好三格。UI 用它决定「待填写」还是可用态。
    pub fn is_configured(&self) -> bool {
        self.active().map(|p| p.validate().is_ok()).unwrap_or(false)
    }
}

/// 把用户填的地址归一化成完整 Messages 端点。
///
/// 用户手里只有 `https://host/apps/anthropic` 这种前缀，让他自己补 `/v1/messages`
/// 是「多问一个他答不上来的问题」（§4.6.2）。规则：
/// - 已以 `/v1/messages` 结尾 → 原样（去掉尾斜杠）
/// - 否则拼 `/v1/messages`
///
/// 注意 `/v1/messages/count_tokens` 这类子路径**不在这里处理**：转发时按请求路径
/// 替换后缀，所以存下来的永远是 `/v1/messages` 这一条基址。
pub fn normalize_endpoint(raw: &str) -> String {
    normalize_endpoint_with(raw, "", Dialect::Anthropic)
}

/// 同上，但按厂商画像补路径段、按方言选端点后缀。
///
/// 国内厂商的 Anthropic 端点大多不是裸 `/v1/messages`：DeepSeek 是 `/anthropic`，
/// 智谱是 `/api/anthropic`，百炼是 `/apps/anthropic`。让用户自己记住这些，
/// 等于让他在「403 / 404 / 填对了」之间反复试（§4.6.2「能推导的不出现」）。
///
/// 规则：
/// - 空串 → 空串
/// - 已以该方言的端点结尾 → 原样
/// - 地址带了路径（`/anthropic` 这类）→ 视为前缀，只补端点，**不再叠加** hint
///   （用户填得比 hint 更准）
/// - 地址只有域名（或域名 + `/`）→ 补 `hint` + 端点
///
/// 🔴 端点后缀由**方言**决定，不是常量：OpenAI 是 `/chat/completions`，
/// 拿 Anthropic 的后缀去拼会得到 `/v1/v1/messages` 这种必然 404 的地址。
pub fn normalize_endpoint_with(raw: &str, hint: &str, dialect: Dialect) -> String {
    let suffix = match dialect {
        Dialect::Anthropic => "/v1/messages",
        Dialect::OpenAi => "/chat/completions",
    };
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with(suffix) {
        return trimmed.to_string();
    }
    let path = path_part(trimmed);
    if path.is_empty() || path == "/" {
        let hint = hint.trim().trim_end_matches('/');
        format!("{trimmed}{hint}{suffix}")
    } else {
        format!("{trimmed}{suffix}")
    }
}

/// 取 URL 的路径部分（含前导斜杠）。没有路径返回空串。
fn path_part(raw: &str) -> &str {
    let after_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    match after_scheme.find('/') {
        Some(index) => &after_scheme[index..],
        None => "",
    }
}

/// 从端点推导 provider 显示名：取主机名的第一段。
///
/// `https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages`
/// → `qianwenaiapi`。推导不出来就返回空串，UI 退化成显示「上游」。
pub fn derive_name(endpoint: &str) -> String {
    let without_scheme = endpoint
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(endpoint);
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        // 去端口（含 IPv6 方括号形态）
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or_else(|| without_scheme.split('/').next().unwrap_or(""))
        .trim_matches(['[', ']']);
    host.split('.').next().unwrap_or("").to_string()
}

/// 规范化一份配置：地址归一化 + 补 name + 档位去重补 default。
///
/// **保存时调用一次**，读取时不再修补——读取路径上做修补会让「用户看到的」与
/// 「存下来的」不一致，而这类不一致只有重启才发现。
pub fn normalize_settings(settings: &mut RelaySettings) {
    for provider in &mut settings.providers {
        // 先按原始地址认厂商，再按它的 hint 归一化——顺序反了就用不上 hint。
        let preset = profile::resolve(&provider.base_url, &provider.profile_id);
        provider.base_url =
            normalize_endpoint_with(&provider.base_url, preset.endpoint_hint, preset.dialect);
        if provider.name.trim().is_empty() {
            provider.name = if preset.id == profile::CUSTOM.id {
                derive_name(&provider.base_url)
            } else {
                // 认出来的厂商用画像里的正名：`api.deepseek.com` 按域名推导会得到
                // 一个没有意义的「api」，界面上完全看不出接的是谁。
                preset.label.to_string()
            };
        }
        // `kind` 是派生值，跟着方言走，只为界面/日志显示一致。
        let dialect = provider.dialect();
        provider.kind = match dialect {
            Dialect::Anthropic => UpstreamKind::Anthropic,
            Dialect::OpenAi => UpstreamKind::Openai,
        };
        provider.api_key = provider.api_key.trim().to_string();
        // 档位去重：同档多行以最后一行为准（用户后面填的那次）。
        let mut seen: Vec<TierKind> = Vec::new();
        let mut deduped: Vec<Tier> = Vec::new();
        for tier in provider.tiers.drain(..) {
            if let Some(pos) = seen.iter().position(|k| *k == tier.tier) {
                deduped[pos] = tier;
            } else {
                seen.push(tier.tier);
                deduped.push(tier);
            }
        }
        // default 永远存在（可以为空），否则 UI 少一行、解析器还得特判。
        if !seen.contains(&TierKind::Default) {
            deduped.insert(0, Tier::default());
        }
        // 按固定顺序排，UI 不必再排；同时丢掉未知档（旧版本残留）。
        deduped.sort_by_key(|t| {
            TierKind::ALL
                .iter()
                .position(|k| *k == t.tier)
                .unwrap_or(usize::MAX)
        });
        provider.tiers = deduped;
    }
}

/// 自转发检测：`base_url` 是不是指向中转自己。
///
/// 保存时就要拒（§4.10 第 9 条）。不拒的后果是一次请求自己调自己，瞬间打满线程栈——
/// 现象是「界面卡死」，没人会往「上游地址填成了自己」上想。
///
/// 判定：端口等于中转端口，且主机是回环或本机网卡 IP。端口不同不算——那就是另一
/// 个服务，允许。
pub fn is_self_forward(endpoint: &str, listen_port: u16, lan_ips: &[String]) -> bool {
    let Some((host, port)) = split_host_port(endpoint) else {
        return false;
    };
    if port != listen_port {
        return false;
    }
    let is_loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]");
    is_loopback || lan_ips.iter().any(|ip| ip == &host)
}

/// 从 URL 里拆出 (host, port)。没有端口时按 scheme 给默认值。
fn split_host_port(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    // IPv6: [::1]:4100
    if let Some(stripped) = authority.strip_prefix('[') {
        let (host, tail) = stripped.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or_else(|| default_port_for(scheme));
        return Some((format!("[{host}]"), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            Some((host.to_string(), port.parse().ok()?))
        }
        _ => Some((authority.to_string(), default_port_for(scheme))),
    }
}

fn default_port_for(scheme: &str) -> u16 {
    if scheme.eq_ignore_ascii_case("https") {
        443
    } else {
        80
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_is_derived_from_tier_only() {
        // §4.6.3 第 2 条：上游叫什么都不影响映射名。
        let p = Provider {
            tiers: upstream_model_setup("claude-sonnet-distill"),
            ..Provider::default()
        };
        assert_eq!(
            p.tier(TierKind::Default).unwrap().alias(),
            "claude-sonnet-5-5"
        );
        // 名字里含 sonnet 也不许拼进 alias
        assert!(!p
            .tier(TierKind::Default)
            .unwrap()
            .alias()
            .contains("distill"));
    }

    // 小工具：把「填一格 default」写成表达式，避免每个测试重复四行。
    fn upstream_model_setup(model: &str) -> Vec<Tier> {
        vec![Tier {
            tier: TierKind::Default,
            upstream_model: model.into(),
        }]
    }

    #[test]
    fn missing_fields_are_reported_in_order() {
        let p = Provider::default();
        assert_eq!(p.validate(), Err(MissingField::BaseUrl));

        let p = Provider {
            base_url: "https://h/apps/anthropic/v1/messages".into(),
            ..Provider::default()
        };
        assert_eq!(p.validate(), Err(MissingField::ApiKey));

        let p = Provider {
            base_url: "https://h/apps/anthropic/v1/messages".into(),
            api_key: "sk".into(),
            ..Provider::default()
        };
        // 默认 tiers 里有一行空的 default → 仍算缺模型
        assert_eq!(p.validate(), Err(MissingField::Model));

        let p = Provider {
            base_url: "https://h/apps/anthropic/v1/messages".into(),
            api_key: "sk".into(),
            tiers: upstream_model_setup("qwen4-max-preview"),
            ..Provider::default()
        };
        assert_eq!(p.validate(), Ok(()));
    }

    #[test]
    fn blank_tier_is_treated_as_unconfigured() {
        // 用户在输入框里删干净 = 没配，不能因为「有一行空行」就算配置完成。
        let p = Provider {
            tiers: vec![Tier {
                tier: TierKind::Haiku,
                upstream_model: "   ".into(),
            }],
            ..Provider::default()
        };
        assert!(p.upstream_for(TierKind::Haiku).is_none());
        assert_eq!(p.configured_tiers(), vec![]);
    }

    #[test]
    fn endpoint_normalization_appends_messages_path() {
        assert_eq!(
            normalize_endpoint("https://host/apps/anthropic"),
            "https://host/apps/anthropic/v1/messages"
        );
        assert_eq!(
            normalize_endpoint("https://host/apps/anthropic/"),
            "https://host/apps/anthropic/v1/messages"
        );
        assert_eq!(
            normalize_endpoint("https://host/apps/anthropic/v1/messages"),
            "https://host/apps/anthropic/v1/messages"
        );
        assert_eq!(normalize_endpoint("  "), "");
    }

    #[test]
    fn endpoint_hint_applies_only_to_bare_hosts() {
        // 只填域名 → 补厂商的路径段
        assert_eq!(
            normalize_endpoint_with("https://api.deepseek.com", "/anthropic", Dialect::Anthropic),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
        assert_eq!(
            normalize_endpoint_with(
                "https://open.bigmodel.cn",
                "/api/anthropic",
                Dialect::Anthropic
            ),
            "https://open.bigmodel.cn/api/anthropic/v1/messages"
        );
        // 用户自己填了路径 → 视为比 hint 更准，不再叠加
        assert_eq!(
            normalize_endpoint_with(
                "https://api.deepseek.com/anthropic",
                "/anthropic",
                Dialect::Anthropic
            ),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
        // 已经是完整端点 → 原样
        assert_eq!(
            normalize_endpoint_with(
                "https://api.deepseek.com/anthropic/v1/messages",
                "/anthropic",
                Dialect::Anthropic
            ),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
        // 没有 hint 的厂商（官方 / 自定义）→ 行为与以前一致
        assert_eq!(
            normalize_endpoint_with("https://host/", "", Dialect::Anthropic),
            "https://host/v1/messages"
        );
    }

    #[test]
    fn user_override_beats_profile_quirks() {
        let mut p = Provider {
            base_url: "https://api.deepseek.com/anthropic/v1/messages".into(),
            ..Provider::default()
        };
        assert_eq!(p.profile().id, "deepseek");
        // 默认跟随画像
        assert!(p.quirks().normalize_null_escape);
        assert_eq!(p.quirks().clamp_max_tokens, None);

        // 显式关掉压过画像
        p.normalize_tool_patterns = Some(false);
        assert!(!p.quirks().normalize_null_escape);

        // 显式上限压过画像里的 None
        p.max_tokens_limit = Some(4096);
        assert_eq!(p.quirks().clamp_max_tokens, Some(4096));
    }

    #[test]
    fn explicit_profile_id_survives_unrecognized_host() {
        // 自建反代：host 认不出来，但用户明确选了 DeepSeek。
        let p = Provider {
            base_url: "https://my-proxy.example.com".into(),
            profile_id: "deepseek".into(),
            ..Provider::default()
        };
        assert_eq!(p.profile().id, "deepseek");
        assert_eq!(p.dialect(), Dialect::Anthropic);
    }

    #[test]
    fn normalize_settings_fills_profile_label_and_hint() {
        let mut settings = RelaySettings {
            providers: vec![Provider {
                base_url: "https://api.deepseek.com".into(),
                api_key: "k".into(),
                tiers: upstream_model_setup("deepseek-flash"),
                ..Provider::default()
            }],
            overrides: vec![],
        };
        normalize_settings(&mut settings);
        let p = &settings.providers[0];
        assert_eq!(p.base_url, "https://api.deepseek.com/anthropic/v1/messages");
        // 按域名推导会得到没有意义的「api」，认出来的厂商用正名
        assert_eq!(p.name, "DeepSeek");
        assert_eq!(p.kind, UpstreamKind::Anthropic);
    }

    #[test]
    fn openai_profile_derives_openai_kind() {
        let mut settings = RelaySettings {
            providers: vec![Provider {
                base_url: "https://api.openai.com".into(),
                api_key: "k".into(),
                tiers: upstream_model_setup("gpt-5.5"),
                ..Provider::default()
            }],
            overrides: vec![],
        };
        normalize_settings(&mut settings);
        let p = &settings.providers[0];
        assert_eq!(p.dialect(), Dialect::OpenAi);
        // kind 是派生值，跟着方言走
        assert_eq!(p.kind, UpstreamKind::Openai);
        assert_eq!(p.base_url, "https://api.openai.com/v1/chat/completions");
    }

    #[test]
    fn name_is_derived_from_domain() {
        assert_eq!(
            derive_name("https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages"),
            "token-plan"
        );
        assert_eq!(derive_name("http://127.0.0.1:4100/v1/messages"), "127");
        assert_eq!(derive_name(""), "");
    }

    #[test]
    fn self_forward_is_detected_by_port_and_host() {
        let lan = vec!["10.0.19.194".to_string()];
        assert!(is_self_forward(
            "http://127.0.0.1:4100/v1/messages",
            4100,
            &lan
        ));
        assert!(is_self_forward(
            "http://localhost:4100/v1/messages",
            4100,
            &lan
        ));
        assert!(is_self_forward("http://[::1]:4100/v1/messages", 4100, &lan));
        assert!(is_self_forward(
            "http://10.0.19.194:4100/v1/messages",
            4100,
            &lan
        ));
        // 端口不同 = 另一个服务，允许
        assert!(!is_self_forward(
            "http://127.0.0.1:8080/v1/messages",
            4100,
            &lan
        ));
        // 外部主机同端口，允许
        assert!(!is_self_forward(
            "https://api.anthropic.com:4100/v1/messages",
            4100,
            &lan
        ));
    }

    #[test]
    fn normalize_fills_name_dedupes_tiers_and_keeps_default() {
        let mut settings = RelaySettings {
            providers: vec![Provider {
                base_url: "https://host/apps/anthropic/".into(),
                api_key: "  sk-1  ".into(),
                tiers: vec![
                    Tier {
                        tier: TierKind::Haiku,
                        upstream_model: "old".into(),
                    },
                    Tier {
                        tier: TierKind::Haiku,
                        upstream_model: "new".into(),
                    },
                ],
                ..Provider::default()
            }],
            overrides: vec![],
        };
        normalize_settings(&mut settings);
        let p = &settings.providers[0];
        assert_eq!(p.base_url, "https://host/apps/anthropic/v1/messages");
        assert_eq!(p.name, "host");
        assert_eq!(p.api_key, "sk-1");
        // 同档多行取最后一行
        assert_eq!(p.tiers.len(), 2);
        assert_eq!(p.tier(TierKind::Haiku).unwrap().upstream_model, "new");
        // default 被补回来且排第一
        assert_eq!(p.tiers[0].tier, TierKind::Default);
    }

    #[test]
    fn env_vars_never_include_sonnet() {
        // §4.8.3：没有 ANTHROPIC_DEFAULT_SONNET_MODEL，永远不加。
        for kind in TierKind::ALL {
            assert_ne!(kind.env_var(), "ANTHROPIC_DEFAULT_SONNET_MODEL");
        }
        assert_eq!(TierKind::Default.env_var(), "ANTHROPIC_MODEL");
        assert_eq!(TierKind::Haiku.env_var(), "ANTHROPIC_DEFAULT_HAIKU_MODEL");
    }

    // ── serde 容错：单个坏字段不许重置整份配置 ──────────────────────────
    //
    // 这些字段曾经都没有 default：未知 enum variant / 缺字段会让**整个**
    // `RelaySettings` 反序列化失败，`config.rs` 的 `parse_or_warn` 再用
    // `Default::default()` 兜底——base_url / api_key / 三档全部清零，
    // 且下一次保存把空值永久写回 DB。回归测试钉住「坏字段被局部降级」。

    #[test]
    fn unknown_tier_kind_falls_back_to_default_instead_of_failing() {
        // 注意：`RelaySettings`/`Provider`/`Tier` **没有** `rename_all camelCase`，
        // 存储与反序列化都是 snake_case——这里的字段名写错（曾误用 camelCase）
        // 会被当未知字段静默忽略，测试就会以另一种方式失败。
        let settings: RelaySettings = serde_json::from_value(serde_json::json!({
            "providers": [{
                "base_url": "https://host/apps/anthropic/v1/messages",
                "api_key": "sk-keep",
                "tiers": [
                    { "tier": "sonnet", "upstream_model": "old-residue" },
                    { "tier": "haiku", "upstream_model": "small" }
                ]
            }]
        }))
        .expect("未知档位不该让整份配置解析失败");
        let p = &settings.providers[0];
        // 其余字段原样保住——这正是修复前会被一起清零的东西。
        assert_eq!(p.base_url, "https://host/apps/anthropic/v1/messages");
        assert_eq!(p.api_key, "sk-keep");
        // "sonnet" 落到 default 档
        assert_eq!(p.tiers[0].tier, TierKind::Default);
        assert_eq!(p.tiers[0].upstream_model, "old-residue");
        assert_eq!(p.tiers[1].tier, TierKind::Haiku);
    }

    #[test]
    fn missing_tier_field_defaults_to_default_tier() {
        let settings: RelaySettings = serde_json::from_value(serde_json::json!({
            "providers": [{
                "base_url": "https://host/apps/anthropic/v1/messages",
                "api_key": "sk-keep",
                "tiers": [{ "upstream_model": "m" }]
            }]
        }))
        .expect("缺 tier 字段不该失败");
        assert_eq!(settings.providers[0].tiers[0].tier, TierKind::Default);
        assert_eq!(settings.providers[0].tiers[0].upstream_model, "m");
    }

    #[test]
    fn missing_base_url_becomes_empty_not_reset() {
        // 缺 base_url 时其余字段必须保住；空地址由 `validate` 报「缺上游地址」，
        // 走的是说人话的路径，而不是整份配置静默变默认。
        let settings: RelaySettings = serde_json::from_value(serde_json::json!({
            "providers": [{
                "api_key": "sk-keep",
                "tiers": [{ "tier": "default", "upstream_model": "m" }]
            }]
        }))
        .expect("缺 base_url 不该失败");
        let p = &settings.providers[0];
        assert_eq!(p.base_url, "");
        assert_eq!(p.api_key, "sk-keep");
        assert_eq!(p.validate(), Err(MissingField::BaseUrl));
    }

    #[test]
    fn missing_override_rule_fields_default_empty() {
        let settings: RelaySettings = serde_json::from_value(serde_json::json!({
            "providers": [],
            "overrides": [{ "enabled": true }]
        }))
        .expect("缺 override 字段不该失败");
        assert_eq!(settings.overrides.len(), 1);
        assert_eq!(settings.overrides[0].client_model, "");
        assert!(settings.overrides[0].enabled);
    }
}
