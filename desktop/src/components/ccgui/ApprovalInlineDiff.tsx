import { Fragment, useMemo } from "react";
import { compactDiff, computeLineDiff, pairDiffRows } from "../../lib/ccDiff";
import type { ApprovalFileChange } from "../../lib/ccApprovalAudit";
import { DiffGapRow, UnifiedRow } from "./DiffRows";

/**
 * 审批点行内嵌的 mini diff（优化轨道 A 场景二）。
 *
 * 三种数据形态如实画，不画假 diff（定案 5）：
 *   a. Edit / MultiEdit —— 入参带 old/new，画真 diff；
 *   b. Write 新建 —— 只有 content，全 `+` 行 + 「新建文件」说明；
 *   c. 桥 write_files —— 只有 content、没有改动前的样子，照样全 `+` 行，
 *      但必须说清「旧内容没经过我们」，不能让人以为文件本来就是这个样子。
 *
 * 🔴 浮层内**恒单栏**（定案外补）：440px 里井排每栏只剩 ~200px，
 *    等宽 12px 十来字符就折行，比看单栏还费劲。
 */

/** 最多摊开的行数：面板是「看一眼改动」，不是审阅全文。 */
const MAX_ROWS = 30;
/** 进 diff 的原文上限（16k 与 `TOOL_TEXT_LIMIT` 同口径，按行截断）。 */
const MAX_SOURCE_CHARS = 16_000;

function clampSource(text: string): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  const cut = text.slice(0, MAX_SOURCE_CHARS);
  const nl = cut.lastIndexOf("\n");
  return nl > 0 ? cut.slice(0, nl) : cut;
}

function sourceOf(f: ApprovalFileChange): { oldText: string; newText: string } | null {
  if (f.patches && f.patches.some((p) => p.oldString !== "" || p.newString !== "")) {
    return {
      oldText: f.patches.map((p) => p.oldString).join("\n⋯\n"),
      newText: f.patches.map((p) => p.newString).join("\n⋯\n"),
    };
  }
  if (typeof f.writtenContent === "string" && f.writtenContent !== "") {
    return { oldText: "", newText: f.writtenContent };
  }
  return null;
}

/** 有没有内容可看 —— 决定行首要不要画展开钮。只看结构，不拼字符串。 */
export function hasInlineDiff(f: ApprovalFileChange): boolean {
  if (f.patches && f.patches.length > 0) {
    return f.patches.some((p) => p.oldString !== "" || p.newString !== "");
  }
  return typeof f.writtenContent === "string" && f.writtenContent !== "";
}

/** 展开前后的说明：告诉用户「你会看到什么、缺了什么」。有 `reason` 时不再重复。 */
export function inlineNote(f: ApprovalFileChange): string {
  if (f.patches && f.patches.length > 1) {
    return `共 ${f.patches.length} 处修改，diff 按执行顺序拼接（⋯ 行是分隔）。`;
  }
  if (typeof f.writtenContent !== "string" || f.writtenContent === "") return "";
  // 已经有「为什么撤不了」的说明时，不再重复一遍「为什么看不到旧内容」。
  if (f.reason) return "";
  return f.created
    ? "新建文件：改动前不存在，展开看到的是写入的全部内容。"
    : "只有写入后的内容，没有改动前的样子 —— 这个文件在我们手上没有改动前的副本。";
}

export function ApprovalInlineDiff({ file }: { file: ApprovalFileChange }) {
  const view = useMemo(() => {
    const src = sourceOf(file);
    if (!src) return null;
    const diff = computeLineDiff(clampSource(src.oldText), clampSource(src.newText));
    const all = compactDiff(diff, 2);
    const clipped = all.length > MAX_ROWS;
    return { hunks: pairDiffRows(clipped ? all.slice(0, MAX_ROWS) : all), clipped };
  }, [file]);

  if (!view) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/30 font-mono leading-[18px]">
      {view.hunks.map((h, i) => {
        if (h.kind === "gap") return <DiffGapRow key={i} count={h.count} />;
        if (h.kind === "ctx") return <UnifiedRow key={i} line={h.line} dims="compact" />;
        return (
          <Fragment key={i}>
            {h.pairs.map(
              (p, k) =>
                p.old && (
                  <UnifiedRow key={`o${k}`} line={p.old} segs={p.words?.oldSegs} dims="compact" />
                ),
            )}
            {h.pairs.map(
              (p, k) =>
                p.new && (
                  <UnifiedRow key={`n${k}`} line={p.new} segs={p.words?.newSegs} dims="compact" />
                ),
            )}
          </Fragment>
        );
      })}
      {view.clipped && (
        <p className="border-t border-border/50 bg-muted/40 px-3 py-[2px] text-[11px] text-muted-foreground">
          改动段过大，仅显示前 {MAX_ROWS} 行
        </p>
      )}
    </div>
  );
}
