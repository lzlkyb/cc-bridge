import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";

/**
 * 顶栏挂起胶囊（方案 A，2026-10-17，design/2026-10-17-倒计时归零挂起胶囊-设计稿.html）：
 * 连接页 IP 横幅的 60s 倒计时归零且用户还没复制时，命令「升级」为顶栏常驻胶囊——
 * 住 Header 中段现成空白拖拽区，**所有页面可见**、点一下直接复制，解决
 * 「横幅细条只在连接页、切页就看不见」的痛点。
 *
 * 生命周期（App 层持有 pendingCmd 单一真源）：
 *  挂起（IpChangedBanner onSuspend）→ 点胶囊复制 → 变绿「✓ 已复制」→ 1.4s 后
 *  淡出 → onResolved（= handleSedResolved 收口）→ App 清 pendingCmd 卸载。
 *  与横幅细条互斥（同一状态的两种呈现，挂起中细条不渲染）；与 UpdateReadout
 *  （更新下载读数）互斥走 index.css 兄弟选择器，读数在场胶囊暂避。
 *
 * 顶栏约束（UI.md 字形带）：24px 高居中于 52px 顶栏，11px 字形落在 y≈21–32，
 * 在字形带 18–34 内，不切任何控件字形。中段是 data-tauri-drag-region 拖拽区，
 * 按钮必须显式 `data-tauri-drag-region="false"` 才可点（同 TitleBarControls）。
 *
 * 为什么外层是 span 而不是 button（审查 U3）：胶囊需要一个「忽略」× 出口，
 * 而 button 里不能套 button。外层 span 承接 .pending-pill 的视觉（边框/底色/圆角），
 * 内部两个真 button 各自可点、可聚焦。
 */
export function PendingCommandPill({
  pending,
  onResolved,
  onDismiss,
}: {
  pending: { ip: string; cmd: string };
  onResolved: () => void;
  /** 忽略本次提示（= App 的 handleDismissIpChange）：不复制、直接收走。 */
  onDismiss?: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "copied" | "closing">("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const handleClick = () => {
    if (phase !== "idle") return;
    // 乐观绿态（剪贴板 API 极快）；复制失败极罕见（非安全上下文/权限拒绝）——
    // 失败时撤掉收口定时器、回退 idle 让用户重试，绿态误导比无反馈更糟。
    // 同时补一条 error toast（审查 U3）：只把颜色弹回橙色，用户不知道「到底成没成」。
    setPhase("copied");
    copyText(
      pending.cmd,
      () => {},
      (e) => {
        timers.current.forEach((t) => window.clearTimeout(t));
        timers.current = [];
        setPhase("idle");
        toast(`复制失败：${String(e)}`, "error");
      },
    );
    timers.current.push(
      // 设计稿动画链：绿态驻留 1.4s（给「已复制」读清）→ 200ms 淡出 → 卸载收口。
      // onResolved 放在淡出完成后：App 清 state 卸载组件，不存在「啪地消失」。
      window.setTimeout(() => setPhase("closing"), 1400),
      window.setTimeout(() => onResolved(), 1650),
    );
  };

  const done = phase !== "idle";
  return (
    <span
      className={`pending-pill ml-auto flex h-6 shrink-0 animate-fade-in items-center rounded-full border transition-[opacity,transform,border-color,background-color] duration-200 ${
        done
          ? "border-success/50 bg-success/10 text-success-ink"
          : "border-warning/50 bg-warning/[0.12] text-warning-ink"
      } ${phase === "closing" ? "-translate-y-1 opacity-0" : ""}`}
    >
      <button
        type="button"
        data-tauri-drag-region="false"
        onClick={handleClick}
        title={done ? "命令已复制，到远程 AI 工具侧粘贴执行" : `复制 IP 修复命令（${pending.ip}）`}
        aria-live="polite"
        className={`pending-pill-main flex h-full min-w-0 items-center gap-1.5 rounded-full pl-2.5 pr-2 text-[11px] font-semibold ${
          done ? "" : "hover:bg-warning/20"
        }`}
      >
        <Icon name={done ? "check" : "alertTriangle"} size={12} className="shrink-0" />
        {/* ≤900px 截断 IP；≤740px 收成纯图标（不再整条隐藏——560px 最小窗宽真实可达，
            整条隐藏等于用户完全不知道 IP 变了，审查 U4） */}
        <span className="pending-pill-text max-w-[150px] truncate tabular-nums">
          {done ? "已复制，待执行" : `${pending.ip} · 复制命令`}
        </span>
      </button>
      {onDismiss && (
        <button
          type="button"
          data-tauri-drag-region="false"
          onClick={onDismiss}
          title="忽略本次提示（切到连接页可重新查看）"
          aria-label="忽略本次提示"
          className="pending-pill-x mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-foreground/10 hover:opacity-100"
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}
