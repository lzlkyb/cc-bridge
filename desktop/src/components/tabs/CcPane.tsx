import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList, StatusResponse } from "../../lib/types";
import type { CcPermissionMode } from "../../lib/ccGuiTypes";
import { useCcSession } from "../../hooks/useCcSession";
import { useCcProbe } from "../../hooks/useCcProbe";
import {
  readCwd,
  readMode,
  readModel,
  restorePlan,
  saveCwd,
  saveMode,
  saveModel,
} from "../../lib/ccGuiPrefs";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import { derivePaneMeta, type CcPaneMeta } from "../../lib/ccPaneMeta";
import { toBarSession } from "../../lib/ccSessionBar";
import { shortcutLabel } from "../../lib/platform";
import { CcPaneHead } from "../ccgui/CcPaneHead";
import { Composer } from "../ccgui/Composer";
import { ConversationStream } from "../ccgui/ConversationStream";

/**
 * 一条对话会话的完整界面：偏好状态 + 会话条/提示条 + 消息流 + 输入区。
 *
 * 2026-10-25 从 `CcGuiTab` 拆出（3-1b 多会话）：原来 Tab 本身就是「那一条会话」，
 * 多会话之后 Tab 变成**宿主**（侧栏 + 若干 pane），每条会话一个 pane 实例。
 *
 * ## 为什么是「一个 pane 一个 useCcSession」而不是「一个 reducer 管 N 条」
 *
 * 状态真正的家在 Rust（`CcSession`：进程、事件流水、resume id、待批单），
 * 前端这层只是渲染 —— 所以多开一条的代价是**多一个订阅 + 多一个 reducer**，
 * 而不是把 reducer 改造成 `Map<id, View>`（那会把凡断言「一次事件 → 一个 view」
 * 的测试全部改掉，收益只是省了几份小状态）。
 *
 * 副作用是「切走的那条继续收事件」—— 这正是我们要的：切回来时审批卡还在、
 * 流式正文是连续的，不需要重放。隐藏用 CSS（`hidden`），不卸载。
 *
 * 🔴 状态数顶在体量门禁的 8 个（4 个偏好 + 4 个 effect）：**再加状态必须往子组件
 *    里放**（润色状态已经这么挪进 `Composer` 了）。
 */
export function CcPane({
  paneKey,
  active,
  onMeta,
  onNewSession,
  onNavigate,
}: {
  paneKey: string;
  active: boolean;
  /** 把侧栏要显示的元信息报上去。按引用判重，见 `useCcPaneList.report`。 */
  onMeta: (key: string, meta: CcPaneMeta) => void;
  /** 新建**另一条**会话（侧栏的 +、Ctrl+N、会话条的「新对话」都走它）。 */
  onNewSession: () => void;
  onNavigate: (tab: string) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<CcPermissionMode>(readMode);
  // 下一轮的模型。空串 = 不传 `--model`，吃 CLI 自己的默认。全局偏好，不按连接分。
  const [model, setModel] = useState(readModel);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<SshConnectionList, Error>({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
  });
  const targets = useMemo(
    () => [
      { id: "", label: "本机" },
      ...(data?.connections ?? []).map((c) => ({ id: c.id, label: c.name || c.host })),
    ],
    [data?.connections],
  );

  // 每台机器记各自的工作目录：本机的路径喂给远端只会得到一句看不懂的报错。
  useEffect(() => {
    setCwd(readCwd(targetId));
  }, [targetId]);

  const session = useCcSession({
    connectionId: targetId || null,
    cwd: cwd.trim() || null,
    // 留空由 hook 内部的探测结果补：远端必须用绝对路径执行，
    // 而路径只有 probe 拿得到（这里不该再探一次）。
    claudePath: null,
    model: model || null,
    permissionMode: mode,
  });
  const { view, restored, reportError } = session;

  /**
   * 快捷键标签的平台来源（Ctrl+N / ⌘N）。与 App 层共用 `["status"]` 缓存，
   * **不会多发请求**；取后端值而非嗅探 UA 的理由见 `lib/platform.ts`，首帧未返回时
   * 先显示 Ctrl（那里写明的取舍）。
   */
  const { data: platform } = useQuery<StatusResponse, Error, string | undefined>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => s.platform,
  });
  const newSessionHint = shortcutLabel(platform, "N");

  /**
   * 把恢复出来的会话**连同它的目标**一起还原（判据全在 `restorePlan`）。
   *
   * 🔴 只还原消息是不够的：`useCcSession` 每次 `start` 都从当前 target 拼参数。
   * 目标没跟着切回去，用户看到的是那段远端对话、发出去却落到本机的新会话上 ——
   * 消息还在、上下文没了，而且**没有任何报错**。
   *
   * 顺序不能反：`saveCwd` 必须在 `setTargetId` **之前**，那个 effect 会立刻
   * 用新 `cwdKey(targetId)` 重读 localStorage，晚一步就被覆盖成上次留下的值。
   * `claudePath` **故意不采信** —— 库里的路径可能早就失效，重探一次更可靠。
   */
  useEffect(() => {
    if (!restored) return;
    const p = restorePlan(restored);
    saveCwd(p.connectionId, p.cwd);
    setTargetId(p.connectionId);
    setCwd(p.cwd);
    if (p.mode) {
      setMode(p.mode);
      saveMode(p.mode);
    }
    if (p.model) {
      setModel(p.model);
      saveModel(p.model);
    }
  }, [restored]);

  const setCwdPersist = useCallback(
    (v: string) => {
      setCwd(v);
      saveCwd(targetId, v);
    },
    [targetId],
  );

  /**
   * 打开一条历史会话，并把**目标**一起切到它那边。
   *
   * 🔴 顺序不能反：`saveCwd` 必须在 `setTargetId` **之前**。`targetId` 那个 effect
   * 会立刻用 `cwdKey(targetId)` 重读 localStorage，晚一步就会被旧值覆盖。
   * 这和期一恢复 `restored` 时踩的是同一个坑。
   *
   * 本机历史一律切回 `""`：`cc_start` 会拿 `connection_id` + `cwd` 和内存里的
   * facts 比，不一致就判「换了目标」并**清掉 resume id** —— 那时打开的历史
   * 会静悄悄变成一条新会话，用户看到的是「我问了它一句，它完全不记得上面」。
   */
  const onOpenHistory = useCallback(
    (row: CcHistoryRow) => {
      void session.openHistory(row.sessionId).then((res) => {
        if (!res) return;
        const dir = res.cwd ?? "";
        saveCwd("", dir);
        setTargetId("");
        setCwd(dir);
      });
    },
    [session],
  );

  // 进页面 / 换目标时探一次 + 手动重试。`runProbe` 是 useCallback 稳定的，不会反复触发。
  const { probing, retry: retryProbe } = useCcProbe(session.runProbe, targetId);

  /**
   * 润色草稿（mods/prompt-polish）。
   *
   * 走独立的 `cc_polish` 命令而不是会话通道：它是一次性的 `claude -p`，
   * 结果只回给输入框，不进对话流、不占会话上下文。失败返回 `null`
   * （Composer 不动文本），原因转成对话流里的一条 notice。
   */
  const onPolish = useCallback(
    async (draft: string): Promise<string | null> => {
      try {
        return await invoke<string>("cc_polish", {
          req: {
            connectionId: targetId || null,
            cwd: cwd.trim() || null,
            draft,
          },
        });
      } catch (e) {
        reportError(`润色失败：${e}`);
        return null;
      }
    },
    [targetId, cwd, reportError],
  );

  // 新内容贴底。ref 稳定，不进依赖。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view.messages, view.resolved]);

  // 跳到流里第一处 diff：锚点是 ToolCard 根节点的 data-cc-tool。高亮复用设置页
  // 深链的 anchor-highlight（主题色脉冲 2s），不新造一套动效。
  const jumpTo = useCallback((messageId: string) => {
    const node = scrollRef.current?.querySelector<HTMLElement>(
      `[data-cc-tool="${CSS.escape(messageId)}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("anchor-highlight");
    window.setTimeout(() => node.classList.remove("anchor-highlight"), 2000);
  }, []);

  /**
   * 侧栏那一行：标题 / 轮数 / 五态点 / 副标题。纯计算在 `lib/ccPaneMeta`。
   *
   * `sessionId` 在 effect 里读 ref 而不是在 `useMemo` 里：内部 id 是**铸发后**
   * 才写进 ref 的，进来那一刻（甚至第一帧）还是 null。`ready` 从 false 变 true
   * 正好是「铸发 + 快照都走完」的那一刻，拿它当依赖才能把 id 补上。
   */
  const metaBase = useMemo(() => {
    const targetLabel = targets.find((t) => t.id === targetId)?.label ?? "本机";
    return derivePaneMeta({
      view,
      pending: session.pending,
      connectionId: targetId || null,
      targetLabel,
      targetAlive: targetId === "" || targets.some((t) => t.id === targetId),
    });
  }, [view, session.pending, targetId, targets]);
  useEffect(() => {
    onMeta(paneKey, { ...metaBase, sessionId: session.sessionIdRef.current });
  }, [paneKey, metaBase, session.ready, session.sessionIdRef, onMeta]);

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

  return (
    <div
      data-cc-panel
      className={`${active ? "flex" : "hidden"} h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card`}
    >
      <CcPaneHead
        bar={bar}
        view={view}
        targets={targets}
        targetId={targetId}
        onTargetChange={setTargetId}
        mode={mode}
        onModeChange={(m) => {
          setMode(m);
          saveMode(m);
        }}
        onModelChange={(m) => {
          setModel(m);
          saveModel(m);
        }}
        onSwitchTerminal={() => onNavigate("terminal")}
        onNewSession={onNewSession}
        newSessionHint={newSessionHint}
        onOpenHistory={onOpenHistory}
        onJumpTo={jumpTo}
        onDismissError={session.clearError}
      />

      <ConversationStream
        scrollRef={scrollRef}
        view={view}
        probe={session.probe}
        probing={probing}
        retryProbe={retryProbe}
        onSend={session.start}
        onRespond={(id, decision, reason, answers) =>
          void session.respond(id, decision, reason, answers)
        }
        cwd={cwd}
        onCwdChange={setCwdPersist}
        isRemote={Boolean(targetId)}
        newSessionHint={newSessionHint}
      />

      <Composer
        onSend={session.start}
        running={view.running || session.busy}
        onInterrupt={() => void session.interrupt()}
        placeholder={session.pending.length > 0 ? "先处理上面的审批，再继续…" : "给 CC 发消息…"}
        queueCount={session.queue.length}
        onClearQueue={session.clearQueue}
        onPolish={onPolish}
      />
    </div>
  );
}
