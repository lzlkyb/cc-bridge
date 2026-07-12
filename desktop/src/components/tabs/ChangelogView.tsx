import { useState, type CSSProperties } from "react";
import { Icon } from "../ui/icon";
import { CHANGELOG, CATEGORY_LABELS, type ChangeCategory } from "../../lib/about";

/** category → 徽章类名（与 index.css 的 cl-badge-* 对应） */
const CATEGORY_CLASS: Record<ChangeCategory, string> = {
  feat: "cl-badge-feat",
  improve: "cl-badge-improve",
  fix: "cl-badge-fix",
  sec: "cl-badge-sec",
};

const STYLE_CL_VERSIONBar: CSSProperties = { background: "hsl(var(--accent))" };
const STYLE_CL_CAPSULE: CSSProperties = { background: "var(--color-primary)" };
const STYLE_CL_CAPSULE_MUTED: CSSProperties = { background: "var(--color-muted)" };
const STYLE_CL_ITEM_PAD: CSSProperties = { paddingLeft: 28 };
const STYLE_CL_DATE: CSSProperties = { minWidth: 40 };

/**
 * 更新历史展示（从 AboutGroup 抽出，供「更新」Tab 与关于页共用，单一渲染源）。
 * 最新版本完整展开，其余折叠；若版本含 highlights 则在最新版本顶部渲染渐变亮点条。
 */
export function ChangelogView() {
  const [showMoreHistory, setShowMoreHistory] = useState(false);

  if (CHANGELOG.length === 0) return null;

  return (
    <div className="px-[22px] py-3.5">
      {/* 最新版本 — 完全展开 + 亮点条 */}
      <div className="cl-version-block mb-1.5">
        <div
          className="cl-version-bar flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors"
          style={STYLE_CL_VERSIONBar}
        >
          <span
            className="cl-version-capsule shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold text-white"
            style={STYLE_CL_CAPSULE}
          >
            v{CHANGELOG[0].version}
          </span>
          <span className="cl-date shrink-0 text-[10px] text-muted-foreground" style={STYLE_CL_DATE}>
            {CHANGELOG[0].date}
          </span>
          <span className="flex-1" />
          <span
            className="cl-latest-tag shrink-0 rounded px-1.5 text-[8px] font-bold tracking-wider text-white"
            style={STYLE_CL_CAPSULE}
          >
            最新
          </span>
        </div>

        {/* 本期亮点（C：头条亮点置顶） */}
        {CHANGELOG[0].highlights && CHANGELOG[0].highlights.length > 0 && (
          <div className="cl-highlight-bar mt-1.5 flex items-start gap-2 rounded-lg px-3 py-2">
            <Icon name="sparkles" size={14} className="mt-0.5 shrink-0 text-white" aria-hidden="true" />
            <ul className="flex-1 space-y-0.5">
              {CHANGELOG[0].highlights.map((h, i) => (
                <li key={i} className="text-[11px] font-medium leading-snug text-white">
                  {h}
                </li>
              ))}
            </ul>
          </div>
        )}

        {CHANGELOG[0].items.map((item, j) => (
          <div
            key={j}
            className="cl-item flex items-baseline gap-2 rounded-md px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-muted"
            style={STYLE_CL_ITEM_PAD}
          >
            <span
              className={`cl-badge shrink-0 rounded px-1.5 text-[9px] font-extrabold tracking-wider whitespace-nowrap ${CATEGORY_CLASS[item.category]}`}
            >
              {CATEGORY_LABELS[item.category]}
            </span>
            {item.text}
          </div>
        ))}
      </div>

      {/* 折叠的历史版本 */}
      {showMoreHistory &&
        CHANGELOG.slice(1).map((entry) => (
          <div key={entry.version} className="cl-version-block mb-1.5">
            <div className="cl-version-bar flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
              <span
                className="cl-version-capsule shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold text-muted-foreground"
                style={STYLE_CL_CAPSULE_MUTED}
              >
                v{entry.version}
              </span>
              <span className="cl-date shrink-0 text-[10px] text-muted-foreground" style={STYLE_CL_DATE}>
                {entry.date}
              </span>
              <span className="flex-1" />
            </div>
            {entry.highlights && entry.highlights.length > 0 && (
              <div className="cl-highlight-bar mt-1.5 flex items-start gap-2 rounded-lg px-3 py-2">
                <Icon name="sparkles" size={14} className="mt-0.5 shrink-0 text-white" aria-hidden="true" />
                <ul className="flex-1 space-y-0.5">
                  {entry.highlights.map((h, i) => (
                    <li key={i} className="text-[11px] font-medium leading-snug text-white">
                      {h}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {entry.items.map((item, j) => (
              <div
                key={j}
                className="cl-item flex items-baseline gap-2 rounded-md px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-muted"
                style={STYLE_CL_ITEM_PAD}
              >
                <span
                  className={`cl-badge shrink-0 rounded px-1.5 text-[9px] font-extrabold tracking-wider whitespace-nowrap ${CATEGORY_CLASS[item.category]}`}
                >
                  {CATEGORY_LABELS[item.category]}
                </span>
                {item.text}
              </div>
            ))}
          </div>
        ))}

      {/* 折叠按钮 */}
      {CHANGELOG.length > 1 && (
        <button
          type="button"
          onClick={() => setShowMoreHistory(!showMoreHistory)}
          className="changelog-toggle mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-transparent px-2 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground"
        >
          <Icon
            name="chevronDown"
            size={12}
            className={`transition-transform duration-200 ${showMoreHistory ? "rotate-180" : ""}`}
          />
          <span>{showMoreHistory ? "收起历史版本" : `查看更多版本 (${CHANGELOG.length - 1})`}</span>
        </button>
      )}
    </div>
  );
}
