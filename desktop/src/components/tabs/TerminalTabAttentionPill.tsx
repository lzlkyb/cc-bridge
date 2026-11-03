import type { SshSessionRef } from "./TerminalConnectionItem";
import { programStateLabel } from "../../lib/terminalProgramStatus";
import {
  nextTabInRing,
  tabAttentionSummary,
  type TermTabMeta,
} from "../../lib/terminalTabMeta";

/**
 * 标签栏右端的汇总药丸（G5，2026-11-02；两档化 2026-11-03）。
 *
 * 存在的理由：标签一多就要横向滚动，而琥珀点可能就滚在视野外——徽标解决的是
 * 「切过去要看得见」，药丸解决的是「不切也知道有几个、而且一键能到」。所以它**必须可点**：
 * 只报数字等于把「滚动找琥珀点」这份活又还给用户，等于没解决。
 *
 * 位置在滚动区**之后**、操作按钮**之前**：它汇总的是标签，不是操作。
 *
 * **两档分开而不是合成一个数**：它们要的动作不同（一个去看、一个去重连），颜色不同
 * （琥珀＝程序在等你 / 红＝连接没了），合成「3 个待处理」会让用户点进去发现有一个根本不能处理。
 * 计数与分档都收在 `lib/terminalTabMeta.ts::tabAttentionSummary()`，这里只负责画和跳。
 *
 * WHY 独立成组件：`TerminalTabsBar` 长期贴 300 行体量棘轮线，塞进去就是逼下一个人越界。
 */
export function TerminalTabAttentionPill({
  tabs,
  metaBySession,
  activeId,
  onActivate,
}: {
  /** 已滤掉分屏副格的标签（副格不占标签位，计进来会让数字与看到的标签数不符）。 */
  tabs: readonly SshSessionRef[];
  metaBySession: Record<string, TermTabMeta>;
  activeId: string | null;
  onActivate: (sessionId: string) => void;
}) {
  const { attention, disconnected } = tabAttentionSummary(
    tabs.map((s) => ({ sessionId: s.sessionId, closed: !!s.closedReason })),
    metaBySession,
  );
  // 两档都空就整块消失，不留灰态：灰掉的 0 是纯噪声。
  if (attention.length === 0 && disconnected.length === 0) return null;

  const nameOf = (id: string) => {
    const s = tabs.find((t) => t.sessionId === id);
    return s?.label || s?.conn.name || s?.conn.host || "会话";
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {attention.length > 0 && (
        <Pill
          tone="warn"
          count={attention.length}
          label="待处理"
          // 数字说「有几个」，tooltip 说「哪几个、什么事」——省掉一次为了搞清情况而做的跳转。
          items={attention.map((id) => {
            const agent = metaBySession[id]?.agent;
            const state = agent ? programStateLabel(agent) : null;
            return state ? `${nameOf(id)} ${state}` : nameOf(id);
          })}
          hint="点击跳到下一个"
          onClick={() => {
            const next = nextTabInRing(attention, activeId);
            if (next) onActivate(next);
          }}
        />
      )}
      {disconnected.length > 0 && (
        <Pill
          tone="danger"
          count={disconnected.length}
          label="已断开"
          items={disconnected.map(nameOf)}
          hint="点击跳到下一个（可重连）"
          onClick={() => {
            const next = nextTabInRing(disconnected, activeId);
            if (next) onActivate(next);
          }}
        />
      )}
    </div>
  );
}

/** 两个尺度的颜色都在这里，别在渲染处散着写：琥珀＝程序在等你，红＝连接没了。 */
const TONE = {
  warn: {
    box: "border-amber-500/30 bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  danger: {
    box: "border-destructive/30 bg-destructive/10 text-destructive-ink hover:bg-destructive/20",
    dot: "bg-destructive",
  },
} as const;

function Pill({
  tone,
  count,
  label,
  items,
  hint,
  onClick,
}: {
  tone: keyof typeof TONE;
  count: number;
  label: string;
  items: string[];
  hint: string;
  onClick: () => void;
}) {
  const text = `${count} 个${label}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${text}：\n${items.join("\n")}\n${hint}`}
      aria-label={`${text}，${hint}：${items.join("、")}`}
      className={`terminal-tab-pill flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${TONE[tone].box}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone].dot}`} aria-hidden="true" />
      {text}
    </button>
  );
}
