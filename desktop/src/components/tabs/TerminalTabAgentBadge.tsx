import { Icon } from "../ui/icon";
import type { ProgramStatus } from "../../lib/terminalProgramStatus";
import { tabAgentBadge, type TabAgentShape } from "../../lib/terminalTabAgent";

/** 形态 → 图标名。`dot` 是纯色圆点，不用图标，所以不在表里。 */
const ICON: Record<Exclude<TabAgentShape, "dot">, "spinner" | "check" | "alertTriangle"> = {
  spinner: "spinner",
  check: "check",
  alert: "alertTriangle",
};

/**
 * 标签上的 CC 运行态徽标（OSC 7501）。
 *
 * 存在的理由：多标签同时跑 Claude Code 时，状态栏里的那份状态只属于**当前可见的 pane**，
 * 「哪个标签在干活、哪个已经做完」在标签栏上完全看不出来。这个徽标就是那份状态的
 * 「常驻可见副本」——不断言、不打扰，只是让用户扫一眼标签栏就知道该切哪个。
 *
 * WHY 独立成组件：`TerminalTabsBar` 长期贴 300 行体量棘轮线，往里塞渲染逻辑就是逼下一个人
 * 越界；而且徽标的形态映射（`lib/terminalTabAgent.ts`）是可单测的纯计算，值得分开。
 *
 * 形态与取色的理由见 `lib/terminalTabAgent.ts` 头注；这里只管画。
 *
 * `unread` 决定「需要你看」的那一档（blocked / done / error）画多重：
 * 未读画实色、blocked 还带呼吸，已读压暗并停掉呼吸。这样跑一下午回来，标签栏上
 * 亮着的那几个就是真的还没看过的；看过的留一个淡标记，既不消失也不抢注意力。
 * `working` 的转圈不受影响（`needsAttention=false`）——它一直在干活，没有「读过」这回事。
 */
export function TerminalTabAgentBadge({
  agent,
  unread = false,
}: {
  agent?: ProgramStatus | null;
  /** 该会话自这条状态出现起还没被切过去看过（`TermTabMeta.agentUnread`）。 */
  unread?: boolean;
}) {
  const badge = tabAgentBadge(agent ?? null);
  if (!badge) return null;
  const dimmed = badge.needsAttention && !unread;
  // role="img" + aria-label：图标没有文字，读屏要能念出「运行中 / 等待确认 / 已完成」。
  // tooltip 用原生 title（与标签栏其它提示一致），内容含 CC 上报的 msg：它在问什么。
  if (badge.shape === "dot") {
    return (
      <span
        role="img"
        aria-label={badge.label}
        title={badge.tooltip}
        // 6px 圆点 + 3px 琥珀光晕 + 呼吸：这是「不处理就永远卡住」的那一档，必须最扎眼。
        // `motion-reduce:animate-none`：项目里 20+ 处 CSS 都尊重系统「减少动态效果」，
        // Tailwind 的 animate-* 默认不认，漏了就会给这类用户留一个永久呼吸的点。
        // 已读后停呼吸 + 淡光晕：还看得见「这里等你过」，但不再一直勾人。
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dimmed ? "opacity-50" : "animate-pulse motion-reduce:animate-none shadow-[0_0_0_3px_rgba(245,158,11,0.25)]"} ${badge.colorClass}`}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={badge.label}
      title={badge.tooltip}
      className={`flex h-3 w-3 shrink-0 items-center justify-center ${dimmed ? "opacity-45" : ""} ${badge.colorClass}`}
    >
      <Icon
        name={ICON[badge.shape]}
        size={12}
        // 同 dot：`animate-spin` 已被收托盘的 `[data-app-hidden]` 暂停清单覆盖，
        // 但系统级「减少动态效果」要单独加 motion-reduce（Tailwind 不默认尊重）。
        className={badge.spin ? "animate-spin motion-reduce:animate-none" : undefined}
      />
    </span>
  );
}
