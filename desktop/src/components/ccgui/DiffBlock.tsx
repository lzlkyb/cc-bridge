import { memo, useMemo } from "react";
import { compactDiff, computeLineDiff } from "../../lib/ccDiff";

/**
 * 行级 diff 视图。
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
 */
function DiffBlockImpl({
  oldText,
  newText,
  context = 2,
}: {
  oldText: string;
  newText: string;
  context?: number;
}) {
  const diff = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);
  const rows = useMemo(() => compactDiff(diff, context), [diff, context]);

  return (
    <div data-cc-data className="overflow-hidden rounded-lg border border-border/70 bg-muted/30 font-mono text-[12px] leading-[18px]">
      {rows.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <div
              key={`gap-${i}`}
              className="border-y border-border/50 bg-muted/40 px-3 py-[1px] text-center text-[11px] text-muted-foreground"
            >
              ⋯ {row.count} 行未改动
            </div>
          );
        }
        const tone =
          row.kind === "add"
            ? "bg-success/10"
            : row.kind === "del"
              ? "bg-destructive/10"
              : "";
        const ink =
          row.kind === "add"
            ? "text-success-ink"
            : row.kind === "del"
              ? "text-destructive-ink"
              : "text-muted-foreground";
        const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
        return (
          <div key={i} className={`grid grid-cols-[26px_26px_12px_minmax(0,1fr)] items-start ${tone}`}>
            <span className="select-none border-r border-border/40 pl-2 pr-1 text-right text-[11px] leading-[18px] tabular-nums text-muted-foreground/50">
              {row.oldNo ?? ""}
            </span>
            <span className="select-none border-r border-border/40 pr-1.5 text-right text-[11px] leading-[18px] tabular-nums text-muted-foreground/50">
              {row.newNo ?? ""}
            </span>
            <span className={`select-none pl-1 leading-[18px] ${ink}`}>{sign}</span>
            <span className={`whitespace-pre-wrap break-words pr-2 leading-[18px] ${row.kind === "ctx" ? "text-muted-foreground" : ink}`}>
              {row.text || "\u00a0"}
            </span>
          </div>
        );
      })}
      {/* `ccDiff` 中段过大时降级为整段替换并置 `truncated`——这里必须把降级说出口：
          那份 diff 的行号与 ± 数字都是近似值，不提示就是拿错的数字冒充对的。 */}
      {diff.truncated && (
        <p className="border-t border-border/50 bg-muted/40 px-3 py-[2px] text-[10.5px] text-muted-foreground">
          改动段过大，已降级为整段替换 —— 行号与增删统计是近似值
        </p>
      )}
    </div>
  );
}

export const DiffBlock = memo(DiffBlockImpl);
