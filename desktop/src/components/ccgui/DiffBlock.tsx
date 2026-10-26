import { Fragment, memo, useMemo } from "react";
import { compactDiff, computeLineDiff, pairDiffRows } from "../../lib/ccDiff";
import { DIFF_VIEW_LABEL, setDiffView, useDiffView, type DiffView } from "../../lib/diffView";
import { DiffGapRow, SideCell, UnifiedRow } from "./DiffRows";

/**
 * 行级 diff 视图（优化轨道 A：井排 / 单栏可切 + 词级高亮）。
 *
 * 行高固定 18px、字号 12px：等宽字在这个尺寸下 `+`/`−` 与文字基线才对得上，
 * 再大就与 13px 正文打架、再小中文注释会糊。
 *
 * 🔴 字号只允许落在 11/12/13 三档里（11 元信息 / 12 等宽与参数 / 13 正文），
 *    这里取 12 —— 碎档字号是对话页「显得乱」的主因。
 *
 * 🔴 行号必须**两列**（旧/新各一），不能像 desktop-cc-gui 那样用一列混显：
 *    插入场景下旧行号与新行号会错位，单列会让读者把「新增行」和「未改动行」
 *    看成同一行号（实测本页示例就是 1,1,2,2,3 这种幻觉）。
 *
 * 🔴 井排/单栏是**全局偏好**（`lib/diffView`，localStorage），不是每条 diff 各自
 *    记忆 —— 读 diff 的姿势是一个人稳定的习惯，不是一个文件一个脾气。
 *
 * 🔴 新建文件（`oldText === ""`）不画井排：那样左栏永远是空的，一半宽度白给。
 *    顶栏的分段控件在这种卡片上也不出现 —— 没有可对比的另一侧，开关是假的。
 */
function DiffBlockImpl({
  oldText,
  newText,
  context = 2,
  edits = 1,
}: {
  oldText: string;
  newText: string;
  context?: number;
  /** 这条 diff 由几处修改拼成（MultiEdit）；>1 时顶栏说明拼接口径。 */
  edits?: number;
}) {
  const diff = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);
  const rows = useMemo(() => compactDiff(diff, context), [diff, context]);
  const hunks = useMemo(() => pairDiffRows(rows), [rows]);
  const view = useDiffView();

  /** 有旧内容才有「两侧」可言。 */
  const canSideBySide = oldText !== "";
  const sideBySide = canSideBySide && view === "s";
  const showBar = canSideBySide || edits > 1;

  return (
    <div
      data-cc-data
      className="overflow-hidden rounded-lg border border-border/70 bg-muted/30 font-mono text-[12px] leading-[18px]"
    >
      {showBar && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-card/60 py-1 pl-2.5 pr-2 text-[11px] text-muted-foreground">
          {edits > 1 && (
            <span className="min-w-0 truncate" title="diff 按执行顺序拼接（⋯ 行是分隔）">
              共 {edits} 处修改
            </span>
          )}
          {canSideBySide && (
            <span className="ml-auto inline-flex shrink-0 overflow-hidden rounded-[7px] border border-border bg-card">
              {(["u", "s"] as DiffView[]).map((v, i) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDiffView(v)}
                  aria-pressed={view === v}
                  className={`px-[9px] py-[2px] text-[11px] leading-[18px] transition-colors ${
                    i > 0 ? "border-l border-border" : ""
                  } ${
                    view === v
                      ? "bg-accent font-semibold text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {DIFF_VIEW_LABEL[v]}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      {sideBySide ? (
        <div className="grid grid-cols-2">
          <div className="col-span-2 grid grid-cols-2 border-b border-border/70 bg-card/60 text-[11px] text-muted-foreground">
            <span className="border-r border-border/70 px-2 py-[1px]">改动前</span>
            <span className="px-2 py-[1px]">改动后</span>
          </div>
          {hunks.map((h, i) => {
            if (h.kind === "gap") return <DiffGapRow key={i} count={h.count} span />;
            if (h.kind === "ctx") {
              return (
                <Fragment key={i}>
                  <SideCell side="old" line={h.line} />
                  <SideCell side="new" line={h.line} />
                </Fragment>
              );
            }
            return (
              <Fragment key={i}>
                {h.pairs.map((p, k) => (
                  <Fragment key={k}>
                    <SideCell side="old" line={p.old} segs={p.words?.oldSegs} />
                    <SideCell side="new" line={p.new} segs={p.words?.newSegs} />
                  </Fragment>
                ))}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <>
          {hunks.map((h, i) => {
            if (h.kind === "gap") return <DiffGapRow key={i} count={h.count} />;
            if (h.kind === "ctx") return <UnifiedRow key={i} line={h.line} />;
            // 先删后增：单栏保持原有的「一整个 del 块 + 一整个 add 块」顺序，
            // 不因为配对而交错 —— 配对只决定高亮，不重排阅读顺序。
            return (
              <Fragment key={i}>
                {h.pairs.map(
                  (p, k) => p.old && <UnifiedRow key={`o${k}`} line={p.old} segs={p.words?.oldSegs} />,
                )}
                {h.pairs.map(
                  (p, k) => p.new && <UnifiedRow key={`n${k}`} line={p.new} segs={p.words?.newSegs} />,
                )}
              </Fragment>
            );
          })}
        </>
      )}

      {/* `ccDiff` 中段过大时降级为整段替换并置 `truncated`——这里必须把降级说出口：
          那份 diff 的行号与 ± 数字都是近似值，不提示就是拿错的数字冒充对的。
          定案 6：两种视图通用，挂在视图区外层。 */}
      {diff.truncated && (
        <p className="border-t border-border/50 bg-muted/40 px-3 py-[2px] text-[11px] text-muted-foreground">
          改动段过大，已降级为整段替换 —— 行号与增删统计是近似值
        </p>
      )}
    </div>
  );
}

export const DiffBlock = memo(DiffBlockImpl);
