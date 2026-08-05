import { useState, useMemo } from "react";
import type { FileDiffResult, DiffLine } from "../../lib/types";
import { useToast } from "../ui/toast";
import { Spinner } from "../ui/Spinner";

/** 单个 diff 的加载态缓存（含预存的 +/- 计数，避免渲染时重复 filter）。 */
export type DiffState = {
  loading: boolean;
  result?: FileDiffResult;
  added?: number;
  removed?: number;
  error?: string;
};

/** 结果回来时预存一次 +/- 计数，渲染直接读取。 */
export function countDiff(r: FileDiffResult): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!r.guard) {
    for (const l of r.lines) {
      if (l.kind === "added") added++;
      else if (l.kind === "removed") removed++;
    }
  }
  return { added, removed };
}

type NumberedLine = DiffLine & { beforeNo: number | null; afterNo: number | null };

/** 按 kind 序列推算前/后文件的行号（added 行没有 beforeNo，removed 行没有 afterNo）。
 * 后端 `get_file_diff`/`diff_backups` 返回的是整文件逐行（含未改动的 context 行），不带行号，
 * 所以前端从第 1 行开始自己推就能准确。 */
function numberLines(lines: DiffLine[]): NumberedLine[] {
  let before = 1;
  let after = 1;
  return lines.map((l) => {
    const beforeNo = l.kind === "added" ? null : before;
    const afterNo = l.kind === "removed" ? null : after;
    if (l.kind !== "added") before++;
    if (l.kind !== "removed") after++;
    return { ...l, beforeNo, afterNo };
  });
}

/** 变更行前后各保留多少行上下文才常驻可见，其余连续未变更行折叠。 */
const CONTEXT_RADIUS = 2;

type Segment =
  | { kind: "visible"; lines: NumberedLine[] }
  | { kind: "gap"; lines: NumberedLine[]; key: string };

/** 把编号后的行切成“常驻可见段”与“可折叠段”：变更行前后各留 CONTEXT_RADIUS 行，
 * 其余连续未变更行折叠成一段。默认“仅看变更”模式下只渲染 visible 段 + 折叠条，
 * 完整上下文模式/单独展开某段时才渲染 gap 段里的实际内容。 */
function buildSegments(lines: NumberedLine[]): Segment[] {
  const n = lines.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (lines[i].kind !== "context") {
      for (let j = Math.max(0, i - CONTEXT_RADIUS); j <= Math.min(n - 1, i + CONTEXT_RADIUS); j++) {
        keep[j] = true;
      }
    }
  }
  const segments: Segment[] = [];
  let i = 0;
  while (i < n) {
    if (keep[i]) {
      const start = i;
      while (i < n && keep[i]) i++;
      segments.push({ kind: "visible", lines: lines.slice(start, i) });
    } else {
      const start = i;
      while (i < n && !keep[i]) i++;
      segments.push({ kind: "gap", lines: lines.slice(start, i), key: `gap-${start}` });
    }
  }
  return segments;
}

function diffLineClass(kind: DiffLine["kind"]): string {
  if (kind === "added") return "bg-success/10 text-success";
  if (kind === "removed") return "bg-destructive/10 text-destructive";
  return "bg-muted/40 text-foreground";
}

function DiffLineRow({ l }: { l: NumberedLine }) {
  const sign = l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " ";
  return (
    <div className={`flex gap-2 ${diffLineClass(l.kind)} whitespace-pre-wrap break-words px-2 py-px`}>
      <span className="w-7 shrink-0 select-none text-right text-muted-foreground/60">{l.beforeNo ?? ""}</span>
      <span className="w-7 shrink-0 select-none text-right text-muted-foreground/60">{l.afterNo ?? ""}</span>
      <span>{sign}{l.text}</span>
    </div>
  );
}

/** 红绿 diff 渲染块（懒加载、护栏、错误统一处理）。
 * 默认“仅看变更”：未改动的大段上下文折叠，可单独展开某一段，也可用顶部开关一次性展开全部上下文。 */
export function DiffView({ state, title }: { state?: DiffState; title: string }) {
  const [fullContext, setFullContext] = useState(false);
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const numbered = useMemo(
    () => (state?.result && !state.result.guard ? numberLines(state.result.lines) : []),
    [state?.result],
  );
  const segments = useMemo(() => buildSegments(numbered), [numbered]);

  const handleCopy = async () => {
    if (!state?.result || state.result.guard) return;
    const text = state.result.lines
      .map((l) => `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制 diff 到剪贴板", "success");
    } catch (e) {
      toast(`复制失败：${String(e)}`, "error");
    }
  };

  return (
    <div className="mt-2">
      <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{title}</div>
      <div className="overflow-hidden rounded-lg border border-border font-mono text-[11.5px]">
        {state?.loading && (
          <div className="flex items-center gap-2 bg-muted/30 p-2 text-muted-foreground">
            <Spinner size={14} /> 加载中…
          </div>
        )}
        {state?.error && (
          <div className="break-all bg-destructive/10 p-2 text-destructive">加载失败：{state.error}</div>
        )}
        {state?.result && state.result.guard && (
          <div className="bg-muted p-2 text-muted-foreground">
            {state.result.guard}
            <span className="ml-1 font-sans">（{state.result.beforeLines} 行 → {state.result.afterLines} 行）</span>
          </div>
        )}
        {state?.result && !state.result.guard && (
          <>
            <div className="flex items-center gap-2 divider-x bg-muted/20 px-2 py-1.5 font-sans">
              {(state.added || state.removed) ? (
                <span className="flex gap-1.5 text-[11px]">
                  {state.added ? <span className="text-success">+{state.added}</span> : null}
                  {state.removed ? <span className="text-destructive">−{state.removed}</span> : null}
                </span>
              ) : null}
              <div className="ml-auto flex overflow-hidden rounded-md border border-border">
                <button
                  type="button"
                  onClick={() => setFullContext(false)}
                  className={`px-2 py-0.5 text-[10.5px] transition-colors ${!fullContext ? "bg-primary text-white" : "bg-card text-muted-foreground hover:bg-muted"}`}
                >
                  仅看变更
                </button>
                <button
                  type="button"
                  onClick={() => setFullContext(true)}
                  className={`px-2 py-0.5 text-[10.5px] transition-colors ${fullContext ? "bg-primary text-white" : "bg-card text-muted-foreground hover:bg-muted"}`}
                >
                  完整上下文
                </button>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="rounded-md border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted"
              >
                复制
              </button>
            </div>
            <div className="max-h-80 overflow-auto">
              {segments.map((seg, si) =>
                seg.kind === "visible" || fullContext || expandedGaps.has(seg.key) ? (
                  seg.lines.map((l, li) => <DiffLineRow key={`${si}-${li}`} l={l} />)
                ) : (
                  <button
                    key={seg.key}
                    type="button"
                    onClick={() => setExpandedGaps((prev) => new Set(prev).add(seg.key))}
                    className="flex w-full items-center justify-center bg-transparent px-2 py-1 font-sans text-[11px] text-muted-foreground transition-colors hover:bg-muted/30"
                  >
                    ⋯ 还有 {seg.lines.length} 行未变更，点击展开 ⋯
                  </button>
                ),
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
