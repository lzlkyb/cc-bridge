import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "../../lib/tauri";
import type {
  BackupListResult,
  BackupFileInfo,
  FileDiffResult,
  StaticStatus,
} from "../../lib/types";
import { formatRelativeTime, formatBytes } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";
import { BackupDeleteConfirm, type BackupDeleteTarget } from "./BackupDeleteConfirm";
import { DiffView, type DiffState, countDiff } from "./DiffView";

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
  onDeleted,
}: {
  open: boolean;
  status?: StaticStatus;
  result: BackupListResult | null;
  loading: boolean;
  onClose: () => void;
  onRestore: (entry: BackupFileInfo) => void;
  /** 删掉备份后通知调用方刷新统计并失效备份列表缓存。 */
  onDeleted: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [view, setView] = useState<"file" | "time">("file");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeRail, setActiveRail] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  const [curState, setCurState] = useState<Record<string, DiffState>>({});
  const [adjState, setAdjState] = useState<Record<string, DiffState>>({});
  const [delTarget, setDelTarget] = useState<BackupDeleteTarget | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    const onFs = () => {
      if (!document.fullscreenElement) {
        // 退出全屏后，如果浏览器还有滚动偏移，先重置
        window.scrollTo(0, 0);
      }
    };
    el.addEventListener("fullscreenchange", onFs);
    return () => el.removeEventListener("fullscreenchange", onFs);
  }, []);

  // 打开时默认折叠所有分组（性能：避免一次性渲染全部时间线节点）
  useEffect(() => {
    if (!open) {
      setQuery("");
      setExpanded(new Set());
      setOpenSet(new Set());
      setCurState({});
      setAdjState({});
      // 必须一并清：否则开着确认框时关掉本弹框，下次打开会自己弹出上次那个
      // 删除确认，而且指向的可能是已不存在的路径。
      setDelTarget(null);
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
      <div ref={modalRef} className="vh-fullscreen-container flex flex-col overflow-hidden">
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
            onClick={() => {
              if (document.fullscreenElement) {
                document.exitFullscreen();
              } else {
                modalRef.current?.requestFullscreen();
              }
            }}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground interactive hover:bg-accent hover:text-foreground"
            aria-label="全屏"
          >
            <Icon name="maximize" size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground interactive hover:bg-accent hover:text-foreground"
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
                        {/* 展开按钮与删除按钮平级——不能嵌套 button，所以外层改成 div。
                            内边距给展开 button 自己带（而不是放在外层 div 上），否则那圈
                            padding 变成点不到的死区，而原来整行连内边距都可点。 */}
                        <div className="flex items-center bg-muted/50 pr-2 text-xs font-semibold">
                          <button
                            type="button"
                            aria-expanded={expanded.has(g.originalFile)}
                            onClick={() =>
                              setExpanded((prev) => {
                                const n = new Set(prev);
                                n.has(g.originalFile)
                                  ? n.delete(g.originalFile)
                                  : n.add(g.originalFile);
                                return n;
                              })
                            }
                            className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left"
                          >
                            <span className="truncate font-mono">{g.originalFile}</span>
                            <span className="shrink-0 font-normal text-muted-foreground">
                              {g.count} 份 · {formatBytes(g.totalBytes)}
                            </span>
                          </button>
                          <button
                            type="button"
                            title="删除该文件的全部备份"
                            onClick={() =>
                              setDelTarget({
                                kind: "group",
                                originalFile: g.originalFile,
                                count: g.count,
                              })
                            }
                            className={`${DANGER_BTN_CLASS} ml-2 shrink-0 font-normal`}
                          >
                            删除全部
                          </button>
                        </div>
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
                                      {/* 逐条删除只服务「精确删某一份」，批量走备份卡的「清理备份…」。 */}
                                      <button
                                        type="button"
                                        title="删除这份备份"
                                        onClick={() =>
                                          setDelTarget({ kind: "one", backupPath: e.backupPath })
                                        }
                                        className={DANGER_BTN_CLASS}
                                      >
                                        删除
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
                            {/* 还原与按文件视图保持对称：只给删除不给还原，等于让破坏性动作
                                可达而恢复动作不可达。禁用条件与按文件视图完全一致。 */}
                            <button
                              type="button"
                              disabled={!canDiff}
                              title={canDiff ? "还原到该备份" : "禁用还原（白名单关闭 / 路径已不在白名单内 / 无索引记录的历史备份）"}
                              onClick={() => onRestore(e)}
                              className={DANGER_BTN_CLASS}
                            >
                              还原
                            </button>
                            <button
                              type="button"
                              title="删除这份备份"
                              onClick={() =>
                                setDelTarget({ kind: "one", backupPath: e.backupPath })
                              }
                              className={DANGER_BTN_CLASS}
                            >
                              删除
                            </button>
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
      </div>

      {delTarget && (
        <BackupDeleteConfirm
          target={delTarget}
          onCancel={() => setDelTarget(null)}
          onDeleted={onDeleted}
        />
      )}
    </Modal>
  );
}
