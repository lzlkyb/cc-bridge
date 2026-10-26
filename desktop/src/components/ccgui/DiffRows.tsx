import type { ReactNode } from "react";
import type { DiffLine, WordSeg } from "../../lib/ccDiff";

/**
 * diff 行的三套画法：单栏行（对话流 + 审批面板共用）、井排单元格、折叠行。
 *
 * 🔴 为什么抽出来：井排与单栏要画同一份「行 + 词级片段」，审批面板的 mini diff
 *    又是单栏的缩小档。三处各写一遍 `<span>` 树，迟早出现「这边高亮了那边忘了」
 *    的错位；而高亮类名的对比度只有一处可改（`-ink` 变体的坑见 index.css）。
 *
 * 🔴 词级高亮只改**底色与字重**：不插字符、不加 padding、不动 transform
 *    —— 等宽列对齐靠的就是「同一个字符永远同一个宽度」（定案 3）。
 */

type Dims = "normal" | "compact";

/** 两档尺寸：对话流按产品原值（26px 行号 / 12px 内容），面板浮层缩一档（22px / 11.5px）。 */
const DIMS: Record<Dims, { cols: string; no: string; text: string }> = {
  normal: {
    cols: "grid-cols-[26px_26px_12px_minmax(0,1fr)]",
    no: "text-[11px]",
    text: "text-[12px]",
  },
  compact: {
    cols: "grid-cols-[22px_22px_12px_minmax(0,1fr)]",
    no: "text-[10.5px]",
    text: "text-[11.5px]",
  },
};

function toneOf(kind: DiffLine["kind"]): { bg: string; ink: string } {
  if (kind === "add") return { bg: "bg-success/10", ink: "text-success-ink" };
  if (kind === "del") return { bg: "bg-destructive/10", ink: "text-destructive-ink" };
  return { bg: "", ink: "text-muted-foreground" };
}

function signOf(kind: DiffLine["kind"]): string {
  return kind === "add" ? "+" : kind === "del" ? "−" : " ";
}

/** 行内容：有词级片段就分段画（changed 段加深底色），否则原样铺文本。 */
function LineText({
  text,
  segs,
  kind,
}: {
  text: string;
  segs?: WordSeg[];
  kind: DiffLine["kind"];
}): ReactNode {
  if (!segs || segs.length === 0) return <>{text || "\u00a0"}</>;
  const hl = kind === "add" ? "bg-success/40" : "bg-destructive/40";
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? (
          <span key={i} className={`rounded-[2px] font-bold ${hl}`}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** 单栏一行：旧行号 | 新行号 | 符号 | 内容。 */
export function UnifiedRow({
  line,
  segs,
  dims = "normal",
}: {
  line: DiffLine;
  segs?: WordSeg[];
  dims?: Dims;
}) {
  const d = DIMS[dims];
  const { bg, ink } = toneOf(line.kind);
  return (
    <div className={`grid items-start ${d.cols} ${bg}`}>
      <span
        className={`select-none border-r border-border/40 pl-2 pr-1 text-right leading-[18px] tabular-nums text-muted-foreground/50 ${d.no}`}
      >
        {line.oldNo ?? ""}
      </span>
      <span
        className={`select-none border-r border-border/40 pr-1.5 text-right leading-[18px] tabular-nums text-muted-foreground/50 ${d.no}`}
      >
        {line.newNo ?? ""}
      </span>
      <span className={`select-none pl-1 leading-[18px] ${ink}`}>{signOf(line.kind)}</span>
      <span className={`whitespace-pre-wrap break-words pr-2 leading-[18px] ${d.text} ${ink}`}>
        <LineText text={line.text} segs={segs} kind={line.kind} />
      </span>
    </div>
  );
}

/**
 * 井排单元格：行号 | 符号 | 内容。
 *
 * `line === null` 是对侧空槽 —— 画淡底而不是留白，读者才能看出
 * 「这一行在那一侧不存在」与「这一行在那一侧是空的」不是一回事。
 */
export function SideCell({
  side,
  line,
  segs,
}: {
  side: "old" | "new";
  line: DiffLine | null;
  segs?: WordSeg[];
}) {
  const edge = side === "old" ? "border-r border-border/70" : "";
  if (!line) return <div className={`min-w-0 bg-muted/35 ${edge}`} />;
  const { bg, ink } = toneOf(line.kind);
  return (
    <div className={`grid min-w-0 grid-cols-[22px_12px_minmax(0,1fr)] items-start ${bg} ${edge}`}>
      <span className="select-none pr-1 text-right text-[10.5px] leading-[18px] tabular-nums text-muted-foreground/50">
        {(side === "old" ? line.oldNo : line.newNo) ?? ""}
      </span>
      <span className={`select-none pl-[2px] leading-[18px] ${ink}`}>{signOf(line.kind)}</span>
      <span className={`whitespace-pre-wrap break-words pr-1.5 leading-[18px] ${ink}`}>
        <LineText text={line.text} segs={segs} kind={line.kind} />
      </span>
    </div>
  );
}

/** 折叠行：井排时跨两栏（`span`）。 */
export function DiffGapRow({ count, span = false }: { count: number; span?: boolean }) {
  return (
    <div
      className={`border-y border-border/50 bg-muted/40 px-3 py-[1px] text-center text-[11px] text-muted-foreground ${
        span ? "col-span-2" : ""
      }`}
    >
      ⋯ {count} 行未改动
    </div>
  );
}
