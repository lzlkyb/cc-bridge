import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import type { CcProbe } from "../lib/ccEventTypes";
import { ccReducer, initialCcView, pendingApprovals } from "../lib/ccReducer";
import { pickClaudePath } from "../lib/ccTarget";
import type { CcPermissionMode } from "../lib/ccGuiTypes";
import { useCcEventStream } from "./useCcEventStream";
import { useCcOpenHistory } from "./useCcOpenHistory";

/** 起一轮要传给后端的东西。 */
export type CcTarget = {
  /** `null` = 本机跑（探针与日常自测的必需路径）。 */
  connectionId: string | null;
  cwd: string | null;
  /** 探测得到的 claude 绝对路径。远端模式下必须给，否则非登录 shell 找不到它。 */
  claudePath: string | null;
  model: string | null;
  permissionMode: CcPermissionMode;
};

/**
 * 对话状态机（React 侧的门面）。
 *
 * ## 为什么先订阅、再拉快照、最后补漏
 *
 * 三件事必须按这个顺序做，否则会漏事件：
 * 1. 先订阅 —— 订阅之前发生的事件一条都收不到；
 * 2. 再拉快照 —— 它包含**订阅那一刻之前**的全部事件，与第 1 步必然重叠；
 * 3. 最后用序号把重叠部分丢掉（`seq < snapshot.nextSeq` 的都已在快照里）。
 *
 * 反过来（先快照再订阅）会丢掉两者之间的那一段，而它恰好包含「刚发出的那句话」
 * 和「刚回来的第一条流式碎片」—— 表现是偶发、只在慢机器上出现的丢头。
 *
 * ## 为什么这里的错误不弹 toast
 *
 * 对话页的错误（CLI 没装、模型名不对、远端路径找不到）是**内容**而不是打扰：
 * 它就长在对话流里，用户要能回头看到。toast 三秒后就没了。
 */
export function useCcSession(target: CcTarget) {
  const [view, dispatch] = useReducer(ccReducer, initialCcView);
  // 事件流（先订阅 → 再快照 → 序号补漏）自成生命周期，见 useCcEventStream 的文档。
  // `sessionIdRef` 是本路对话的内部 id：下面每个命令都带它寻址（3-1a 多会话化）。
  const { ready, restored, clearRestored, seqRef, sessionIdRef } =
    useCcEventStream(dispatch);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<CcProbe | null>(null);
  /**
   * 待发队列（「运行中继续打字」的落点）。
   *
   * 两条 ref 与一份 state 并存：state 给界面显示条数，ref 给 `start` 与 flush
   * 读取最新值 —— `start` 是 `useCallback([])`，把 state 塞进依赖会让它每次
   * 渲染都换身份，而它是 `CcGuiTab` 探测 effect 的依赖，重订阅的代价白付。
   */
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  queueRef.current = queue;
  /** `view.running` 的镜像，理由同 `queueRef`。 */
  const runningRef = useRef(false);
  runningRef.current = view.running;
  /**
   * `busy` 的镜像，同理。
   *
   * 🔴 `start` 必须是 `useCallback([])`：它是 flush effect 的依赖，也透传给
   * memo 化的 Composer / 空状态。而 `[]` 意味着函数体闭包读到的 `busy` 永远是
   * **首渲染的 false** —— 「刚发出去、后端还没落定 running」那窗口里防重发的
   * 一道闸等于没有。镜像成 ref 才是每次调用读最新值。
   */
  const busyRef = useRef(false);
  busyRef.current = busy;
  /**
   * 最近一次探测到的 claude 绝对路径 + 它属于哪个目标。
   *
   * 远端**必须**用绝对路径执行：真正跑起来的 bash 是非登录的，拿不到
   * `~/.local/bin` 那份 PATH，直接写 `claude` 会「命令不存在」。
   * 记 `connId` 是为了防止换了连接还用上一个目标的路径 —— 那会让它 exec 一个
   * 根本没装在这台机器上的文件。
   */
  const probeRef = useRef<{ connId: string | null; path: string } | null>(null);
  /** 起一轮时读最新配置，避免把 target 塞进依赖导致反复重订阅。 */
  const targetRef = useRef(target);
  targetRef.current = target;

  /** 探测 claude 是否可用。进页面、换连接、点「重试」时调。 */
  const runProbe = useCallback(async (): Promise<CcProbe | null> => {
    const t = targetRef.current;
    try {
      const res = await invoke<CcProbe>("cc_probe", {
        connectionId: t.connectionId,
        claudePath: t.claudePath,
      });
      setProbe(res);
      // 路径要留着给 `start` 用：远端靠它才能 exec 到 claude。
      probeRef.current =
        res.found && res.path.trim() ? { connId: t.connectionId, path: res.path.trim() } : null;
      if (!res.found) dispatch({ type: "error", message: res.message });
      return res;
    } catch (e) {
      const msg = String(e);
      setProbe({ found: false, path: "", version: null, message: msg, target: "" });
      dispatch({ type: "error", message: msg });
      return null;
    }
  }, []);

  const start = useCallback(async (text: string) => {
    const t = targetRef.current;
    const trimmed = text.trim();
    if (!trimmed) return;
    // 正在跑（或刚发出去、后端还没落定 busy）⇒ 入队，不并发。
    // 🔴 直发的后果是后端一句「上一轮还在进行」：那一句是真的，但用户看到的是
    // 「我打好的字被拒了」，而排队本来可以让这件事无声无息地正确发生。
    if (runningRef.current || busyRef.current) {
      setQueue((q) => [...q, trimmed]);
      return;
    }
    // 调用方显式给的优先；否则用**同一目标**探到的绝对路径 —— 远端非登录 shell
    // 没有 `~/.local/bin` 那份 PATH，不带就起不来。判断逻辑见 `pickClaudePath`。
    const claudePath = pickClaudePath(t.claudePath, probeRef.current, t.connectionId);
    // 内部 id 还没铸发完（点得比 `cc_new_session` 的 IPC 还快）⇒ 说明白，
    // 别带着 null 去找后端换一句看不懂的「会话不存在」。
    const sid = sessionIdRef.current;
    if (sid === null) {
      dispatch({ type: "error", message: "会话正在初始化，请稍候再试" });
      return;
    }
    setBusy(true);
    dispatch({ type: "sending" });
    try {
      await invoke<void>("cc_start", {
        sessionId: sid,
        req: {
          connectionId: t.connectionId,
          cwd: t.cwd,
          model: t.model,
          permissionMode: t.permissionMode,
          claudePath,
          text: trimmed,
        },
      });
    } catch (e) {
      // 后端已经把进程收尸了（`cc_start` 里的 interrupt），这里只负责说清楚。
      dispatch({ type: "error", message: String(e) });
    } finally {
      setBusy(false);
    }
    // `sessionIdRef` 是 ref（对象稳定），列出来是让 exhaustive-deps 看得见：
    // 函数体读它的 `.current`，规则无法自己证明那不会变。
  }, [sessionIdRef]);

  /**
   * 本轮一结束就把队首发出去。
   *
   * 判据是 `view.running` 由 true 转 false：那是 `TurnEnd` / `Exit` 落定的时刻，
   * 也是后端 `turn_active` 被清掉的时刻 —— 两个条件必须同时满足，而它们恰好
   * 在同一个事件里发生（`bookkeep` 先清 busy 再推事件）。
   *
   * `ready` 之前不动：重放历史时 running 也会从 true 翻到 false，那时队列
   * 必然是空的，但把这道闸加上更直白。
   */
  useEffect(() => {
    if (!ready || view.running || busy) return;
    const next = queueRef.current[0];
    if (next === undefined) return;
    queueRef.current = queueRef.current.slice(1);
    setQueue(queueRef.current);
    void start(next);
  }, [ready, view.running, busy, start]);

  /**
   * 裁决一条审批，或回答一条提问。
   *
   * `answers` 只在提问时给：形状 `{问题文本: [选项 label…]}`，Rust 侧会并进
   * `updatedInput.answers`。给普通工具带 answers 会被后端拒掉（那是防止这条路
   * 变成「给任意工具入参塞任意字段」的闸门）。
   */
  const respond = useCallback(
    async (
      requestId: string,
      decision: "allow" | "deny",
      message?: string,
      answers?: Record<string, string[]>,
    ) => {
      try {
        await invoke<void>("cc_respond", {
          sessionId: sessionIdRef.current,
          requestId,
          decision,
          message,
          answers,
        });
      } catch (e) {
        // 常见原因：这一轮已经结束（60s 超时 / 用户中断），请求 id 随之失效。
        dispatch({ type: "error", message: String(e) });
      }
    },
    // 同 `start`：ref 本身稳定，列出来给 exhaustive-deps 看。
    [sessionIdRef],
  );

  const interrupt = useCallback(async () => {
    // 队列跟着一起清：用户打断这一轮，通常也意味着「别再把刚才那些发出去」。
    // 只杀进程不清队列的话，下一轮会自动把用户想拦下的消息发出去。
    setQueue([]);
    try {
      await invoke<boolean>("cc_interrupt", { sessionId: sessionIdRef.current });
    } catch (e) {
      dispatch({ type: "error", message: String(e) });
    }
  }, [sessionIdRef]);

  const reset = useCallback(async () => {
    setQueue([]);
    try {
      await invoke<void>("cc_reset", { sessionId: sessionIdRef.current });
      dispatch({ type: "reset" });
      setProbe(null);
    } catch (e) {
      dispatch({ type: "error", message: String(e) });
    }
  }, [sessionIdRef]);

  const clearError = useCallback(() => dispatch({ type: "error", message: null }), []);

  /**
   * 把一条外部错误报进对话流（润色失败这类「页面自己的操作」出的错）。
   *
   * 不弹 toast 的理由同上面的错误：它是内容，用户要能回头看到。
   */
  const reportError = useCallback((message: string) => {
    dispatch({ type: "error", message });
  }, []);

  /**
   * 打开一条历史会话（把后端那条接管成当前会话）。整套时序约定在
   * `useCcOpenHistory` 里写明 —— 这里只做接线。
   */
  const openHistory = useCcOpenHistory({ sessionIdRef, seqRef, dispatch, clearRestored });

  return {
    view,
    ready,
    busy,
    probe,
    /**
     * 本路对话的内部 id（`cc_new_session` 铸发）。**以 ref 形式给出去**：
     * 多会话侧栏要在关闭某条时拿它调 `cc_close_session`，而这里没有理由为它
     * 引入一次额外渲染 —— 它一变就意味着后端已经认识这条会话了，界面不需要重画。
     */
    sessionIdRef,
    /** 上次进程留下的会话。`null` = 这次是全新开始（或用户点过「新对话」）。 */
    restored,
    runProbe,
    start,
    respond,
    interrupt,
    reset,
    openHistory,
    clearError,
    reportError,
    /** 已排队还没发的消息。界面上显示条数，也可一键清空。 */
    queue,
    clearQueue: () => setQueue([]),
    /** 还卡着等用户决定的审批 id。 */
    pending: pendingApprovals(view),
  };
}
