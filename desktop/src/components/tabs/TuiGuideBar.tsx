import { useEffect, useState } from "react";

/** 引导条可见时长（秒），到点自动收起为状态栏「!」小徽章。 */
const GUIDE_VISIBLE_SEC = 10;
const RING_CIRC = 2 * Math.PI * 10.5; // r=10.5 → 周长（与 ui/notice.tsx 倒计时环同参数）

interface Props {
  /** 本会话内滚轮归属切换次数（展示用）。 */
  flips: number;
  /** 「一键切换 fullscreen」→ 打开发送确认（confirm 步），不直接发。 */
  onSend: () => void;
  /** 「不再提示」→ 永久压掉引导条（localStorage）。 */
  onDismiss: () => void;
  /** 倒计时到点：收起为状态栏「!」小徽章，不抢焦点。 */
  onCollapse: () => void;
}

/**
 * 滚轮归属翻转引导条（设计稿屏4）：本会话归属态切换 ≥2 次时出现在工具栏下方。
 * 复用 InlineNotice 的 warning 语感（warning 色调 + 倒计时环），但行为是
 * 「10s 后收起为小徽章」而非 ActionCard 的「收起为细条常驻」，故单独成组件。
 */
export function TuiGuideBar({ flips, onSend, onDismiss, onCollapse }: Props) {
  const [remain, setRemain] = useState(GUIDE_VISIBLE_SEC);

  // 10s 倒计时：到点 onCollapse（父级把 guide 置为 collapsed）。onCollapse 由 hook
  // 用 setState 包装、引用稳定，effect 不会重跑重置倒计时。
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((GUIDE_VISIBLE_SEC * 1000 - (Date.now() - start)) / 1000));
      setRemain(left);
      if (left <= 0) {
        window.clearInterval(id);
        onCollapse();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [onCollapse]);

  return (
    <div
      role="status"
      className="mx-2 mt-2 flex items-center gap-2.5 rounded-[calc(var(--radius)+2px)] border border-warning/35 bg-warning/[0.08] p-2.5 text-warning-foreground"
    >
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-warning/[0.14] text-[15px] font-bold text-warning"
      >
        !
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold">滚轮归属已切换 {flips} 次，忽内忽外多半源于此</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Claude Code 在 fullscreen 与经典渲染器间切换时，滚轮的去处会跟着变。运行一次{" "}
          <b>/tui fullscreen</b> 锁定后即恒定转发；也可按 <b>Shift</b>+滚轮随时强制滚本地历史。
        </p>
      </div>
      <span className="relative h-[26px] w-[26px] shrink-0" aria-hidden>
        <svg viewBox="0 0 26 26" className="h-full w-full -rotate-90">
          <circle cx="13" cy="13" r="10.5" fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="13"
            cy="13"
            r="10.5"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-warning transition-[stroke-dashoffset] duration-300 ease-linear"
            strokeDasharray={RING_CIRC}
            strokeDashoffset={RING_CIRC * (1 - remain / GUIDE_VISIBLE_SEC)}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-[9px] font-bold tabular-nums text-muted-foreground">
          {remain}
        </span>
      </span>
      <div className="flex shrink-0 flex-col gap-1.5">
        <button
          type="button"
          onClick={onSend}
          className="rounded-lg bg-primary px-3 py-1 text-[11.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          一键切换 fullscreen
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border px-3 py-1 text-[11.5px] font-medium transition-colors hover:bg-muted"
        >
          不再提示
        </button>
      </div>
    </div>
  );
}
