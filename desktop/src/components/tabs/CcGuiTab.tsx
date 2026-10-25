import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList, StatusResponse } from "../../lib/types";
import {
  PERMISSION_MODE_RISK,
  type CcPermissionMode,
  type CcSession,
} from "../../lib/ccGuiTypes";
import { useCcSession } from "../../hooks/useCcSession";
import { useCcProbe } from "../../hooks/useCcProbe";
import { useCcShortcuts } from "../../hooks/useCcShortcuts";
import { asMode, readCwd, readMode, readModel, saveCwd, saveMode, saveModel } from "../../lib/ccGuiPrefs";
import type { CcHistoryRow } from "../../lib/ccEventTypes";
import { collectChangeset } from "../../lib/ccChangeset";
import { shortcutLabel } from "../../lib/platform";
import { CcEmptyState } from "../ccgui/CcEmptyState";
import { Composer } from "../ccgui/Composer";
import { MessageList } from "../ccgui/MessageList";
import { SessionBar } from "../ccgui/SessionBar";
import { SessionNotices } from "../ccgui/SessionNotices";

/**
 * CC 对话页。
 *
 * 定位：**并列视图，不是终端替代品**。原「终端」页一行代码未动，本页只是多一个入口。
 * 🔴 只做了对话区，没有右侧检查器 —— 1280 窗口减掉 200px 侧栏后主区只有 1080，
 *    再切 300px 检查器，diff 列会窄到不可读。变更集/待批准先收进对话流。
 *
 * 状态全在 Rust（`cc_session`），这里只是渲染 + 转发。切页回来靠 `cc_snapshot` 重放
 * 重建，所以这个组件**允许被随时卸载**——它没有任何东西是需要保活的。
 */
export function CcGuiTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [targetId, setTargetId] = useState("");
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<CcPermissionMode>(readMode);
  // 下一轮的模型。空串 = 不传 `--model`，吃 CLI 自己的默认。全局偏好，不按连接分。
  const [model, setModel] = useState(readModel);
  const [polishing, setPolishing] = useState(false);
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
   * 把恢复出来的会话**连同它的目标**一起还原。
   *
   * 🔴 只还原消息是不够的：`useCcSession` 每次 `start` 都从当前 target 拼参数。
   * 目标没跟着切回去，用户看到的是那段远端对话、发出去却落到本机的新会话上 ——
   * 消息还在、上下文没了，而且**没有任何报错**。
   *
   * cwd 必须先写进 localStorage 再切 `targetId`：`targetId` 的那个 effect 会立刻
   * 用 `cwdKey(targetId)` 重读，晚一步就会被覆盖成上次留下的值。
   *
   * 权限模式也跟着还原（那是上个会话的状态）；`claudePath` **故意不采信** ——
   * 库里的路径可能早就失效，重探一次更可靠，探测本身很便宜。
   */
  useEffect(() => {
    if (!restored) return;
    saveCwd(restored.connectionId, restored.cwd ?? "");
    setTargetId(restored.connectionId);
    setCwd(restored.cwd ?? "");
    const m = asMode(restored.permissionMode);
    if (m) {
      setMode(m);
      // 与 `onModeChange` 保持一致：不写的话下次刷新又回到旧模式，
      // 而用户刚看到的明明是恢复出来的那个。
      saveMode(m);
    }
    // 模型跟着会话走：上一轮用什么，续聊就用那个。
    // 空串 = 那条会话没记模型，此时**不动**用户当前的选择 ——
    // 拿空值覆盖掉一个已选的模型，等于替用户改设置。
    if (restored.model) {
      setModel(restored.model);
      saveModel(restored.model);
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

  // Ctrl+N / ⌘N 新对话。挂 window 而不是输入框：焦点在对话流/面板上时也要能按到。
  useCcShortcuts({ onNewSession: session.reset });

  /**
   * 润色草稿（mods/prompt-polish）。
   *
   * 走独立的 `cc_polish` 命令而不是会话通道：它是一次性的 `claude -p`，
   * 结果只回给输入框，不进对话流、不占会话上下文。失败返回 `null`
   * （Composer 不动文本），原因转成对话流里的一条 notice。
   */
  const onPolish = useCallback(
    async (draft: string): Promise<string | null> => {
      setPolishing(true);
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
      } finally {
        setPolishing(false);
      }
    },
    [targetId, cwd, reportError],
  );

  // 新内容贴底。ref 稳定，不进依赖。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view.messages, view.resolved]);

  // 变更集：本会话改过的文件（事件流聚合，不查 git）。随消息流增量更新。
  const changeset = useMemo(() => collectChangeset(view.messages), [view.messages]);
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

  const barSession: CcSession = {
    connection: targets.find((t) => t.id === targetId)?.label ?? "本机",
    cwd: cwd.trim(),
    branch: "",
    model,
    activeModel: view.model,
    permissionMode: mode,
    inputTokens: view.inputTokens,
    outputTokens: view.outputTokens,
    costUsd: view.costUsd,
    modelUsage: view.modelUsage,
    running: view.running,
    changeset,
    messages: [],
  };
  const risk = PERMISSION_MODE_RISK[mode];
  const lastStderr = view.stderr.slice(-2);

  return (
    <div data-cc-panel className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card">
      <SessionBar
        session={barSession}
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
        onNewSession={() => void session.reset()}
        newSessionHint={newSessionHint}
        onOpenHistory={onOpenHistory}
        onJumpTo={jumpTo}
      />

      {/* 🔴 打开历史后必须把**目标**一起切过去（见 `onOpenHistory`）：
          只灌消息不改 cwd，下一句会被 `cc_start` 判成「换了目录」→ 清 resume id
          → 打开的历史当场变成一条新会话，模型忘光前面且不报错。 */}
      <SessionNotices
        risk={risk}
        retry={view.retry}
        dropped={view.dropped}
        error={view.error}
        stderr={lastStderr}
        compacted={view.compactedTokens}
        background={view.backgroundTasks}
        onDismiss={session.clearError}
      />

      {/* page-scroll：对话流是长时停留的滚动区，要跟连接页/日志页同一根 12px rail，
          不挂就只有全局 6px 细条，右边缘看着比别的页窄一档。 */}
      <div ref={scrollRef} data-cc-stream className="page-scroll min-h-0 flex-1 overflow-y-auto px-3 py-1">
        <div className="mx-auto flex min-h-full max-w-[820px] flex-col gap-1.5">
          {view.messages.length === 0 ? (
            <CcEmptyState
              probe={session.probe}
              probing={probing}
              onRetryProbe={retryProbe}
              onSend={session.start}
              cwd={cwd}
              onCwdChange={setCwdPersist}
              isRemote={Boolean(targetId)}
              newSessionHint={newSessionHint}
            />
          ) : (
            <MessageList
              messages={view.messages}
              resolved={view.resolved}
              running={view.running}
              onRespond={(id, decision, reason, answers) =>
                void session.respond(id, decision, reason, answers)
              }
            />
          )}
        </div>
      </div>

      <Composer
        onSend={session.start}
        running={view.running || session.busy}
        onInterrupt={() => void session.interrupt()}
        placeholder={
          session.pending.length > 0 ? "先处理上面的审批，再继续…" : "给 CC 发消息…"
        }
        queueCount={session.queue.length}
        onClearQueue={session.clearQueue}
        onPolish={onPolish}
        polishing={polishing}
      />
    </div>
  );
}
