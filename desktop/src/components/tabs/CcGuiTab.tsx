import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { useCcPaneList } from "../../hooks/useCcPaneList";
import { useCcShortcuts } from "../../hooks/useCcShortcuts";
import { useCcSessionActions } from "../../hooks/useCcSessionActions";
import { useCcStoredSessions } from "../../hooks/useCcStoredSessions";
import { useCcTargets } from "../../hooks/useCcTargets";
import { conflictWith } from "../../lib/ccPaneMeta";
import { archivedOnly, filterStored } from "../../lib/ccStoredList";
import { SessionSidebar } from "../ccgui/SessionSidebar";
import { CcPane } from "./CcPane";

/**
 * 窗口窄到这个宽度以下就自动折叠侧栏。
 *
 * 1160 的来历：1280 窗口下主区 1080 − 12 − 240 − 8 = 820 给消息列（设计稿算过，
 * 240 是让 772px 的 thread 刚好铺满的那一档）。再窄下去 240px 侧栏会开始挤
 * 消息列的行长，所以低于 1160 时让位给内容，用户仍可手动展开。
 */
const AUTO_COLLAPSE_W = 1160;

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
  /** 用户手动折叠过没有。`null` = 还没表态，跟随窗口宽度。 */
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);

  // 窄窗自动折叠成 48px rail。用户一旦手动点过收起/展开，就以他的选择为准 ——
  // 「我明明展开了它又自己缩回去」是最容易被骂的一类自作聪明。
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${AUTO_COLLAPSE_W}px)`);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const collapsed = userCollapsed ?? narrow;

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
    setUserCollapsed((cur) => !(cur ?? narrow));
  }, [narrow]);

  useCcShortcuts({
    onNewSession: list.add,
    onCycleSession: list.cycle,
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
    <div className="flex h-full gap-2">
      <SessionSidebar
        entries={list.entries}
        active={list.active}
        collapsed={collapsed}
        targets={targets}
        stored={historyView}
        archived={archivedView}
        archivedCount={archivedCount}
        onToggleCollapsed={toggleCollapsed}
        onToggleArchived={() => setArchivedView((v) => !v)}
        onPick={list.setActive}
        onNew={list.add}
        onClose={list.close}
        onOpenStored={list.openStored}
        actions={{
          rename: actions.rename,
          archive: actions.archive,
          archived: actions.archived,
        }}
      />
      <div className="min-w-0 flex-1">
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
            onNewSession={list.add}
            onForkSession={(seed) => list.forkFrom(e.key, seed)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
