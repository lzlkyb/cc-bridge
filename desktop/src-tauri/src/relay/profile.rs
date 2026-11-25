//! 厂商画像：把「某家上游有什么差异」从代码分支变成**数据**。
//!
//! 由来（2026-11-25）：`\0` 那次的修法是在 `Provider` 上加一个布尔、在 `sanitize`
//! 里加一段 `if`。每遇到一家新上游就要重复一遍这套动作——改结构体、改清洗流程、
//! 改前端类型、改界面、补测试，然后发一个版。差异的载体选错了，修一次的成本就
//! 永远降不下来。
//!
//! 这里换成表：一个厂商一条 [`Profile`]，字段是它的端点前缀、协议方言、鉴权形态、
//! 以及一组「怪癖」（[`Quirks`]）。加一家 = 加一行常量，逻辑零改动。
//!
//! 三条口径：
//!
//! - **预设只提供默认值，不是一堵墙。** `base_url` 永远可编辑，`quirks` 可被
//!   `Provider` 上的显式字段覆盖（见 `Provider::quirks`）。
//! - **不猜厂商行为。** 表里只写有依据的结构事实（端点路径、协议、鉴权头）。
//!   行为类的判断（`count_tokens` 支不支持、thinking 能不能关）留给 S3 的探测，
//!   猜错一次就要用户替我们踩坑。
//! - **模型名永远以探测为准。** `models` 只是探测失败时的候选提示，不是白名单。

use serde::Serialize;

/// 上游协议方言。决定「请求怎么编码、响应怎么翻回来」。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    /// Anthropic Messages，可原样透传。
    #[default]
    Anthropic,
    /// OpenAI Chat Completions，必须转换（见 `relay::openai`）。
    OpenAi,
}

impl Dialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Dialect::Anthropic => "anthropic",
            Dialect::OpenAi => "openai",
        }
    }
}

/// `count_tokens` 这一路怎么处理。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CountTokens {
    /// 上游实现了 `/v1/messages/count_tokens`，透传。
    #[default]
    Native,
    /// 上游没有这个端点，本地按字符数估算并标注「估算值」。
    Estimate,
}

/// 历史消息里的 `thinking` 块怎么处理。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Thinking {
    /// 原样透传（Anthropic 方言，或上游自己认这个字段）。
    #[default]
    Passthrough,
    /// 丢弃。跨厂商切换时，别家的 thinking 签名会被上游拒，只能剥掉。
    Strip,
}

/// `anthropic-beta` / `anthropic-version` 这类头怎么处理。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BetaHeaders {
    /// 原样透传（Anthropic 兼容端点）。值一个字符都不能动，否则 beta 特性静默失效。
    #[default]
    Passthrough,
    /// 丢弃（OpenAI 方言，或严格网关见到未知头就拒）。
    Strip,
}

/// 一家上游的「怪癖」集合。全部是数据，没有分支。
#[derive(Clone, Copy, Debug)]
pub struct Quirks {
    /// 把工具 schema 里的 `\0` 归一化成 `\x00`。
    ///
    /// 默认开：`\0` 是 ECMAScript 的扩展写法，Anthropic 与 RE2 都认，但很多兼容
    /// 实现的校验器不认，且**整条请求** 400（`is not a "regex"`）。换成 `\x00`
    /// 语义完全等价，对认得 `\0` 的上游也无害。
    pub normalize_null_escape: bool,
    /// 预设的 `max_tokens` 上限。`None` = 预设不管，由用户配置决定。
    pub clamp_max_tokens: Option<u32>,
    pub count_tokens: CountTokens,
    pub thinking: Thinking,
    pub beta_headers: BetaHeaders,
}

impl Quirks {
    /// 常量形态。预设表在 `static` 里，不能用 `Default::default()`——
    /// 那不是 const fn（E0015）。
    pub const DEFAULT: Quirks = Quirks {
        normalize_null_escape: true,
        clamp_max_tokens: None,
        count_tokens: CountTokens::Native,
        thinking: Thinking::Passthrough,
        beta_headers: BetaHeaders::Passthrough,
    };
}

impl Default for Quirks {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// 一条厂商画像。
///
/// `hosts` 是**后缀**匹配（`deepseek.com` 能匹配 `api.deepseek.com`，但不能匹配
/// `evil-deepseek.com`——见 `host_matches`）。
#[derive(Clone, Copy, Debug)]
pub struct Profile {
    pub id: &'static str,
    pub label: &'static str,
    pub hosts: &'static [&'static str],
    /// 选中该厂商时预填的完整主机名。空 = 不预填（自定义）。
    ///
    /// 与 `hosts` 分开：`hosts` 是**匹配用**的后缀（`deepseek.com`），这里是要
    /// 真正填进输入框的地址（`api.deepseek.com`）。拿后缀拼 `https://` 会得到
    /// 一个不存在的域名。
    pub default_host: &'static str,
    pub dialect: Dialect,
    /// 用户只填到域名时补的路径段（含前导斜杠，可为空）。
    ///
    /// 国内厂商的 Anthropic 端点几乎都不是裸 `/v1/messages`：`/anthropic`、
    /// `/api/anthropic`、`/apps/anthropic` 各有各的习惯。让用户自己记住这些
    /// 是「多问一个他答不上来的问题」。
    pub endpoint_hint: &'static str,
    /// 预设鉴权头形态，前端选中厂商时预填。
    pub auth: &'static str,
    pub quirks: Quirks,
    /// 探测失败时的模型候选。**只作提示**，不是白名单。
    pub models: &'static [&'static str],
    /// 界面上一句话说明。
    pub note: &'static str,
}

/// 认不出来的上游。行为与 2026-11-25 之前完全一致：Anthropic 透传、不补路径段。
pub const CUSTOM: Profile = Profile {
    id: "custom",
    label: "自定义 / 其它",
    hosts: &[],
    default_host: "",
    dialect: Dialect::Anthropic,
    endpoint_hint: "",
    auth: "x-api-key",
    quirks: Quirks {
        normalize_null_escape: true,
        clamp_max_tokens: None,
        count_tokens: CountTokens::Native,
        thinking: Thinking::Passthrough,
        beta_headers: BetaHeaders::Passthrough,
    },
    models: &[],
    note: "Anthropic 兼容端点。填到 /anthropic 这一层，后面会自动补 /v1/messages。",
};

/// 内置画像表。顺序即界面下拉顺序：官方在前，国内按常用度，最后两个通用。
pub static PRESETS: &[Profile] = &[
    Profile {
        id: "anthropic",
        label: "Anthropic 官方",
        hosts: &["anthropic.com"],
        default_host: "api.anthropic.com",
        dialect: Dialect::Anthropic,
        endpoint_hint: "",
        auth: "x-api-key",
        quirks: Quirks::DEFAULT,
        models: &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        note: "官方端点，不需要路径段。",
    },
    Profile {
        id: "deepseek",
        label: "DeepSeek",
        hosts: &["deepseek.com"],
        default_host: "api.deepseek.com",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/anthropic",
        auth: "x-api-key",
        quirks: Quirks::DEFAULT,
        models: &["deepseek-flash", "deepseek-v4-pro"],
        note: "只认 deepseek-flash / deepseek-v4-pro 这类真名，写错会在 schema 校验前就被拒。",
    },
    Profile {
        id: "kimi",
        label: "Kimi / Moonshot",
        hosts: &["moonshot.cn", "kimi.com", "moonshot.ai"],
        default_host: "api.moonshot.cn",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/anthropic",
        auth: "x-api-key",
        quirks: Quirks::DEFAULT,
        models: &["kimi-k3", "kimi-k2.7-code"],
        note: "同一个域名并排挂着两套协议，注意别选成 OpenAI 那条。",
    },
    Profile {
        id: "glm",
        label: "智谱 GLM",
        hosts: &["bigmodel.cn", "z.ai"],
        default_host: "open.bigmodel.cn",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/api/anthropic",
        auth: "x-api-key",
        quirks: Quirks::DEFAULT,
        models: &["glm-5.3", "glm-5.3-flash"],
        note: "部分模型的思考开关不可关，属上游行为。",
    },
    Profile {
        id: "qwen",
        label: "阿里百炼 / 通义千问",
        hosts: &["aliyuncs.com"],
        default_host: "dashscope.aliyuncs.com",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/apps/anthropic",
        auth: "x-api-key",
        quirks: Quirks::DEFAULT,
        models: &["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"],
        note: "三类密钥与地址严格一一对应，混用直接 401。",
    },
    Profile {
        id: "minimax",
        label: "MiniMax",
        hosts: &["minimaxi.com", "minimax.io", "minimax.cn"],
        default_host: "api.minimaxi.com",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/anthropic",
        auth: "x-api-key",
        quirks: Quirks::DEFAULT,
        models: &["MiniMax-M3"],
        note: "",
    },
    Profile {
        id: "volcengine",
        label: "火山方舟 / 豆包",
        hosts: &["volces.com", "bytepluses.com"],
        default_host: "ark.cn-beijing.volces.com",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/api/coding",
        auth: "bearer",
        quirks: Quirks::DEFAULT,
        models: &[],
        note: "Coding Plan 走这条；按量计费是另一套路径。",
    },
    Profile {
        id: "hunyuan",
        label: "腾讯混元",
        // 只认混元自己的子域：写 `tencent.com` 会把腾讯云上任何服务都当成混元。
        hosts: &["hunyuan.cloud.tencent.com"],
        default_host: "api.hunyuan.cloud.tencent.com",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/anthropic",
        auth: "bearer",
        quirks: Quirks::DEFAULT,
        models: &[],
        note: "",
    },
    Profile {
        id: "openrouter",
        label: "OpenRouter",
        hosts: &["openrouter.ai"],
        default_host: "openrouter.ai",
        dialect: Dialect::Anthropic,
        endpoint_hint: "/api",
        auth: "bearer",
        quirks: Quirks::DEFAULT,
        models: &[],
        note: "模型名带厂商前缀，如 anthropic/claude-sonnet-5-5。",
    },
    Profile {
        id: "openai",
        label: "OpenAI 官方",
        hosts: &["openai.com", "openai.azure.com"],
        default_host: "api.openai.com",
        dialect: Dialect::OpenAi,
        endpoint_hint: "/v1",
        auth: "bearer",
        quirks: Quirks {
            // OpenAI 不认识 Anthropic 的 beta 头，带过去只是噪音。
            beta_headers: BetaHeaders::Strip,
            // 历史 thinking 块是别家的签名，必须剥掉，否则整条请求被拒。
            thinking: Thinking::Strip,
            ..Quirks::DEFAULT
        },
        models: &["gpt-5.5", "gpt-5.5-mini"],
        note: "需要协议转换。Azure 的部署路径与 api-key 头另有一套，本预设不覆盖。",
    },
];

/// 按 id 取画像。空 id 返回 `None`（交给 host 推断）。
pub fn by_id(id: &str) -> Option<&'static Profile> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    PRESETS
        .iter()
        .find(|p| p.id == id)
        .or_else(|| (id == CUSTOM.id).then_some(&CUSTOM))
}

/// 解析一个上游属于哪家。
///
/// 优先用用户显式选的 id（他可能知道得比 host 更准，比如自建反代域名）；
/// 没选就按 host 后缀推断；都认不出落 `CUSTOM`。
pub fn resolve(base_url: &str, profile_id: &str) -> &'static Profile {
    if let Some(p) = by_id(profile_id) {
        return p;
    }
    let host = host_of(base_url);
    if host.is_empty() {
        return &CUSTOM;
    }
    PRESETS
        .iter()
        .find(|p| p.hosts.iter().any(|suffix| host_matches(&host, suffix)))
        .unwrap_or(&CUSTOM)
}

/// 从 URL 取小写主机名（去端口、去 userinfo）。取不出来返回空串。
pub fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // userinfo 是可选的，`@` 之后才是 host:port
    let authority = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 字面量：`[::1]:4100`
        stripped.split_once(']').map(|(h, _)| h).unwrap_or(stripped)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// 后缀匹配。`api.deepseek.com` 命中 `deepseek.com`；
/// `evil-deepseek.com` **不**命中（少一个点就会把钓鱼域名当正主）。
fn host_matches(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

/// 给界面用的画像摘要。**不含 quirks**：那是内部行为，界面只需要选谁。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: &'static str,
    pub label: &'static str,
    pub dialect: &'static str,
    pub endpoint_hint: &'static str,
    /// 选中该厂商时预填的主机名（不含 scheme）。
    pub default_host: &'static str,
    pub auth: &'static str,
    pub models: &'static [&'static str],
    pub note: &'static str,
}

/// 全部可选画像（含 `custom`，排在最后）。
pub fn views() -> Vec<ProfileView> {
    PRESETS
        .iter()
        .chain(std::iter::once(&CUSTOM))
        .map(|p| ProfileView {
            id: p.id,
            label: p.label,
            dialect: p.dialect.as_str(),
            endpoint_hint: p.endpoint_hint,
            default_host: p.default_host,
            auth: p.auth,
            models: p.models,
            note: p.note,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_host_suffix() {
        assert_eq!(
            resolve("https://api.deepseek.com/anthropic", "").id,
            "deepseek"
        );
        assert_eq!(
            resolve("https://open.bigmodel.cn/api/anthropic", "").id,
            "glm"
        );
        assert_eq!(
            resolve("https://dashscope.aliyuncs.com/apps/anthropic", "").id,
            "qwen"
        );
        assert_eq!(resolve("https://api.moonshot.cn/anthropic", "").id, "kimi");
        // 带 userinfo 与端口也能认
        assert_eq!(
            resolve("https://user:pw@api.deepseek.com:443/anthropic", "").id,
            "deepseek"
        );
    }

    /// 少一个点就是另一个域名。这条挡的是「把钓鱼域名当正主」。
    #[test]
    fn host_match_requires_label_boundary() {
        assert!(!host_matches("evil-deepseek.com", "deepseek.com"));
        assert!(host_matches("deepseek.com", "deepseek.com"));
        assert!(host_matches("api.deepseek.com", "deepseek.com"));
    }

    #[test]
    fn explicit_id_wins_over_host() {
        // 自建反代的域名认不出来，但用户明确选了 DeepSeek
        let p = resolve("https://my-proxy.example.com/v1/messages", "deepseek");
        assert_eq!(p.id, "deepseek");
        assert_eq!(p.endpoint_hint, "/anthropic");
    }

    #[test]
    fn unknown_host_falls_back_to_custom() {
        let p = resolve("https://my-proxy.example.com", "");
        assert_eq!(p.id, "custom");
        assert_eq!(p.dialect, Dialect::Anthropic);
        assert_eq!(p.endpoint_hint, "");
    }

    #[test]
    fn openai_is_the_only_openai_dialect() {
        assert_eq!(resolve("", "openai").dialect, Dialect::OpenAi);
        assert_eq!(
            resolve("https://api.openai.com/v1", "").dialect,
            Dialect::OpenAi
        );
        for p in PRESETS.iter().filter(|p| p.id != "openai") {
            assert_eq!(
                p.dialect,
                Dialect::Anthropic,
                "{} 应是 Anthropic 方言",
                p.id
            );
        }
    }

    /// 表里不能有重复 id，否则下拉里会出现两个同名项、选谁不确定。
    #[test]
    fn preset_ids_are_unique() {
        let mut ids: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
        ids.push(CUSTOM.id);
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn views_include_custom_last() {
        let v = views();
        assert_eq!(v.last().unwrap().id, "custom");
        assert_eq!(v.len(), PRESETS.len() + 1);
    }

    /// `default_host` 必须能被自己的 `hosts` 认出来。
    ///
    /// 两处数据分开写（一个给输入框预填、一个给匹配），写错就会出「选中
    /// DeepSeek 填了 api.deepseek.com，保存后却被识别成 custom」这种事——
    /// 界面看着对，端点却少补一段路径。
    #[test]
    fn default_host_matches_its_own_hosts() {
        for p in PRESETS {
            let host = host_of(&format!("https://{}", p.default_host));
            assert_eq!(
                host.clone(),
                p.default_host,
                "{} 的默认主机不是纯主机名",
                p.id
            );
            assert!(
                p.hosts.iter().any(|suffix| host_matches(&host, suffix)),
                "{} 的 default_host 匹配不到自己的 hosts",
                p.id
            );
        }
    }

    /// 预填的主机 + hint 拼出来的地址，必须落在该厂商的端点上。
    #[test]
    fn default_host_and_hint_compose_a_sane_url() {
        for p in PRESETS.iter().filter(|p| !p.default_host.is_empty()) {
            let url = crate::relay::config::normalize_endpoint_with(
                &format!("https://{}", p.default_host),
                p.endpoint_hint,
                p.dialect,
            );
            let expected_suffix = match p.dialect {
                Dialect::Anthropic => "/v1/messages",
                Dialect::OpenAi => "/chat/completions",
            };
            assert!(
                url.ends_with(expected_suffix),
                "{} 拼出来是 {url}，不以 {expected_suffix} 结尾",
                p.id
            );
            // 不能出现 hint 被叠两次（`/anthropic/anthropic`）
            if !p.endpoint_hint.is_empty() {
                let doubled = format!("{}{}", p.endpoint_hint, p.endpoint_hint);
                assert!(!url.contains(&doubled), "{} 的路径段叠了两次：{url}", p.id);
            }
        }
    }
}
