import { useState, useMemo, useEffect } from "react";
import { invoke } from "../../lib/tauri";
import type {
  BackupListResult,
  BackupFileInfo,
  FileDiffResult,
  DiffLine,
  StatusResponse,
} from "../../lib/types";
import { formatRelativeTime, formatBytes } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { Spinner } from "../ui/Spinner";
import { Modal } from "../ui/Modal";

/** 单个 diff 的加载态缓存（含预存的 +/- 计数，避免渲染时重复 filter）。 */
type DiffState = {
  loading: boolean;
  result?: FileDiffResult;
  added?: number;
  removed?: number;
  error?: string;
};

/** 结果回来时预存一次 +/- 计数，渲染直接读取。 */
function countDiff(r: FileDiffResult): { added: number; removed: number } {
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
    <div className={`flex gap-2 ${diffLineClass(l.kind)} whitespace-pre px-2 py-px`}>
      <span className="w-7 shrink-0 select-none text-right text-muted-foreground/60">{l.beforeNo ?? ""}</span>
      <span className="w-7 shrink-0 select-none text-right text-muted-foreground/60">{l.afterNo ?? ""}</span>
      <span>{sign}{l.text}</span>
    </div>
  );
}

/** 红绿 diff 渲染块（懒加载、护栏、错误统一处理）。
 * 默认“仅看变更”：未改动的大段上下文折叠，可单独展开某一段，也可用顶部开关一次性展开全部上下文。 */
function DiffView({ state, title }: { state?: DiffState; title: string }) {
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

/** 查看类操作（看改了什么/与上一版比）用蓝色，与不可逆的“还原”做视觉分级，避免手滑点错。 */
const VIEW_BTN_CLASS =
  "rounded-md border border-primary/35 bg-card px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:border-input disabled:text-foreground";
const DANGER_BTN_CLASS =
  "rounded-md border border-destructive/40 bg-card px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:border-input disabled:text-foreground";

/**
 * 版本历史弹框（居中大弹框，沿用 UpdateNotesDialog 视觉）。
 * 解决"备份列表看不懂、多文件难定位、不知道改了什么"三件事：
 *  - 检索/导航：搜索文件名、最近修改优先排序、可点击文件索引栏跳转、按文件/按时间视图切换、展开全部。
 *  - 版本时间线：每个原文件一条时间线（当前文件终点 + 各 .bak 快照节点）。
 *  - 看改了什么：get_file_diff（.bak vs 当前文件，懒加载，白名单关闭或无索引记录（历史备份）时禁用）。
 *  - 与上一版比：diff_backups（两个 .bak 互比，直接回答"上一个和下一个差在哪"）。
 *  - 还原：复用 RestoreBackupDialog（弹框外二级确认）。
 * 安全不削弱：白名单关闭或该备份无索引记录（历史备份）时"看改了什么"因无 target 禁用、"与上一版比"纯 .bak 互比仍可用、还原仍禁用。
 */
export function VersionHistoryModal({
  open,
  status,
  result,
  loading,
  onClose,
  onRestore,
}: {
  open: boolean;
  status?: StatusResponse;
  result: BackupListResult | null;
  loading: boolean;
  onClose: () => void;
  onRestore: (entry: BackupFileInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [view, setView] = useState<"file" | "time">("file");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeRail, setActiveRail] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  const [curState, setCurState] = useState<Record<string, DiffState>>({});
  const [adjState, setAdjState] = useState<Record<string, DiffState>>({});

  // 打开时默认折叠所有分组（性能：避免一次性渲染全部时间线节点）
  useEffect(() => {
    if (!open) {
      setQuery("");
      setExpanded(new Set());
      setOpenSet(new Set());
      setCurState({});
      setAdjState({});
    }
  }, [open]);

  const groups = useMemo(() => {
    const all = result?.groups ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((g) => g.originalFile.toLowerCase().includes(q)) : all;
    const sorted = [...filtered];
    if (sort === "name") {
      sorted.sort((a, b) => a.originalFile.localeCompare(b.originalFile));
    } else {
      sorted.sort((a, b) => b.entries[0].createdAt.localeCompare(a.entries[0].createdAt));
    }
    return sorted;
  }, [result, query, sort]);

  const allExpanded = groups.length > 0 && expanded.size === groups.length;
  const toggleAll = () => {
    setExpanded(allExpanded ? new Set() : new Set(groups.map((g) => g.originalFile)));
  };
  const jumpTo = (idx: number, name: string) => {
    setExpanded((prev) => new Set(prev).add(name));
    setActiveRail(name);
    const el = document.getElementById(`vh-grp-${idx}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const loadCur = async (entry: BackupFileInfo) => {
    const key = entry.backupPath;
    setCurState((s) => (s[key] ? s : { ...s, [key]: { loading: true } }));
    try {
      const r = await invoke<FileDiffResult>("get_file_diff", {
        backup_path: entry.backupPath,
        target_path: entry.targets[0] ?? "",
      });
      const c = countDiff(r);
      setCurState((s) => ({ ...s, [key]: { loading: false, result: r, ...c } }));
    } catch (e) {
      setCurState((s) => ({ ...s, [key]: { loading: false, error: String(e) } }));
    }
  };
  const loadAdj = async (entry: BackupFileInfo, prev: BackupFileInfo) => {
    const key = entry.backupPath;
    setAdjState((s) => (s[key] ? s : { ...s, [key]: { loading: true } }));
    try {
      const r = await invoke<FileDiffResult>("diff_backups", {
        from_path: prev.backupPath,
        to_path: entry.backupPath,
      });
      const c = countDiff(r);
      setAdjState((s) => ({ ...s, [key]: { loading: false, result: r, ...c } }));
    } catch (e) {
      setAdjState((s) => ({ ...s, [key]: { loading: false, error: String(e) } }));
    }
  };

  const toggleCur = (entry: BackupFileInfo) => {
    const openKey = `cur:${entry.backupPath}`;
    setOpenSet((prev) => {
      const on = !prev.has(openKey);
      if (on && !curState[entry.backupPath]) loadCur(entry);
      const n = new Set(prev);
      on ? n.add(openKey) : n.delete(openKey);
      return n;
    });
  };
  const toggleAdj = (entry: BackupFileInfo, prev: BackupFileInfo) => {
    const openKey = `adj:${entry.backupPath}`;
    setOpenSet((prevSet) => {
      const on = !prevSet.has(openKey);
      if (on && !adjState[entry.backupPath]) loadAdj(entry, prev);
      const n = new Set(prevSet);
      on ? n.add(openKey) : n.delete(openKey);
      return n;
    });
  };

  const isEmpty = !loading && (!result || !result.exists || result.groups.length === 0);

  return (
    <Modal open={open} onClose={onClose} zIndex={1000} className="modal-box flex max-h-[85vh] w-[1000px] max-w-[92vw] flex-col overflow-hidden rounded-2xl modal-surface">
        {/* 标题栏 */}
        <div className="flex items-center gap-2.5 divider-x px-4 py-3">
          <span className="title-chip">
            <Icon name="history" size={15} />
          </span>
          <div className="text-[15px] font-bold text-foreground">版本历史</div>
          <span className="text-xs text-muted-foreground">
            {result?.count ?? 0} 个备份 · {formatBytes(result?.totalBytes ?? 0)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground interactive hover:bg-accent hover:text-foreground"
            aria-label="关闭"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="space-y-2.5" aria-label="加载备份清单">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="vh-skel overflow-hidden rounded-xl border border-border"
                >
                  <div className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-2.5">
                    <div className="h-3.5 w-1/3 rounded bg-muted-foreground/20" />
                    <div className="h-3 w-16 rounded bg-muted-foreground/15" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {isEmpty && (
            <div className="py-8 text-center text-xs leading-relaxed text-muted-foreground">
              暂无备份文件。
              <br />
              当你改写或删除受保护文件时，程序会自动生成{" "}
              <code className="mx-0.5 font-mono">.bak</code> 备份。
            </div>
          )}
          {!loading && !isEmpty && (
            <>
              {/* 工具栏 */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3 py-1.5">
                  <Icon name="search" size={14} className="shrink-0 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索文件名…"
                    className="w-full bg-transparent text-xs outline-none"
                  />
                </div>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as "recent" | "name")}
                  className="h-8 rounded-lg border border-input bg-card px-2 text-xs outline-none"
                >
                  <option value="recent">最近修改优先</option>
                  <option value="name">按文件名</option>
                </select>
                <div className="flex overflow-hidden rounded-lg border border-input">
                  <button
                    type="button"
                    onClick={() => setView("file")}
                    className={`px-3 py-1.5 text-xs transition-colors ${
                      view === "file"
                        ? "bg-primary text-white"
                        : "bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    按文件
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("time")}
                    className={`px-3 py-1.5 text-xs transition-colors ${
                      view === "time"
                        ? "bg-primary text-white"
                        : "bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    按时间
                  </button>
                </div>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="rounded-lg border border-input bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                >
                  {allExpanded ? "收起全部" : "展开全部"}
                </button>
              </div>

              {view === "file" ? (
                <div className="grid grid-cols-[200px_1fr] gap-3">
                  {/* 文件索引栏 */}
                  <div
                    className="overflow-y-auto max-h-[62vh] rounded-xl border border-border bg-muted/40 p-2"
                  >
                    <div className="px-1 pb-1 text-[11px] font-semibold text-muted-foreground">
                      文件索引（点击跳转）
                    </div>
                    {groups.map((g) => (
                      <div
                        key={g.originalFile}
                        onClick={() => jumpTo(groups.indexOf(g), g.originalFile)}
                        className={`mb-1 cursor-pointer rounded-lg px-2 py-1.5 transition-colors ${
                          activeRail === g.originalFile
                            ? "bg-card shadow-ring-inset-primary"
                            : "hover:bg-card"
                        }`}
                      >
                        <div className="truncate font-mono text-[12px] font-semibold">
                          {g.originalFile}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatRelativeTime(g.entries[0].createdAt)} · {g.count} 份
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 时间线 */}
                  <div>
                    {groups.map((g, gi) => (
                      <div
                        key={g.originalFile}
                        id={`vh-grp-${gi}`}
                        className="mb-2.5 overflow-hidden rounded-xl border border-border"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => {
                              const n = new Set(prev);
                              n.has(g.originalFile) ? n.delete(g.originalFile) : n.add(g.originalFile);
                              return n;
                            })
                          }
                          className="flex w-full items-center justify-between gap-2 bg-muted/50 px-3 py-2 text-left text-xs font-semibold"
                        >
                          <span className="truncate font-mono">{g.originalFile}</span>
                          <span className="shrink-0 font-normal text-muted-foreground">
                            {g.count} 份 · {formatBytes(g.totalBytes)}
                          </span>
                        </button>
                        {expanded.has(g.originalFile) && (
                          <div className="py-2 pl-3 pr-2">
                            {/* 当前文件（终点节点） */}
                            <div className="relative border-l-2 border-border py-2 pl-4">
                              <span className="absolute -left-[7px] top-3 h-3 w-3 rounded-full border-2 bg-primary border-primary" />
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[13px] font-semibold text-foreground">
                                  {g.originalFile}
                                </span>
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                  当前文件
                                </span>
                              </div>
                            </div>
                            {/* 各 .bak 快照 */}
                            {g.entries.map((e, ei) => {
                              const prev = ei < g.entries.length - 1 ? g.entries[ei + 1] : null;
                              const canDiff = e.targets.length > 0;
                              const cs = curState[e.backupPath];
                              const st = cs?.result;
                              return (
                                <div
                                  key={e.backupPath}
                                  className="relative border-l-2 border-border py-2 pl-4"
                                >
                                  <span className="absolute -left-[7px] top-3 h-3 w-3 rounded-full border-2 bg-card border-primary" />
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span
                                      className="font-mono text-[12px] font-semibold"
                                      title={e.backupPath}
                                    >
                                      {e.backupPath.split(/[\\/]/).pop()}
                                    </span>
                                    <span
                                      className="text-xs text-muted-foreground"
                                      title={e.createdAt}
                                    >
                                      {formatRelativeTime(e.createdAt)}
                                    </span>
                                    <span className="font-mono text-xs text-muted-foreground">
                                      {formatBytes(e.sizeBytes)}
                                    </span>
                                    {st && !st.guard && (
                                      <span className="flex items-center gap-1 text-[11px]">
                                        {cs?.added ? (
                                          <span className="rounded bg-success/15 px-1.5 py-0.5 text-success">
                                            +{cs.added}
                                          </span>
                                        ) : null}
                                        {cs?.removed ? (
                                          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">
                                            −{cs.removed}
                                          </span>
                                        ) : null}
                                      </span>
                                    )}
                                    <div className="ml-auto flex flex-wrap gap-1.5">
                                      <button
                                        type="button"
                                        disabled={!canDiff}
                                        title={canDiff ? "对比 .bak 与当前文件" : "无法定位当前文件（白名单关闭 / 路径已不在白名单内 / 无索引记录的历史备份）"}
                                        onClick={() => toggleCur(e)}
                                        className={VIEW_BTN_CLASS}
                                      >
                                        看改了什么
                                      </button>
                                      {prev && (
                                        <button
                                          type="button"
                                          onClick={() => toggleAdj(e, prev)}
                                          className={VIEW_BTN_CLASS}
                                        >
                                          与上一版比
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        disabled={!canDiff}
                                        title={canDiff ? "还原到该备份" : "禁用还原（白名单关闭 / 路径已不在白名单内 / 无索引记录的历史备份）"}
                                        onClick={() => onRestore(e)}
                                        className={DANGER_BTN_CLASS}
                                      >
                                        还原
                                      </button>
                                    </div>
                                    {!canDiff && (
                                      <p className="flex basis-full items-start gap-1 text-[10.5px] leading-snug text-warning">
                                        <Icon name="alertTriangle" size={11} className="mt-0.5 shrink-0" />
                                        无法定位当前文件（白名单关闭 / 路径已不在白名单内 / 无索引记录的历史备份），“看改了什么”与“还原”暂不可用
                                      </p>
                                    )}
                                  </div>
                                  {openSet.has(`cur:${e.backupPath}`) && (
                                    <DiffView state={curState[e.backupPath]} title="相对当前文件的变更" />
                                  )}
                                  {prev && openSet.has(`adj:${e.backupPath}`) && (
                                    <DiffView
                                      state={adjState[e.backupPath]}
                                      title={`与上一版（${prev.createdAt}）的差异`}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                /* 按时间视图 */
                <div className="overflow-hidden rounded-xl border border-border">
                  {groups
                    .flatMap((g) => g.entries.map((e, ei) => ({ g, e, ei })))
                    .sort((a, b) => b.e.createdAt.localeCompare(a.e.createdAt))
                    .map(({ g, e, ei }) => {
                      const canDiff = e.targets.length > 0;
                      const prev = ei < g.entries.length - 1 ? g.entries[ei + 1] : null;
                      return (
                        <div key={e.backupPath} className="divider-x px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono text-muted-foreground">{formatRelativeTime(e.createdAt)}</span>
                            <span className="font-mono font-semibold">{g.originalFile}</span>
                            <span className="ml-auto font-mono text-muted-foreground">
                              {formatBytes(e.sizeBytes)}
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-start gap-1.5">
                            <button
                              type="button"
                              disabled={!canDiff}
                              title={canDiff ? "对比 .bak 与当前文件" : "无法定位当前文件（白名单关闭 / 路径已不在白名单内 / 无索引记录的历史备份）"}
                              onClick={() => toggleCur(e)}
                              className={VIEW_BTN_CLASS}
                            >
                              看改了什么
                            </button>
                            {prev && (
                              <button
                                type="button"
                                onClick={() => toggleAdj(e, prev)}
                                className={VIEW_BTN_CLASS}
                              >
                                与上一版比
                              </button>
                            )}
                            {!canDiff && (
                              <p className="flex basis-full items-start gap-1 text-[10.5px] leading-snug text-warning">
                                <Icon name="alertTriangle" size={11} className="mt-0.5 shrink-0" />
                                无法定位当前文件，“看改了什么”暂不可用（“与上一版比”不受影响）
                              </p>
                            )}
                          </div>
                          {openSet.has(`cur:${e.backupPath}`) && (
                            <DiffView state={curState[e.backupPath]} title="相对当前文件的变更" />
                          )}
                          {prev && openSet.has(`adj:${e.backupPath}`) && (
                            <DiffView
                              state={adjState[e.backupPath]}
                              title={`与上一版（${prev.createdAt}）的差异`}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {/* 白名单关闭提示 */}
              {!status?.whitelistEnabled && (
                <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <Icon name="info" size={13} className="mt-0.5 shrink-0" />
                  白名单当前已关闭，出于安全考虑禁用「看改了什么」与「还原」（无法确认目标文件归属）。如需操作，可在「审计日志」中对应操作的详情里进行；「与上一版比」仍可正常使用。
                </p>
              )}
            </>
          )}
        </div>
    </Modal>
  );
}
