import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList } from "../../lib/types";
import {
  PERMISSION_MODE_RISK,
  type CcMessage,
  type CcPermissionMode,
  type CcSession,
} from "../../lib/ccGuiTypes";
import { useCcSession } from "../../hooks/useCcSession";
import { Icon } from "../ui/icon";
import { ApprovalCard } from "../ccgui/ApprovalCard";
import { CcEmptyState } from "../ccgui/CcEmptyState";
import { Composer } from "../ccgui/Composer";
import { MessageText } from "../ccgui/MessageText";
import { SessionBar } from "../ccgui/SessionBar";
import { verdictLabel } from "../ccgui/summarize";
import { ToolCard } from "../ccgui/ToolCard";

const MODE_KEY = "cc-bridge.ccgui.mode";
const cwdKey = (target: string) => `cc-bridge.ccgui.cwd.${target || "local"}`;

/**
 * 跳过提问时告诉模型的话。
 *
 * 不能只回一个空 deny —— `Verdict::deny` 的默认文案是「用户拒绝了这次调用，
 * 请换一种做法」，对提问来说会让模型以为选项被否掉，转头再来问一次。
 * 说清「跳过」它才会自己决定。
 */
const SKIP_ASK =
  "用户跳过了这个问题（没有选择任何选项）。请按你认为最合理的方式继续，不要重复提问。";

function readMode(): CcPermissionMode {
  const raw = localStorage.getItem(MODE_KEY);
  return raw === "plan" || raw === "default" || raw === "acceptEdits" || raw === "bypassPermissions"
    ? raw
    : "default";
}

/** 一行提示（重试 / 错误 / 缓冲溢出）。都是「内容」，不用 toast。 */
function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "info" | "warn" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const color =
    tone === "error"
      ? "border-destructive/35 bg-destructive/[.06] text-destructive-ink"
      : tone === "warn"
        ? "border-warning/35 bg-warning/[.06] text-warning-ink"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <div className={`flex shrink-0 items-start gap-1.5 border-b px-3 py-1.5 text-[11px] leading-[1.5] ${color}`}>
      <Icon name={tone === "info" ? "info" : "alertTriangle"} size={11} className="mt-[3px] shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100" title="关闭">
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}

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
  const [probing, setProbing] = useState(false);
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
    setCwd(localStorage.getItem(cwdKey(targetId)) ?? "");
  }, [targetId]);

  const session = useCcSession({
    connectionId: targetId || null,
    cwd: cwd.trim() || null,
    // 留空由 hook 内部的探测结果补：远端必须用绝对路径执行，
    // 而路径只有 probe 拿得到（这里不该再探一次）。
    claudePath: null,
    model: null,
    permissionMode: mode,
  });
  const { view } = session;

  const setCwdPersist = useCallback(
    (v: string) => {
      setCwd(v);
      localStorage.setItem(cwdKey(targetId), v);
    },
    [targetId],
  );

  const probe = session.runProbe;
  // 进页面 / 换目标时探一次。`probe` 是 useCallback 稳定的，不会反复触发。
  useEffect(() => {
    let alive = true;
    setProbing(true);
    void probe().finally(() => {
      if (alive) setProbing(false);
    });
    return () => {
      alive = false;
    };
  }, [probe, targetId]);

  const retryProbe = useCallback(() => {
    setProbing(true);
    void probe().finally(() => setProbing(false));
  }, [probe]);

  // 新内容贴底。ref 稳定，不进依赖。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view.messages, view.resolved]);

  const barSession: CcSession = {
    connection: targets.find((t) => t.id === targetId)?.label ?? "本机",
    cwd: cwd.trim(),
    branch: "",
    model: view.model ?? "默认模型",
    permissionMode: mode,
    inputTokens: view.inputTokens,
    outputTokens: view.outputTokens,
    costUsd: view.costUsd,
    running: view.running,
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
          localStorage.setItem(MODE_KEY, m);
        }}
        onSwitchTerminal={() => onNavigate("terminal")}
        onNewSession={() => void session.reset()}
      />

      {/* 🔴 bypassPermissions 下 can_use_tool 根本不触发，界面会「看起来很安静」——
          这条横幅是唯一能告诉用户「已经没有把关了」的地方，不能省。 */}
      {risk && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-warning/30 bg-warning/[.08] px-3 py-1.5 text-[11px] text-warning-ink">
          <Icon name="alertTriangle" size={11} className="shrink-0" />
          {risk}
        </div>
      )}

      {view.retry && (
        <Notice tone="warn">
          重试中 {view.retry.attempt}/{view.retry.max} · {view.retry.message}
        </Notice>
      )}
      {view.dropped > 0 && (
        <Notice tone="info">更早的 {view.dropped} 条事件已滚出缓冲，翻不到更上面了。</Notice>
      )}
      {view.error && (
        <Notice tone="error" onDismiss={session.clearError}>
          {view.error}
        </Notice>
      )}
      {lastStderr.length > 0 && (
        <Notice tone="error" onDismiss={session.clearError}>
          <span className="font-mono">{lastStderr.join(" / ")}</span>
        </Notice>
      )}

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
            />
          ) : (
            view.messages.map((m: CcMessage) => {
              if (m.kind === "user") {
                return (
                  <div key={m.id} className="flex justify-end">
                    {/* data-cc-bubble：玻璃阅读面上 primary/.12 会混成脏紫，改同色系高一档 */}
                    <div
                      data-cc-bubble
                      className="max-w-[86%] rounded-xl rounded-br-sm border border-border bg-muted/60 px-3 py-1.5"
                    >
                      <MessageText text={m.text} />
                    </div>
                  </div>
                );
              }
              if (m.kind === "assistant") {
                return (
                  <div key={m.id} className="flex gap-2">
                    <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-primary/10 text-primary">
                      <Icon name="sparkles" size={11} />
                    </span>
                    <div className="min-w-0 flex-1 pt-[1px]">
                      <MessageText text={m.text} />
                    </div>
                  </div>
                );
              }
              if (m.kind === "tool") return <ToolCard key={m.id} tool={m.tool} />;

              const verdict = view.resolved[m.id];
              if (verdict) {
                return (
                  <div
                    key={m.id}
                    data-cc-inset
                    className="flex items-center gap-1.5 rounded-[10px] border border-border bg-muted/40 px-3 py-[6px] text-[11px] text-muted-foreground"
                  >
                    <Icon name={verdict === "allow" ? "check" : "close"} size={11} />
                    <span className="font-mono">{m.toolName}</span>
                    {verdictLabel(m.toolName, verdict)}
                  </div>
                );
              }
              return (
                <ApprovalCard
                  key={m.id}
                  approval={m}
                  onAllow={() => void session.respond(m.id, "allow")}
                  onDeny={() =>
                    void session.respond(
                      m.id,
                      "deny",
                      m.toolName === "AskUserQuestion" ? SKIP_ASK : undefined,
                    )
                  }
                  onAnswer={(answers) =>
                    void session.respond(m.id, "allow", undefined, answers)
                  }
                />
              );
            })
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
      />
    </div>
  );
}
