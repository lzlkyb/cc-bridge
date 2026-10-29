import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { useCcPaneList } from "../../hooks/useCcPaneList";
import { useCcShortcuts } from "../../hooks/useCcShortcuts";
import { useCcSessionActions } from "../../hooks/useCcSessionActions";
import { useCcStoredSessions } from "../../hooks/useCcStoredSessions";
import { useCcTargets } from "../../hooks/useCcTargets";
import { usePresence } from "../../hooks/usePresence";
import { conflictWith } from "../../lib/ccPaneMeta";
import { archivedOnly, filterStored } from "../../lib/ccStoredList";
import { isImeComposing } from "../../lib/utils";
import { SessionSidebar } from "../ccgui/SessionSidebar";
import { CcPane } from "./CcPane";
import "../ccgui/sessionWorkspace.css";

/** 按工作区实际可用宽度切换；全局导航收起后也能立即恢复双栏。 */
const DRAWER_WIDTH = 900;

/**
 * CC 对话页（宿主）。
 *
 * 定位：**并列视图，不是终端替代品**。原「终端」页一行代码未动，本页只是多一个入口。
 * 1280 窗口减掉侧栏后主区只有 1080，不再切右侧检查器 —— 变更集/待批准都收在对话流里。
 *
 * ## 谁管什么（3-1b 多会话化 / 3-1c 历史区之后）
 *
 * - **这里**（宿主）：会话列表、当前是哪一条、侧栏折叠、历史区、同目录并发判定、
 *   窗口级快捷键；
 * - **`CcPane`**：一条会话的全部界面与目标/模型/权限偏好；
 * - **Rust**（`cc_session`）：进程、事件流水、resume id、待批单、落盘。
 *
 * 所以这个组件本身**仍然可以被卸载**（切 app tab 时会）：列表随组件消失，
 * 但内容都在 Rust 侧，下次进来重新铸发 + 从 `cc_snapshot` 重放就能重建 ——
 * 这也是「重启后只剩一两分钟前的会话」这个旧限制的真正来源（3-2 解决）。
 */
export function CcGuiTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const list = useCcPaneList();
  /** 改名 / 归档（3-1d）。`titles` 是本窗口改过的标题，按库里的行号索引。 */
  const actions = useCcSessionActions();
  /** 历史区摆「已归档」那一档（3-1d）。窗口级界面状态，不进库。 */
  const [archivedView, setArchivedView] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [compact, setCompact] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = usePresence(compact && drawerOpen);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const collapsed = !compact && userCollapsed;

  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const measure = (width: number) => {
      if (width > 0) setCompact(width < DRAWER_WIDTH);
    };
    measure(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setDrawerOpen(false); }, [compact]);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    requestAnimationFrame(() => workspaceRef.current
      ?.querySelector<HTMLButtonElement>('[data-cc-panel]:not(.hidden) [data-cc-sidebar-toggle]')?.focus());
  }, []);
  // 抽屉打开时保留消息流实例，只隔离背景交互，草稿和后台生成不会中断。
  useEffect(() => {
    if (!compact || !drawerOpen) return;
    const main = mainRef.current;
    if (main) main.inert = true;
    sidebarRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (isImeComposing(event) || event.defaultPrevented || document.querySelector('[data-cc-sidebar-menu], [data-confirm-dialog]')) return;
      if (event.key === "Escape") { event.preventDefault(); closeDrawer(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); event.stopPropagation();
        sidebarRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
      }
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey) return;
      const items = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') ?? [])
        .filter(item => item.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { if (main) main.inert = false; document.removeEventListener("keydown", onKey); };
  }, [compact, drawerOpen, closeDrawer]);

  // 分组显示名要用它；各 pane 用的是同一个 hook / 同一份缓存。
  const targets = useCcTargets();

  /**
   * 历史区：库里落盘过、但**当前没打开**的会话。
   *
   * 两套 id 一起对账（缺一个就会在某个瞬间漏）：
   * - `rowId`：`cc_restore` 一返回就有，所以「刚打开的那条」立刻从历史里消失；
   * - `cliSessionId`：要有 `Init` 事件之后才有，但新建的会话最终都会有。
   *
   * 只用 session id 的话，恢复完成的头几百毫秒里那条会仍待在历史区 ——
   * 用户点它就会开出**重复的一条**。
   */
  const stored = useCcStoredSessions();
  const openIds = useMemo(() => {
    const cliIds = new Set<string>();
    const rowIds = new Set<number>();
    for (const e of list.entries) {
      const cli = e.meta?.cliSessionId;
      if (cli) cliIds.add(cli);
      const row = e.meta?.rowId;
      if (typeof row === "number") rowIds.add(row);
    }
    return { cliIds, rowIds };
  }, [list.entries]);
  /**
   * 历史区当前那一档：`archivedView` 决定摆「历史」还是「已归档」。
   *
   * 两档共用一次查询（`cc_list_stored` 带 `includeArchived: true`）：归档条数
   * 要用来决定开关摆不摆，为一份计数再发一次请求不划算。
   */
  const historyRows = useMemo(
    () =>
      filterStored(
        stored.data ?? [],
        openIds,
        "",
        archivedView ? "archived" : "active",
      ),
    [stored.data, openIds, archivedView],
  );
  const archivedCount = useMemo(() => archivedOnly(stored.data ?? []).length, [stored.data]);
  const archivedRows = useMemo(() => ({
    ...Object.fromEntries((stored.data ?? []).map((row) => [row.rowId, row.archivedAt !== null])),
    ...actions.archived,
  }), [stored.data, actions.archived]);
  /**
   * 有 pane 还在恢复 ⇒ 历史区**整体不摆**。
   *
   * 恢复完成前那条会话的 `rowId` / `cliSessionId` 都还是 `null`，`filterStored`
   * 对不上账，于是「正在恢复的那条」会照样躺在历史区里 —— 用户点它，就开出
   * 重复的第二条（真机上抓到过）。等 `ready` 落地再摆，窗口期就没了。
   */
  const settled = list.entries.every((e) => e.meta !== null && !e.meta.restoring);
  /** 侧栏实际摆出来的历史行：恢复期为空，恢复完成后才是过滤结果。 */
  const historyView = settled ? historyRows : [];

  /**
   * 同目录并发：给每条 pane 算出「对面那条在跑的会话标题」。
   *
   * 判定必须是**全窗口视角**（要同时看到所有 pane 的目录与状态），所以只能放在
   * 宿主；纯逻辑在 `conflictWith`。没有冲突时给 `null`，pane 不渲染横幅。
   */
  const conflicts = useMemo(() => {
    const metas = list.entries;
    const out: Record<string, string | null> = {};
    for (const e of metas) {
      out[e.key] = conflictWith(
        e.meta,
        metas.filter((o) => o.key !== e.key).map((o) => o.meta),
      );
    }
    return out;
  }, [list.entries]);

  const toggleCollapsed = useCallback(() => {
    if (compact) {
      if (drawerOpen) closeDrawer();
      else setDrawerOpen(true);
    } else setUserCollapsed((cur) => !cur);
  }, [compact, drawerOpen, closeDrawer]);
  const addSession = list.add;
  const newSession = useCallback(() => {
    setArchivedView(false);
    addSession();
    if (compact) closeDrawer();
  }, [addSession, compact, closeDrawer]);
  useCcShortcuts({
    onNewSession: newSession,
    onCycleSession: (delta) => { list.cycle(delta); if (compact) closeDrawer(); },
    onToggleSidebar: toggleCollapsed,
  });

  /**
   * 切走本页（切 app tab ⇒ 本组件卸载）时，把**没有进行中轮次**的会话收掉。
   *
   * 不收的后果：重进本页会重新铸发新会话，旧的那条从此没有任何入口能摸到，
   * 却连同最多 4096 条 ring 一起永久滞留在后端的无上限会话表里 —— 切几十次
   * tab 就是几十条死会话。在跑的（run/ask/wait）**不收**：它们的产出用户还等着。
   */
  const entriesRef = useRef(list.entries);
  entriesRef.current = list.entries;
  useEffect(
    () => () => {
      for (const e of entriesRef.current) {
        const sid = e.meta?.sessionId;
        const st = e.meta?.state;
        if (typeof sid !== "number") continue;
        if (st === "run" || st === "ask" || st === "wait") continue;
        // 失败只记日志：页面已经在走了，这里能做的只有尽力收尸。
        void invoke<boolean>("cc_close_session", { sessionId: sid }).catch((err) => {
          console.warn("切页收尾关闭会话失败", err);
        });
      }
    },
    [],
  );

  return (
    <div ref={workspaceRef} className="cc-workspace-root" data-compact={compact || undefined}>
      {compact && drawer.mounted && <button className="cc-sidebar-shade" data-entered={drawer.entered}
        disabled={!drawerOpen} aria-hidden={!drawerOpen} tabIndex={-1} aria-label="关闭会话列表" onClick={closeDrawer} />}
      <div ref={node => { sidebarRef.current = node; if (node) node.inert = compact && !drawerOpen; }}
        className="cc-sidebar-slot" hidden={compact && !drawer.mounted} data-entered={drawer.entered}
        aria-hidden={compact && !drawerOpen || undefined}
        role={compact && drawerOpen ? "dialog" : undefined} aria-modal={compact && drawerOpen ? true : undefined}
        aria-label="会话列表" data-cc-sidebar-drawer={compact && drawerOpen || undefined}>
      <SessionSidebar
        entries={list.entries}
        active={list.active}
        collapsed={collapsed}
        drawer={compact}
        targets={targets}
        stored={historyView}
        archived={archivedView}
        archivedCount={archivedCount}
        onToggleCollapsed={toggleCollapsed}
        onToggleArchived={() => setArchivedView((v) => !v)}
        onPick={(key) => { list.setActive(key); if (compact) closeDrawer(); }}
        onNew={newSession}
        onClose={list.close}
        onOpenStored={(id) => { list.openStored(id); if (compact) closeDrawer(); }}
        actions={{
          rename: actions.rename,
          archive: actions.archive,
          archived: archivedRows,
        }}
      />
      </div>
      <div ref={mainRef} className="cc-workspace-main">
        {list.entries.map((e) => (
          <CcPane
            key={e.key}
            paneKey={e.key}
            active={e.key === list.active}
            restore={e.restore}
            conflict={conflicts[e.key] ?? null}
            titleOverride={
              typeof e.meta?.rowId === "number" ? actions.titles[e.meta.rowId] : undefined
            }
            onMeta={list.report}
            onNewSession={newSession}
            onToggleSidebar={toggleCollapsed}
            sidebarExpanded={compact ? drawerOpen : !collapsed}
            compact={compact}
            onForkSession={(seed) => list.forkFrom(e.key, seed)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
