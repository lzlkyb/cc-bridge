import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";

/** 引导条可见时长（秒），到点自动收起为状态栏「!」小徽章。 */
const GUIDE_VISIBLE_SEC = 10;

interface Props {
  /** 本会话内滚轮归属切换次数（展开区展示用）。 */
  flips: number;
  /** 「一键切换 fullscreen」→ 打开发送确认（confirm 步），不直接发。 */
  onSend: () => void;
  /** 「✕ 不再提示」→ 永久压掉引导条（localStorage）。 */
  onDismiss: () => void;
  /** 倒计时到点：收起为状态栏「!」小徽章，不抢焦点。 */
  onCollapse: () => void;
}

/**
 * 滚轮归属翻转引导条 —— 方案 A+（单行摘要 + 点击展开，2026-10-14 重写）。
 *
 * 由父级渲染为画布顶部**覆盖层**（absolute，不占布局高度——占高度会触发
 * fit→远端 TUI 重排，见 SshTerminal.tsx），10s 后收起为状态栏「!」小徽章。
 *
 * 相对旧版（62px 两行 + 竖排双按钮 + 26px 倒计时环）的改动：
 * 1. 压成**单行 36px**，副文案可截断；详情收进可展开区（`grid-rows 0fr↔1fr`）。
 * 2. 标题改用户视角文案「滚轮有时不灵？」，不再出现「两边都不接的去处」这种内部术语
 *    （「两边」= 本地/应用，用户没有这个坐标系）。
 * 3. 倒计时**保持可见**：右侧秒数（精确可读）+ 底部 2px 通宽进度线（节奏感）。
 *    旧版环内 9px 数字已到可读下限，改环为线后**必须补一个能读出剩余时间的数字**，
 *    否则用户只知道「快没了」而不知道还有几秒（用户反馈：「倒计时没看到了」）。
 * 4. 指针悬停即**暂停**倒计时：正在读就不倒数。
 *
 * 文案统一「本地 ←→ 应用」一对轴（critique P2-1：勿再引入「内/外」等第三套词汇）。
 *
 * 两条踩过的坑（2026-10-13 修，勿回退）：
 * 1. **底色必须不透明**。这是盖在 xterm 画布上的浮层，半透明底会让终端文字整片透上来，
 *    与提示文字叠成一片（肉眼即「两行字糊在一起」）。设计稿给的是实色 warn-soft，不是 tint。
 * 2. **外层的定位壳要 `pointer-events-none`**（见 SshTerminal.tsx）。壳带 `p-2`，若它可命中
 *    事件，终端顶部就会多出一条看不见、点不到、选不中的横带。
 */
export function TuiGuideBar({ flips, onSend, onDismiss, onCollapse }: Props) {
  const [remain, setRemain] = useState(GUIDE_VISIBLE_SEC);
  const [paused, setPaused] = useState(false);
  const [open, setOpen] = useState(false);
  // onCollapse / paused 走 ref：倒计时 effect 只跑一次，闭包要读到最新值，且不能因父级
  // 重渲染换了引用而重跑（重跑会重置倒计时）。paused 用 ref 才能被 interval 读到。
  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // 10s 倒计时（可暂停）：到点 onCollapse（父级把 guide 置为 collapsed）。
  useEffect(() => {
    let left = GUIDE_VISIBLE_SEC * 1000;
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      if (!pausedRef.current) left = Math.max(0, left - (now - last));
      last = now;
      setRemain(Math.ceil(left / 1000));
      if (left <= 0) {
        window.clearInterval(id);
        onCollapseRef.current();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  const pct = Math.max(0, Math.min(1, remain / GUIDE_VISIBLE_SEC)) * 100;

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      // 🔴 底色必须**不透明**：本组件是覆盖在 xterm 画布上的浮层（见 SshTerminal.tsx 的
      // 渲染处），原来写 `bg-warning/[0.08]`（8% 透明）→ 终端文字整片透上来，两层文字叠在
      // 一起不可读（用户报的就是这个）。设计稿给的是不透明 warn-soft（亮 #fdf0d9 / 暗
      // #332a17），这里用 color-mix 在卡片底上调出同款并自动随主题走。
      // 文字色取 `-ink`（"12% 淡底 + 小字"专用，浅色加深 / 深色提亮）；`-foreground` 是
      // 「实底上的字」，深色主题下是近黑（240 6% 10%），在本件的浅底上等于黑字黑底。
      className="animate-fade-in pointer-events-auto relative overflow-hidden rounded-[calc(var(--radius)+2px)] border border-warning/35 text-warning-ink shadow-lg"
      style={{ background: "color-mix(in srgb, hsl(var(--warning)) 9%, hsl(var(--card)))" }}
    >
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <span
          aria-hidden
          // 复用全站通知原语的脉冲节奏（index.css 的 .notice-pulse），与 toast 同呼吸。
          className="notice-pulse grid h-6 w-6 shrink-0 place-items-center rounded-md bg-warning/[0.16]"
        >
          <Icon name="sparkles" size={13} />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[12.5px] font-semibold">滚轮有时不灵？</span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            发一次 <b>/tui fullscreen</b> 即可锁定
          </span>
        </div>
        {/* 倒计时第一位：右侧秒数。暂停（悬停）时降为中性色，让「停了」看得见。 */}
        <span
          title={paused ? "倒计时已暂停（移开鼠标继续）" : "10 秒后收起为状态栏徽章"}
          className={
            "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums transition-colors " +
            (paused ? "bg-muted text-muted-foreground" : "bg-warning/[0.16] text-warning-ink")
          }
        >
          {remain}s
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "收起说明" : "展开说明"}
          title={open ? "收起说明" : "展开说明"}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-warning/[0.12] hover:text-warning-ink"
        >
          <Icon
            name="chevronDown"
            size={14}
            className={"transition-transform duration-300 " + (open ? "rotate-180" : "")}
          />
        </button>
        <button
          type="button"
          onClick={onSend}
          className="shrink-0 rounded-lg bg-primary px-3 py-1 text-[11.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          一键切换
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="不再提示"
          title="不再提示"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-warning/[0.12] hover:text-warning-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 展开区：`grid-rows 0fr↔1fr` 平滑开合（ui/notice.tsx 同款机制）。缩进 pl-11 对齐
          图标右侧（px-2.5=10 + 图标 24 + gap 10 = 44px）；外层 overflow-hidden 兜住。 */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="px-2.5 pb-2.5 pl-11 text-[11.5px] leading-relaxed text-muted-foreground">
            本会话滚轮归属已切换 {flips} 次。Claude Code 在 fullscreen 与经典渲染器间切换时，滚轮的去处会跟着变——忽而在{" "}
            <b>本地</b>、忽而在 <b>应用</b>，偶尔落在两边都不接的去处。运行一次 <b>/tui fullscreen</b> 锁定后即恒定转发；也可按{" "}
            <b>Shift</b>+滚轮随时强制滚本地历史。
          </p>
        </div>
      </div>

      {/* 倒计时第二位：底部 2px 通宽进度线（细腻、不抢视线）。与右侧秒数双保险，
          是因为线只给「大概还剩多少」，给不出「还有几秒」。 */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-[2px] bg-warning/70 transition-[width] duration-200 ease-linear"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
