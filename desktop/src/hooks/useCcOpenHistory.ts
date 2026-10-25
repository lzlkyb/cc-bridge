import { useCallback, type Dispatch, type MutableRefObject, type RefObject } from "react";
import { invoke } from "../lib/tauri";
import type { CcHistoryOpened } from "../lib/ccEventTypes";
import type { CcAction } from "../lib/ccReducer";

/**
 * 「打开一条历史会话，把它接管成当前会话」这条动作。
 *
 * ## 为什么独立成 hook（2026-10-25）
 *
 * 它有自己的一整套时序约定（读正文 → 杀进程 → 灌流水 → **手动对齐游标**），
 * 而这三件事的坑都在注释里写了却没人看得见 —— 与 `useCcSession` 里「发一条
 * 消息」的状态逻辑没有交集。抽出来之后，改会话生命周期的代码不会顺手碰到它。
 *
 * `historyId` 是 **CC 的**历史会话 id（转录文件名 stem）；命令寻址用的内部 id
 * 另走 `sessionId` 参数 —— 两者同名不同物，别混。
 */
export function useCcOpenHistory({
  sessionIdRef,
  seqRef,
  dispatch,
  clearRestored,
}: {
  sessionIdRef: RefObject<number | null>;
  seqRef: MutableRefObject<number>;
  dispatch: Dispatch<CcAction>;
  /** 「上次那条」的提示已经没意义了（当前会话就是它）。 */
  clearRestored: () => void;
}) {
  /**
   * ## 为什么要手动设 `seqRef`
   *
   * 那些历史事件是后端**直接写进 ring** 的，没有逐条 emit（emit 会和这次
   * `replay` 撞成两份）。所以前端游标停在旧值上，不重置的话，下一条实时事件的
   * `seq` 比它大得多没问题，但若用户先开了历史再开另一条，`seq` 会回绕到更小值
   * —— 那时 `apply` 里的 `p.seq < seqRef.current` 会把**所有**新事件当重复丢掉。
   */
  return useCallback(
    async (historyId: string): Promise<CcHistoryOpened | null> => {
      try {
        const res = await invoke<CcHistoryOpened>("cc_history_open", {
          sessionId: sessionIdRef.current,
          historyId,
        });
        seqRef.current = res.snapshot.nextSeq;
        dispatch({
          type: "replay",
          events: res.snapshot.events,
          // 两个缺口相加：`dropped` 是环形缓冲溢出，`trimmed` 是体积上限裁掉的头部。
          dropped: res.snapshot.dropped + res.trimmed,
          running: false,
        });
        // 「上次那条」到此为止 —— 当前会话已经就是它了，再弹一次恢复提示纯属噪音。
        clearRestored();
        return res;
      } catch (e) {
        dispatch({ type: "error", message: String(e) });
        return null;
      }
      // `clearRestored` / `seqRef` / `sessionIdRef` 实际都稳定，列出来只是让
      // lint 看得见：它们来自自定义 hook 的返回或 ref，规则无法自己证明。
    },
    [clearRestored, seqRef, sessionIdRef, dispatch],
  );
}
