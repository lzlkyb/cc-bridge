import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import type { RelaySnapshot } from "../../lib/types";
import type { useRelayDraft } from "../../hooks/useRelayDraft";

/**
 * ④ 远端填这个名字（4 列）。
 *
 * **只出现一个可复制的名字**。不做「档位 / 上游模型 / 映射名」三列表：`default` 行的
 * 上游模型和左边「模型」格是同一个值，列出来等于让人填两遍（§4.9.2）。
 *
 * 名字由档位决定、与上游真名无关（`config.rs` 的 `TierKind::alias()` 是唯一真源）。
 * 所以这一页**没有任何输入能改它**——改成上游真名会让「换供应商不用动远端」这个
 * 承诺当场失效。
 */
export function RelayAliasCard({
  snapshot,
  form,
}: {
  snapshot?: RelaySnapshot;
  form: ReturnType<typeof useRelayDraft>;
}) {
  const { toast } = useToast();
  const { draft, setField, save, dirty } = form;
  const alias = snapshot?.tiers.find((t) => t.tier === "default")?.alias ?? "claude-sonnet-5-5";
  const ready = (draft.model ?? "").trim() !== "";

  const copy = () => {
    if (!ready) {
      toast("先把上游模型填上，映射名才有意义", "warning");
      return;
    }
    void copyText(
      alias,
      () => toast(`已复制 ${alias}`, "success"),
      () => toast("复制失败，请手动选中复制", "error"),
    );
  };

  return (
    <div className="bento-card">
      <div className="bento-eyebrow relay-card-head">
        <Icon name="key" size={12} />
        <span className="grow">远端填这个名字</span>
        {snapshot && !snapshot.running && <span className="relay-tail">待生效</span>}
      </div>

      <div className="relay-alias-box">
        <code className="relay-alias-name">{alias}</code>
        <button
          type="button"
          className="relay-mini-btn"
          aria-label="复制映射名"
          disabled={!ready}
          onClick={copy}
        >
          <Icon name="copy" size={12} />
        </button>
      </div>

      <details className="relay-more">
        <summary>
          <Icon name="chevronDown" size={11} />
          按任务分档
          <span className="hint">可选 · 不配就全部走这一个</span>
        </summary>
        <div className="relay-more-body">
          <div className="relay-field">
            <label htmlFor="relay-tier-haiku">
              haiku<span className="relay-hint">小任务</span>
            </label>
            <input
              id="relay-tier-haiku"
              className="tinp mono"
              value={draft.haiku}
              spellCheck={false}
              autoComplete="off"
              placeholder="留空 = 走 default"
              onChange={(e) => setField({ haiku: e.target.value })}
              onBlur={() => {
                if (dirty) void save();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
          <div className="relay-field">
            <label htmlFor="relay-tier-opus">
              opus<span className="relay-hint">重活</span>
            </label>
            <input
              id="relay-tier-opus"
              className="tinp mono"
              value={draft.opus}
              spellCheck={false}
              autoComplete="off"
              placeholder="留空 = 走 default"
              onChange={(e) => setField({ opus: e.target.value })}
              onBlur={() => {
                if (dirty) void save();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
          <p className="relay-hint-block">
            配了哪档就用哪档，没配的落 <code>default</code>。命中分布看右边那张卡。
          </p>
        </div>
      </details>

      <div className="relay-foot">
        <Icon name="info" size={11} />
        <span>
          只在远端文件里出现这个名字，上游真名 <code>{snapshot?.tiers.find((t) => t.tier === "default")?.upstreamModel || "…"}</code> 不写出去。
          改上游模型不用动远端。
        </span>
      </div>
    </div>
  );
}
