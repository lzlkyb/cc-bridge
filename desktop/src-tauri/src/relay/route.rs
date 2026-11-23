//! 客户端模型名 → 档位 → 上游模型。
//!
//! 解析顺序（§4.6.1，**顺序本身是设计的一部分**）：
//!
//! ```text
//! 1. client_model 精确等于某个已配置档的 alias   → 该档，fellBack=false
//! 2. 否则 override 精确命中 client_model         → 该条
//! 3. 否则含 haiku / opus 关键词，且该档已配置     → 该档，fellBack=false
//!    含关键词但该档没配                          → default，fellBack=true
//! 4. 否则（含 sonnet）                          → default，fellBack=false
//! 5. default 也没配                             → 拒绝，可诊断错误
//! ```
//!
//! 三个容易写错的地方：
//!
//! - **第 1 条必须排最前**。默认映射名 `claude-sonnet-5-5` 里天然含 `sonnet`，
//!   若关键词匹配抢在前面，请求自己的 alias 会被判成「某档未配置已回落」，
//!   日志里从此永远有一条假回落，"配错 alias 一眼看出来"这个诊断就废了。
//! - **`sonnet` 不在任何档的关键词里**。它已经被 `default` 吸收，所以带 sonnet
//!   的原生名直接落 default 且**不算回落**——那是设计如此，不是配置出错。
//! - **`fellBack` 只表示"命中了具体档位但那一档没配"**，不表示"落到了 default"。
//!   两者混同会让绝大多数正常请求都带上回落标记。

use super::config::{RelaySettings, TierKind};

/// 一次路由的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteDecision {
    /// 请求命中的档位。**即使该档未配置、实际用了 default 的模型，这里也记命中的那一档**
    /// （`haiku`），配合 `fell_back` 才能读出「haiku 这档没配、用的 default」。
    pub tier: TierKind,
    /// 实际发给上游的模型名。
    pub upstream_model: String,
    /// 客户端请求的原始模型名（日志要同时记两个，否则对不上号）。
    pub client_model: String,
    /// 是否发生了档位回落。
    pub fell_back: bool,
    /// 命中方式，供日志与排查。
    pub via: RouteVia,
}

/// 怎么命中的。UI 不必显示，日志与测试要用。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteVia {
    /// 精确等于映射名
    Alias,
    /// 精确覆盖规则
    Override,
    /// 含档位关键词
    Keyword,
    /// 兜底
    Fallback,
}

impl RouteVia {
    pub fn as_str(self) -> &'static str {
        match self {
            RouteVia::Alias => "alias",
            RouteVia::Override => "override",
            RouteVia::Keyword => "keyword",
            RouteVia::Fallback => "fallback",
        }
    }
}

/// 路由失败的原因。每一种都要能单独给出一条人能看懂的说明——
/// 转发层不负责拼错误文案，文案只写在这一处（§4.4.2 第 4 条）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteError {
    /// 一个 provider 都没配（或全被禁用）。
    NoProvider,
    /// 三格没配齐。
    NotConfigured { field: super::config::MissingField },
    /// default 档这一行不存在或为空。
    NoDefaultTier,
    /// 客户端没给 model 字段。
    MissingClientModel,
}

impl RouteError {
    /// 给用户看的错误说明。**只在这里生成**。
    pub fn message(&self) -> String {
        match self {
            RouteError::NoProvider => {
                "中转还没有配置上游：请在「中转」页填写上游地址、密钥和模型。".into()
            }
            RouteError::NotConfigured { field } => format!(
                "中转配置不完整：{}还没填。请到「中转」页补齐后重试。",
                field.label()
            ),
            RouteError::NoDefaultTier => {
                "中转没有配置默认模型：default 档为空，所有请求都会失败。请在「中转」页填写模型名。"
                    .into()
            }
            RouteError::MissingClientModel => {
                "请求体缺少 model 字段。中转需要它来判断该用哪一档上游模型。".into()
            }
        }
    }
}

/// 把客户端模型名解析成上游模型。
pub fn resolve(settings: &RelaySettings, client_model: &str) -> Result<RouteDecision, RouteError> {
    let client_model = client_model.trim();
    if client_model.is_empty() {
        return Err(RouteError::MissingClientModel);
    }
    let provider = settings.active().ok_or(RouteError::NoProvider)?;

    // ── 1. 映射名精确命中 ──────────────────────────────────────────────
    // 只认「已配置」的那一档：alias 精确但该档被删空时继续往下走，最终会由关键词
    // 那条判成回落——这比「精确命中一个空档」更贴近用户看到的现实（他删了映射
    // 却还没改远端文件）。
    for kind in TierKind::ALL {
        if client_model == kind.alias() {
            if let Some(upstream) = provider.upstream_for(kind) {
                return Ok(RouteDecision {
                    tier: kind,
                    upstream_model: upstream.to_string(),
                    client_model: client_model.to_string(),
                    fell_back: false,
                    via: RouteVia::Alias,
                });
            }
        }
    }

    // ── 2. 覆盖规则 ────────────────────────────────────────────────────
    if let Some(rule) = settings
        .overrides
        .iter()
        .find(|r| r.enabled && r.client_model.trim() == client_model)
    {
        if !rule.upstream_model.trim().is_empty() {
            return Ok(RouteDecision {
                tier: TierKind::Default,
                upstream_model: rule.upstream_model.trim().to_string(),
                client_model: client_model.to_string(),
                fell_back: false,
                via: RouteVia::Override,
            });
        }
    }

    // ── 3. 关键词（只认 haiku / opus；sonnet 不在其中）────────────────
    let default_model = provider.upstream_for(TierKind::Default);
    for kind in [TierKind::Haiku, TierKind::Opus] {
        let Some(keyword) = kind.keyword() else {
            continue;
        };
        if !client_model.to_ascii_lowercase().contains(keyword) {
            continue;
        }
        if let Some(upstream) = provider.upstream_for(kind) {
            return Ok(RouteDecision {
                tier: kind,
                upstream_model: upstream.to_string(),
                client_model: client_model.to_string(),
                fell_back: false,
                via: RouteVia::Keyword,
            });
        }
        // 命中了这一档但没配 → 回落 default，并**明确标记**回落
        let upstream = default_model.ok_or(RouteError::NoDefaultTier)?;
        return Ok(RouteDecision {
            tier: kind,
            upstream_model: upstream.to_string(),
            client_model: client_model.to_string(),
            fell_back: true,
            via: RouteVia::Keyword,
        });
    }

    // ── 4. 兜底 default（这就是「只配一个也能跑」的全部机制）──────────
    let upstream = default_model.ok_or(RouteError::NoDefaultTier)?;
    Ok(RouteDecision {
        tier: TierKind::Default,
        upstream_model: upstream.to_string(),
        client_model: client_model.to_string(),
        fell_back: false,
        via: RouteVia::Fallback,
    })
}

/// 某一档在「今天」被命中了多少次——给 UI 的档位分布卡用。
///
/// 入参是日志里读出来的 `(tier, fell_back)` 序列，纯函数便于测试。
pub fn tally(entries: impl IntoIterator<Item = (TierKind, bool)>) -> Vec<(TierKind, u32, u32)> {
    let mut out: Vec<(TierKind, u32, u32)> =
        TierKind::ALL.into_iter().map(|k| (k, 0u32, 0u32)).collect();
    for (tier, fell_back) in entries {
        if let Some(row) = out.iter_mut().find(|(k, _, _)| *k == tier) {
            row.1 += 1;
            if fell_back {
                row.2 += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::config::{Provider, Tier};

    fn settings_with(tiers: Vec<(TierKind, &str)>) -> RelaySettings {
        RelaySettings {
            providers: vec![Provider {
                base_url: "https://host/apps/anthropic/v1/messages".into(),
                api_key: "sk-test".into(),
                tiers: tiers
                    .into_iter()
                    .map(|(tier, model)| Tier {
                        tier,
                        upstream_model: model.into(),
                    })
                    .collect(),
                ..Provider::default()
            }],
            overrides: vec![],
        }
    }

    /// 只配一档时，三种原生模型名全部落 default —— 默认形态的主用例。
    ///
    /// `fellBack` 的差别是重点：haiku / opus 是「命中具体档位但没配」，要标回落；
    /// sonnet 已被 default 吸收，落 default 是设计如此，**不能标回落**。
    #[test]
    fn only_default_tier_serves_everything() {
        let s = settings_with(vec![(TierKind::Default, "qwen4-max-preview")]);

        let haiku = resolve(&s, "claude-3-5-haiku-20241022").unwrap();
        assert_eq!(haiku.upstream_model, "qwen4-max-preview");
        assert!(haiku.fell_back, "haiku 未配应标回落");

        let sonnet = resolve(&s, "claude-sonnet-4-5-20250929").unwrap();
        assert_eq!(sonnet.upstream_model, "qwen4-max-preview");
        assert!(!sonnet.fell_back, "sonnet 走 default 不是回落");
        assert_eq!(sonnet.via, RouteVia::Fallback);

        let opus = resolve(&s, "claude-opus-4-1-20250805").unwrap();
        assert_eq!(opus.upstream_model, "qwen4-max-preview");
        assert!(opus.fell_back, "opus 未配应标回落");
    }

    /// haiku 请求在 haiku 未配时必须标回落——这是「配错 alias 一眼看出来」的基础。
    #[test]
    fn unconfigured_tier_marks_fell_back() {
        let s = settings_with(vec![(TierKind::Default, "qwen4-max-preview")]);
        let d = resolve(&s, "claude-3-5-haiku-20241022").unwrap();
        assert_eq!(d.tier, TierKind::Haiku);
        assert!(d.fell_back, "haiku 未配必须记回落");
        assert_eq!(d.upstream_model, "qwen4-max-preview");
    }

    /// sonnet 原生名落 default **且不算回落**：sonnet 已被 default 吸收。
    #[test]
    fn sonnet_native_name_is_not_a_fall_back() {
        let s = settings_with(vec![(TierKind::Default, "qwen4-max-preview")]);
        let d = resolve(&s, "claude-sonnet-4-5-20250929").unwrap();
        assert_eq!(d.tier, TierKind::Default);
        assert!(!d.fell_back, "sonnet 走 default 是设计如此，不是回落");
    }

    /// 配了 haiku 就要按档走，证明分档确实生效、不是永远落 default。
    #[test]
    fn configured_tier_wins_over_default() {
        let s = settings_with(vec![
            (TierKind::Default, "big-model"),
            (TierKind::Haiku, "small-model"),
        ]);
        let d = resolve(&s, "claude-3-5-haiku-20241022").unwrap();
        assert_eq!(d.tier, TierKind::Haiku);
        assert_eq!(d.upstream_model, "small-model");
        assert!(!d.fell_back);
    }

    /// 默认名 `claude-sonnet-5-5` 必须精确命中 default 且 fellBack=false ——
    /// 这是「精确匹配优先于关键词」那条硬性验收。
    #[test]
    fn default_alias_hits_exactly_without_fake_fall_back() {
        let s = settings_with(vec![(TierKind::Default, "qwen4-max-preview")]);
        let d = resolve(&s, "claude-sonnet-5-5").unwrap();
        assert_eq!(d.tier, TierKind::Default);
        assert!(!d.fell_back, "精确命中不该带回落标记");
        assert_eq!(d.via, RouteVia::Alias);
    }

    /// haiku 档被删空时，精确 alias 不再命中，转而由关键词判成回落。
    /// 这条覆盖「用户删了映射但远端文件还没改」的现实状态。
    #[test]
    fn blank_tier_falls_back_even_on_exact_alias() {
        let s = settings_with(vec![
            (TierKind::Default, "big-model"),
            (TierKind::Haiku, "   "),
        ]);
        let d = resolve(&s, "claude-haiku-5-5").unwrap();
        assert_eq!(d.tier, TierKind::Haiku);
        assert!(d.fell_back);
        assert_eq!(d.upstream_model, "big-model");
    }

    #[test]
    fn override_beats_keyword_but_not_alias() {
        let mut s = settings_with(vec![(TierKind::Default, "big-model")]);
        s.overrides.push(crate::relay::config::OverrideRule {
            client_model: "claude-haiku-legacy".into(),
            upstream_model: "pinned-model".into(),
            enabled: true,
        });
        // override 精确命中
        assert_eq!(
            resolve(&s, "claude-haiku-legacy").unwrap().upstream_model,
            "pinned-model"
        );
        // 但 alias 优先于 override（用户可能把 override 写成了同名，仍以档位为准）
        s.overrides[0].client_model = "claude-sonnet-5-5".into();
        let d = resolve(&s, "claude-sonnet-5-5").unwrap();
        assert_eq!(d.via, RouteVia::Alias);
    }

    #[test]
    fn missing_default_tier_is_diagnosable() {
        let s = settings_with(vec![(TierKind::Haiku, "small")]);
        // haiku 配了 → 该档请求能跑
        assert_eq!(
            resolve(&s, "claude-3-5-haiku-x").unwrap().upstream_model,
            "small"
        );
        // 其它任何名字都没有兜底 → 明确报「default 没配」
        let err = resolve(&s, "some-model").unwrap_err();
        assert_eq!(err, RouteError::NoDefaultTier);
        assert!(err.message().contains("默认模型"));
    }

    #[test]
    fn empty_model_is_rejected() {
        let s = settings_with(vec![(TierKind::Default, "m")]);
        assert_eq!(resolve(&s, "  "), Err(RouteError::MissingClientModel));
    }

    #[test]
    fn no_provider_is_diagnosable() {
        let s = RelaySettings::default();
        assert_eq!(resolve(&s, "x"), Err(RouteError::NoProvider));
        assert!(RouteError::NoProvider.message().contains("上游地址"));
    }

    #[test]
    fn tally_counts_hits_and_falls_back() {
        let rows = tally([
            (TierKind::Default, false),
            (TierKind::Default, false),
            (TierKind::Haiku, true),
        ]);
        let default = rows
            .iter()
            .find(|(k, _, _)| *k == TierKind::Default)
            .unwrap();
        let haiku = rows.iter().find(|(k, _, _)| *k == TierKind::Haiku).unwrap();
        assert_eq!((default.1, default.2), (2, 0));
        assert_eq!((haiku.1, haiku.2), (1, 1));
    }
}
