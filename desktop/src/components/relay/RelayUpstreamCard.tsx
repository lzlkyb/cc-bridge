import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { SavedHint } from "../ui/SavedHint";
import type { RelaySnapshot } from "../../lib/types";
import type { useRelayDraft } from "../../hooks/useRelayDraft";
import { formatMs } from "../../lib/relayFormat";

/**
 * ③ 上游供应商（4 列）。
 *
 * 三格必填就在这里：地址 / 密钥 / 模型。**页面上没有「保存」按钮**，
 * 提交时机是失焦与控件变更（见 `useRelayDraft` 顶部注释）——这是接触点预算的
 * 直接后果，不是偷懒。
 *
 * 密钥只给掩码：完整值从后端就不下发（`ProviderView.api_key_masked`）。所以这里
 * **没有「眼睛」按钮**——设计稿上那只是示意，我们手上没有可以揭示的值。
 * 「更换」换成输入框，填完即存；不提供清空入口（清空一枚正在用的密钥没有任何
 * 正常场景，只会在远端留一堆 401）。
 */
export function RelayUpstreamCard({
  snapshot,
  form,
}: {
  snapshot?: RelaySnapshot;
  form: ReturnType<typeof useRelayDraft>;
}) {
  const { draft, setField, save, dirty, saving, error, savedAt, probe, probing, probeResult } = form;
  const [replacingKey, setReplacingKey] = useState(false);
  const configured = snapshot?.provider?.configured ?? false;
  const running = snapshot?.running ?? false;

  // 「已保存」只亮 1.6 秒。常驻会更糟：那两个字一旦住下来，就再也分不清
  // 「这次改动存进去了」和「上次存的那次」——而这一页恰恰没有保存按钮。
  const [flashSaved, setFlashSaved] = useState(false);
  useEffect(() => {
    if (savedAt == null) return;
    setFlashSaved(true);
    const timer = setTimeout(() => setFlashSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const commit = () => {
    if (dirty) void save();
  };

  const tail = !running
    ? "待生效"
    : probeResult
      ? probeResult.ok
        ? `已连通 · ${formatMs(probeResult.firstByteMs)}`
        : `上游 ${probeResult.status}`
      : configured
        ? "已填写"
        : "待填写";

  return (
    <div className="bento-card">
      <div className="bento-eyebrow relay-card-head">
        <Icon name="server" size={12} />
        <span className="grow">上游供应商</span>
        {flashSaved && <SavedHint>已保存</SavedHint>}
        <span className="relay-tail" data-tone={probeResult && !probeResult.ok ? "bad" : undefined}>
          {tail}
        </span>
      </div>

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
          <label htmlFor={replacingKey ? "relay-api-key" : undefined}>密钥</label>
          {replacingKey ? (
            <input
              id="relay-api-key"
              className="tinp mono"
              value={draft.apiKey}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              placeholder="粘贴新密钥，失焦即保存"
              onChange={(e) => setField({ apiKey: e.target.value })}
              onBlur={() => {
                commit();
                setReplacingKey(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setReplacingKey(false);
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
          <label htmlFor="relay-model">模型</label>
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
          <div className="relay-adv-row">
            <span>鉴权方式</span>
            <div className="relay-chips">
              {(["x-api-key", "bearer"] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  className="relay-chip"
                  aria-pressed={draft.authStyle === style}
                  onClick={() => {
                    // 单选按钮式的选择必须立刻落盘：没有失焦可等。
                    // 新值随 save 一起传：此刻 draft 还是旧值（setField 尚未落地）。
                    setField({ authStyle: style });
                    void save({ authStyle: style });
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
                onChange={(e) => setField({ maxTokens: e.target.value.replace(/[^\d]/g, "") })}
                onBlur={commit}
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
                className={`sw ${draft.fold ? "on" : ""} relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors`}
                onClick={() => {
                  setField({ fold: !draft.fold });
                  void save({ fold: !draft.fold });
                }}
              >
                <span className="sw-thumb inline-block h-5 w-5 rounded-full bg-white shadow" />
              </button>
              <span className="relay-chip-note">
                只碰含 <code>tool_*</code> 块的请求，其余原样转发
              </span>
            </div>
          </div>
          <div className="relay-adv-row">
            <span />
            <div className="relay-chips">
              <button
                type="button"
                className="relay-mini-btn"
                disabled={probing || saving}
                onClick={() => void probe()}
              >
                <Icon name={probing ? "spinner" : "activity"} size={12} className={probing ? "animate-spin" : ""} />
                测连通
              </button>
              <span className="relay-chip-note">
                用当前表单值打一发 <code>max_tokens: 8</code> 的请求，失败会自动换另一种鉴权头重试
              </span>
            </div>
          </div>
          {probeResult && !probeResult.ok && (
            <div className="relay-probe-fail" role="alert">
              <b>上游返回 {probeResult.status}</b>
              <pre>{probeResult.errorHead ?? "没有响应体"}</pre>
            </div>
          )}
          {probeResult?.switchedAuth && (
            <div className="relay-probe-ok">
              这个上游只认 <code>{probeResult.switchedAuth}</code>，建议把上面的鉴权方式改过去。
            </div>
          )}
        </div>
      </details>

      {error && <div className="relay-inline-error" role="alert">{error}</div>}
      {saving && <div className="relay-inline-hint">保存中…</div>}
    </div>
  );
}
