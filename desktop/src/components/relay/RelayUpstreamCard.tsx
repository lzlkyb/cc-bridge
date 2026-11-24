import { useEffect, useState, type FocusEvent } from "react";
import { Icon } from "../ui/icon";
import { SavedHint } from "../ui/SavedHint";
import type { RelaySnapshot } from "../../lib/types";
import { useRelayDraft, type RelayDraft } from "../../hooks/useRelayDraft";
import { formatMs } from "../../lib/relayFormat";

/** 与后端 `Option<u32>` 对齐的上限。
 *
 *  超限时 serde 会**整条 patch** 拒绝，前端只看到一句天书错误，且不改就永远
 *  存不进去。所以在输入侧就限长 + 失焦拦住，给一句人能看懂的话。 */
const MAX_TOKENS_U32 = 4_294_967_295;

export function RelayUpstreamCard({
  snapshot,
  onChanged,
  explicit = false,
  onApplied,
}: {
  snapshot: RelaySnapshot;
  onChanged: () => void;
  explicit?: boolean;
  onApplied?: () => void;
}) {
  const form = useRelayDraft(snapshot, onChanged);
  const { draft, setField, setError, save, dirty, saving, error, savedAt, probe, probing, probeResult } = form;
  const [replacingKey, setReplacingKey] = useState(false);
  const hasKey = snapshot.provider?.hasApiKey ?? false;
  const showKey = replacingKey || !hasKey;
  const configured = snapshot.provider?.configured ?? false;
  const ready = Boolean(draft.baseUrl.trim() && draft.model.trim() && (draft.apiKey.trim() || hasKey));

  // 「已保存」只亮 1.6 秒。常驻会更糟：那两个字一旦住下来，就再也分不清
  // 「这次改动存进去了」和「上次存的那次」——而这一页恰恰没有保存按钮。
  const [flashSaved, setFlashSaved] = useState(false);
  useEffect(() => {
    if (savedAt == null) return;
    setFlashSaved(true);
    const timer = setTimeout(() => setFlashSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const apply = (override?: Partial<RelayDraft>) => {
    if ((!dirty && !override) || saving || !ready) return;
    if (draft.maxTokens !== "" && Number(draft.maxTokens) > MAX_TOKENS_U32) {
      setError("max_tokens 不能超过 4294967295（后端整数上限）。");
      return;
    }
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      setError("请输入有效的 HTTP 或 HTTPS 上游地址。");
      return;
    }
    void save(override).then((result) => { if (result?.ok && result.configured) onApplied?.(); });
  };
  const commit = (event: FocusEvent<HTMLElement>) => {
    if (explicit || event.relatedTarget?.matches("[data-relay-autosave]")) return;
    apply();
  };

  const tail = probeResult
      ? probeResult.ok
        ? `上次测试通过 · ${formatMs(probeResult.firstByteMs)}`
        : `上游 ${probeResult.status}`
      : configured
        ? "已配置"
        : "待填写";

  return (
    <fieldset className="relay-upstream-editor" disabled={saving} data-explicit={explicit || undefined}>
      <div className="bento-eyebrow relay-card-head">
        <Icon name="server" size={12} />
        <span className="grow">{explicit ? "上游供应商" : "配置上游供应商"}</span>
        {flashSaved && <SavedHint>已保存</SavedHint>}
        <span className="relay-tail" data-tone={probeResult && !probeResult.ok ? "bad" : undefined}>
          {tail}
        </span>
      </div>
      <p className="relay-work-muted">{explicit ? "调整地址、密钥或模型后，点击「应用配置」。" : "从上游控制台取得以下三项。填齐后，离开输入框即自动保存。"}</p>

      <div className="relay-fields">
        <div className="relay-field">
          <label htmlFor="relay-base-url">上游地址</label>
          <input
            id="relay-base-url"
            className="tinp mono"
            value={draft.baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://your-upstream.example.com"
            onChange={(e) => setField({ baseUrl: e.target.value })}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>

        <div className="relay-field">
          <label htmlFor={showKey ? "relay-api-key" : undefined}>API 密钥</label>
          {showKey ? (
            <input
              id="relay-api-key"
              className="tinp mono"
              type="password"
              value={draft.apiKey}
              spellCheck={false}
              autoComplete="off"
              autoFocus={replacingKey}
              placeholder="粘贴 API 密钥"
              onChange={(e) => setField({ apiKey: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onKeyDownCapture={(e) => {
                if (e.key === "Escape" && replacingKey && !e.nativeEvent.isComposing) {
                  e.stopPropagation();
                  // 「取消」必须把草稿里的密钥一起丢掉：只关输入框的话，
                  // 之后应用其他字段时会把这枚被取消的密钥一起保存。
                  setField({ apiKey: "" });
                  setReplacingKey(false);
                }
              }}
            />
          ) : (
            <div className="relay-field row">
              <code className="relay-mask">{snapshot?.provider?.hasApiKey ? snapshot.provider.apiKeyMasked : "未填"}</code>
              <button type="button" className="relay-mini-btn" onClick={() => setReplacingKey(true)}>
                更换
              </button>
            </div>
          )}
        </div>

        <div className="relay-field">
          <label htmlFor="relay-model">默认模型</label>
          <input
            id="relay-model"
            className="tinp mono"
            value={draft.model}
            spellCheck={false}
            autoComplete="off"
            placeholder="上游控制台里的模型名"
            onChange={(e) => setField({ model: e.target.value })}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>
      </div>

      <details className="relay-more">
        <summary>
          <Icon name="chevronDown" size={11} />
          高级设置
          <span className="hint">都已有默认值，不用动</span>
        </summary>
        <div className="relay-more-body">
          <div className="relay-fields relay-extra-models">
            {(["haiku", "opus"] as const).map((tier) => <div className="relay-field" key={tier}>
              <label htmlFor={`relay-model-${tier}`}>{tier === "haiku" ? "Haiku" : "Opus"} 模型</label>
              <input id={`relay-model-${tier}`} className="tinp mono" value={draft[tier]} placeholder="留空时使用默认档"
                onChange={(event) => setField({ [tier]: event.target.value })} onBlur={commit} />
            </div>)}
          </div>
          <div className="relay-adv-row">
            <span>鉴权方式</span>
            <div className="relay-chips">
              {(["x-api-key", "bearer"] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  className="relay-chip"
                  data-relay-autosave={!explicit || undefined}
                  aria-pressed={draft.authStyle === style}
                  onBlur={commit}
                  onClick={() => {
                    if (draft.authStyle === style) return;
                    const update = { authStyle: style };
                    setField(update);
                    if (!explicit) apply(update);
                  }}
                >
                  {style === "bearer" ? "Bearer" : "x-api-key"}
                </button>
              ))}
            </div>
          </div>
          <div className="relay-adv-row">
            <span>max_tokens</span>
            <div className="relay-chips">
              <input
                className="tinp mono"
                style={{ width: 96 }}
                inputMode="numeric"
                value={draft.maxTokens}
                placeholder="不压"
                aria-label="max_tokens 上限"
                // 只留数字 + 限 10 位：u32 上限是 10 位数，更长连后端都进不去。
                onChange={(e) => setField({ maxTokens: e.target.value.replace(/[^\d]/g, "").slice(0, 10) })}
                onBlur={(event) => {
                  // 10 位仍可能超 u32（如 9999999999）。此时后端 Option<u32>
                  // 会整条拒绝、报错还是 serde 天书——拦住、说人话、不保存
                  // （存了也必失败，用户没有任何自愈路径）。
                  if (draft.maxTokens !== "" && Number(draft.maxTokens) > MAX_TOKENS_U32) {
                    setError("max_tokens 不能超过 4294967295（后端整数上限）。");
                    return;
                  }
                  commit(event);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <span className="relay-chip-note">留空 = 按上游；上游报超限时再压</span>
            </div>
          </div>
          <div className="relay-adv-row">
            <span>折叠工具定义</span>
            <div className="relay-chips">
              <button
                type="button"
                role="switch"
                aria-checked={draft.fold}
                aria-label="折叠工具定义"
                data-relay-autosave={!explicit || undefined}
                className={`sw ${draft.fold ? "on" : ""} relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors`}
                onBlur={commit}
                onClick={() => {
                  const update = { fold: !draft.fold };
                  setField(update);
                  if (!explicit) apply(update);
                }}
              >
                <span className="sw-thumb inline-block h-5 w-5 rounded-full bg-white shadow" />
              </button>
              <span className="relay-chip-note">
                只碰含 <code>tool_*</code> 块的请求，其余原样转发
              </span>
            </div>
          </div>
        </div>
      </details>
      <div className="relay-inline relay-wrap">
        <button type="button" className="relay-mini-btn" disabled={!ready || probing || saving} onClick={() => void probe()}>
          <Icon name={probing ? "spinner" : "activity"} size={13} className={probing ? "animate-spin" : ""} />{probing ? "正在测试" : "测试上游"}
        </button>
        {(explicit || error) && <button type="button" className="relay-mini-btn relay-apply-button" onClick={() => apply()} disabled={!dirty || !ready || saving}>
          {explicit ? "应用配置" : "重试保存"}
        </button>}
        {explicit && dirty && !saving && <small>有尚未应用的改动</small>}
      </div>
      {probeResult && !probeResult.ok && <div className="relay-probe-fail" role="alert"><b>上游返回 {probeResult.status}</b><pre>{probeResult.errorHead ?? "没有响应体"}</pre></div>}
      {probeResult?.switchedAuth && <div className="relay-probe-ok">测试使用 <code>{probeResult.switchedAuth}</code> 通过，可在高级设置中切换鉴权方式。</div>}
      {error && <div className="relay-inline-error" role="alert">{error}</div>}
      {saving && <div className="relay-inline-hint" role="status">正在保存…</div>}
    </fieldset>
  );
}
