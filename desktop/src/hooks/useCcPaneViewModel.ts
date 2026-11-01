import { useCallback, useEffect, useMemo } from "react";
import { derivePaneMeta, type CcPaneMeta } from "../lib/ccPaneMeta";
import { paneForkSeed, type CcForkSeed } from "../lib/ccFork";
import { toBarSession } from "../lib/ccSessionBar";
import type { CcRestoreReq } from "../lib/ccEventTypes";
import type { CcPermissionMode } from "../lib/ccGuiTypes";
import type { useCcSession } from "./useCcSession";
import type { useCcTargets } from "./useCcTargets";

/**
 * 一条 pane 的「派生视图」：侧栏元信息、会话条、历史行号、分叉切点。
 *
 * 2026-11 从 `CcPane.tsx` 外移（审查 P3-1）：那个组件正好 300 行 —— 门禁卡在线上，
 * 靠把两条语句挤一行维持（`metaBase` 那一大段 useMemo、`rowId` 的三元链都在里面）。
 * 搬走的是一个完整关注点：**从会话状态派生给宿主 / 顶栏 / 侧栏看的东西**，
 * 与「渲染三段布局」无关，彼此没有共享的可变状态。
 *
 * 三条容易踩的规则（原样保留）：
 * 1. `sessionId` 在 effect 里读 ref 而不是在 `useMemo` 里算 —— 内部 id 是**铸发后**
 *    才写进 ref 的，进来那一刻还是 null；`ready` 从 false 变 true 才把它补上。
 * 2. `rowId` 有三个来源，缺一个历史区就会在载入完成前把这条重复列出几百毫秒。
 * 3. `onForkMessage` 的依赖只列 `view.messages` / `view.sessionId`，不列整个 `view`
 *    —— 流式时每一 tick 都会换 `view`，列它等于每次碎片都重建回调。
 */
export function useCcPaneViewModel({
  paneKey,
  view,
  session,
  targetId,
  targets,
  cwd,
  model,
  mode,
  titleOverride,
  restore,
  onMeta,
  onForkSession,
}: {
  paneKey: string;
  view: ReturnType<typeof useCcSession>["view"];
  session: ReturnType<typeof useCcSession>;
  targetId: string;
  targets: ReturnType<typeof useCcTargets>;
  cwd: string;
  model: string;
  mode: CcPermissionMode;
  titleOverride?: string;
  restore: CcRestoreReq;
  onMeta: (key: string, meta: CcPaneMeta) => void;
  onForkSession: (seed: CcForkSeed) => void;
}) {
  /** 侧栏那一行：标题 / 轮数 / 五态点 / 副标题。纯计算在 `lib/ccPaneMeta`。 */
  const metaBase = useMemo(() => {
    const targetLabel = targets.find((t) => t.id === targetId)?.label ?? "本机";
    return derivePaneMeta({
      view,
      pending: session.pending,
      connectionId: targetId || null,
      targetLabel,
      targetAlive: targetId === "" || targets.some((t) => t.id === targetId),
      // 输入框里的目录（不是 `view.cwd`）：同目录并发判的是「按下发送会落到哪」。
      cwd,
      // 恢复没走完就别让历史区露出来 —— 那时本条还没有 rowId / cliSessionId，
      // 对不上账会让它自己在历史区里再出现一次（可点 ⇒ 开出重复的一条）。
      restoring: !session.ready,
      // 手写标题优先于「首条消息」：改完名看不到变化，等于改名没生效。
      titleHint: titleOverride ?? (session.restored?.titleLocked ? session.restored.title : null),
    });
  }, [view, session.pending, targetId, targets, cwd, session.ready, titleOverride, session.restored]);

  /**
   * 库里那一行的行号，给侧栏历史区对账用。三个来源：「从历史打开」的 entry 自带；
   * 「接着上次聊」的等 `cc_restore`；「历史按钮接管进当前 pane」的等 `cc_history_open`
   * （`adoptedRowId`，那时 `restored` 已被清）。新会话为 `null`。
   */
  const rowId =
    view.rowId ??
    (restore.kind === "row" ? restore.rowId : (session.restored?.rowId ?? session.adoptedRowId ?? null));

  useEffect(() => {
    onMeta(paneKey, { ...metaBase, sessionId: session.sessionIdRef.current, rowId });
  }, [paneKey, metaBase, session.ready, session.sessionIdRef, onMeta, rowId]);

  /** 在这条消息处分叉重发（切换会话在宿主 `useCcPaneList.forkFrom`）。 */
  const onForkMessage = useCallback(
    (index: number, text: string) =>
      onForkSession(
        paneForkSeed(
          {
            messages: view.messages,
            sessionId: view.sessionId,
            title: metaBase.title,
            connectionId: targetId,
            cwd: cwd.trim(),
            model,
            permissionMode: mode,
          },
          index,
          text,
        ),
      ),
    [view.messages, view.sessionId, metaBase.title, targetId, cwd, model, mode, onForkSession],
  );

  const bar = useMemo(
    () =>
      toBarSession({
        connectionLabel: targets.find((t) => t.id === targetId)?.label ?? "本机",
        cwd,
        model,
        permissionMode: mode,
        view,
      }),
    [targets, targetId, cwd, model, mode, view],
  );

  return { metaBase, rowId, onForkMessage, bar };
}
