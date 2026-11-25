/**
 * 中转页的「高级设置」折叠区。
 *
 * 从 `RelayUpstreamCard` 拆出来的：这些项都已有默认值、平时不用动，与上面
 * 「供应商 / 地址 / 密钥 / 模型」四格不是同一类东西。拆开后主表单只剩用户
 * 真正要填的东西，行数也不再顶体量门禁。
 */

import type { FocusEvent } from "react";
import type { RelayDraft } from "../../hooks/useRelayDraft";
import { Icon } from "../ui/icon";

/** 与后端 `Option<u32>` 对齐的上限。
 *
 *  超限时 serde 会**整条 patch** 拒绝，前端只看到一句天书错误，且不改就永远
 *  存不进去。所以在输入侧就限长 + 失焦拦住，给一句人能看懂的话。 */
const MAX_TOKENS_U32 = 4_294_967_295;

export function RelayAdvancedSettings({
  draft,
  setField,
  apply,
  commit,
  explicit,
  setError,
}: {
  draft: RelayDraft;
  setField: (patch: Partial<RelayDraft>) => void;
  apply: (override?: Partial<RelayDraft>) => void;
  commit: (event: FocusEvent<HTMLElement>) => void;
  explicit: boolean;
  setError: (message: string) => void;
}) {
  return (
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
          <span>schema 正则</span>
          <div className="relay-chips">
            {(["auto", "on", "off"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="relay-chip"
                data-relay-autosave={!explicit || undefined}
                aria-pressed={draft.patterns === mode}
                onBlur={commit}
                onClick={() => {
                  if (draft.patterns === mode) return;
                  const update: Partial<RelayDraft> = { patterns: mode };
                  setField(update);
                  if (!explicit) apply(update);
                }}
              >
                {mode === "auto" ? "跟随厂商" : mode === "on" ? "开" : "关"}
              </button>
            ))}
            <span className="relay-chip-note">
              把工具 schema 里的 <code>\0</code> 换成 <code>\x00</code>，语义不变
            </span>
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
  );
}
