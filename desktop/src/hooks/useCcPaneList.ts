import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { CcRestoreReq } from "../lib/ccEventTypes";
import type { CcForkSeed } from "../lib/ccFork";
import type { CcPaneMeta } from "../lib/ccPaneMeta";

/** 侧栏历史区的查询键。打开 / 关闭会话后要让它失效重取。 */
export const STORED_SESSIONS_KEY = ["ccStoredSessions"] as const;

/**
 * 侧栏里的会话条目。`meta` 由各自的 pane 上报（`null` = 这个 pane 还没上报过一次）。
 *
 * 为什么列表状态在**前端**而不是让后端出 `cc_list_sessions`：内部 id 本来就是
 * 前端要的句柄（`cc_new_session` 铸发），而「这个窗口里开了哪几条」是窗口级的
 * 事 —— 同一份后端状态可以有两个窗口各自不同的列表。「这条 pane 从库里载入
 * 哪一行」也一并记在这里（`restore`），因为它是**创建那一刻**的决定。
 */
export type CcPaneEntry = {
  key: string;
  meta: CcPaneMeta | null;
  /** 首次挂载时要不要从库里载入，以及载入哪一条。四态见 `CcRestoreReq`。 */
  restore: CcRestoreReq;
  /**
   * 这条是从哪条会话分叉出来的（3-3）。值是**来源 pane 的 key**，不是行号：
   * 分叉的目标就是「另开一条 pane」，同源的两条都还在这个窗口里。
   *
   * 只活在这个窗口里：重启后两条都是普通会话（分叉关系没有落库）。
   * 之所以能接受这个限制：分叉的用途是「同一个问题的两种走法，比完就收掉一条」，
   * 跨重启还成对摆着的需求并不存在；真要看血缘，标题 + 时间就够认。
   */
  forkOf?: string;
};

/** 一个窗口里最多挂几条。**不是**后端限制（后端不设上限，见 `CcSessions`），
 *  纯粹是「一屏塞满还翻不到」的界面阈值：到这个数会自动折叠成 rail。 */
export const PANE_SOFT_LIMIT = 12;

/**
 * 窗口里的会话列表：增 / 切 / 关 + 各自上报的侧栏元信息。
 *
 * `key` 是前端自己的键，与后端内部 id（`meta.sessionId`）分开：
 * - pane 挂载那一刻就要有 key（React key、active 比较都靠它），
 *   而内部 id 要等 `cc_new_session` 的 IPC 回来才有；
 * - 关掉一条会话时 key 立刻从列表消失，后端 id 则要等 `cc_close_session` 落定。
 *
 * 两类 id 混用一个字段，就会在「刚新建还没铸发完」那一小段里出现 `undefined`
 * 或 `NaN` 当 key 的经典 bug。
 */
export function useCcPaneList() {
  const qc = useQueryClient();
  // 第一条接着上次聊（重启恢复）；它之后的所有 pane 都必须显式说要不要载入。
  const [entries, setEntries] = useState<CcPaneEntry[]>(() => [
    { key: "p1", meta: null, restore: { kind: "latest" } },
  ]);
  const [active, setActive] = useState("p1");
  /** 自增的 key 序列。`p1` 已被初始条目占用，从 2 起。 */
  const [seq, setSeq] = useState(2);

  /** 追加一条并切过去（与「点 + 就该进新会话」的直觉一致）。 */
  const spawn = useCallback(
    (restore: CcRestoreReq, forkOf?: string) => {
      const key = `p${seq}`;
      setSeq(seq + 1);
      setEntries((list) => [...list, { key, meta: null, restore, forkOf }]);
      setActive(key);
    },
    [seq],
  );

  /** `+` / Ctrl+N：空白新会话，**不**从库里载入（3-1b 的重复载入缺陷就修在这）。 */
  const add = useCallback(() => spawn({ kind: "none" }), [spawn]);

  /**
   * 从某条消息分叉 / 编辑重发（3-3）：新开一条会话并立刻重跑那句话。
   *
   * 原 pane **一个字节都不动**（不截断、不重置、不换 resume id）：它是用户眼前
   * 那条正在使用的东西，顶掉它等于把上下文抽走。分叉出来的这条要是聊歪了，
   * 关掉就回到原会话。
   */
  const forkFrom = useCallback(
    (sourceKey: string, seed: CcForkSeed) => spawn({ kind: "seed", seed }, sourceKey),
    [spawn],
  );

  /**
   * 打开库里的一条历史：新开一条 pane 载入它，**不动当前这条**。
   *
   * 不用「接管当前 pane」的语义：3-1b 之后当前 pane 是有身份的实体（进程、
   * 待批单、内部 id），顶掉它等于把用户正在看的东西抽走。点列表里的一条 =
   * 又多开了一条，关掉它自然回到原来那条。
   */
  const openStored = useCallback(
    (rowId: number) => {
      // 同一行已经在开了就别再开一条：连点两下不该得到两个一模一样的 pane。
      // （历史上还有一种「点了正在恢复的那条」—— 那条不走这里，它由宿主用
      // `settled` 挡，见 `CcGuiTab`。）
      if (entries.some((e) => e.restore.kind === "row" && e.restore.rowId === rowId)) return;
      spawn({ kind: "row", rowId });
    },
    [entries, spawn],
  );

  /**
   * 关掉一条。**先让界面消失，再通知后端**：
   * 后端那步要杀进程 + 落盘，慢的时候几百毫秒，等它回来才收起侧栏会让
   * 「点 × 没反应」。反过来（先收起再关）唯一风险是后端失败 —— 那时会话
   * 仍留在内存表里，但它已经不在任何列表上，用户看不到，也没法再操作，
   * 等价于关掉了（进程仍会被下一次「关闭窗口」的 `shutdown_all` 收走）。
   *
   * **最后一条不许关**：界面至少要有一个对话区可看，否则用户面对一个空壳
   * 还得自己猜「+」在哪。侧栏的 × 与这里同一条判据（`entries.length > 1`）。
   */
  const close = useCallback(
    (key: string) => {
      if (entries.length <= 1) return;
      const target = entries.find((e) => e.key === key);
      const idx = entries.findIndex((e) => e.key === key);
      const rest = entries.filter((e) => e.key !== key);
      setEntries(rest);
      setActive((cur) => (cur === key ? rest[Math.max(0, Math.min(idx, rest.length - 1))].key : cur));
      const sid = target?.meta?.sessionId;
      if (typeof sid === "number") {
        // 失败只记日志：用户已经把这条从界面上关掉了，再弹一个错误也修不回来。
        void invoke<boolean>("cc_close_session", { sessionId: sid })
          // 关掉的这条刚落进库 ⇒ 侧栏历史区要能立刻看到它。
          .then(() => qc.invalidateQueries({ queryKey: STORED_SESSIONS_KEY }))
          .catch((e) => {
            console.warn("关闭会话失败", e);
          });
      }
    },
    [entries, qc],
  );

  /**
   * pane 上报自己的元信息。
   *
   * 🔴 先按**引用**判重（pane 那边用 `useMemo` 算 meta，没变化时引用不变），
   * 再按字段兜底：pane 每次上报都会在末尾补一个 `sessionId`（纯函数算不出来，
   * 只能读 ref），那一步必然新建对象 —— 只靠引用判重的话，每条流式碎片都会
   * 让侧栏 setState 一次，进而把**所有** pane 重渲染一遍。
   */
  const report = useCallback((key: string, meta: CcPaneMeta) => {
    setEntries((list) => {
      const idx = list.findIndex((e) => e.key === key);
      if (idx < 0) return list;
      const prev = list[idx].meta;
      if (prev === meta) return list;
      // 侧栏看得见的只有这几项，其余变化（消息内容、token 数）不必惊动它。
      if (
        prev &&
        prev.sessionId === meta.sessionId &&
        prev.title === meta.title &&
        prev.turns === meta.turns &&
        prev.state === meta.state &&
        prev.detail === meta.detail &&
        prev.connectionId === meta.connectionId &&
        prev.targetLabel === meta.targetLabel &&
        prev.cwd === meta.cwd &&
        prev.cliSessionId === meta.cliSessionId &&
        prev.rowId === meta.rowId &&
        prev.restoring === meta.restoring
      ) {
        return list;
      }
      const next = list.slice();
      // 展开而不是重建：`restore` 是创建那一刻的决定，report 不该动它。
      next[idx] = { ...list[idx], meta };
      return next;
    });
  }, []);

  /** Ctrl+Tab / Ctrl+Shift+Tab 循环切换。`delta` 为 ±1。 */
  const cycle = useCallback(
    (delta: 1 | -1) => {
      setActive((cur) => {
        if (entries.length < 2) return cur;
        const idx = entries.findIndex((e) => e.key === cur);
        const next = (idx + delta + entries.length) % entries.length;
        return entries[next].key;
      });
    },
    [entries],
  );

  return { entries, active, setActive, add, openStored, forkFrom, close, report, cycle };
}
