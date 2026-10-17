import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
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
 */
export function PendingCommandPill({
  pending,
  onResolved,
}: {
  pending: { ip: string; cmd: string };
  onResolved: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "copied" | "closing">("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const handleClick = () => {
    if (phase !== "idle") return;
    // 乐观绿态（剪贴板 API 极快）；复制失败极罕见（非安全上下文/权限拒绝）——
    // 失败时撤掉收口定时器、回退 idle 让用户重试，绿态误导比无反馈更糟。
    setPhase("copied");
    copyText(
      pending.cmd,
      () => {},
      () => {
        timers.current.forEach((t) => window.clearTimeout(t));
        timers.current = [];
        setPhase("idle");
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
    <button
      type="button"
      data-tauri-drag-region="false"
      onClick={handleClick}
      title={done ? "命令已复制，到远程 AI 工具侧粘贴执行" : `复制 IP 修复命令（${pending.ip}）`}
      aria-live="polite"
      className={`pending-pill ml-auto flex h-6 shrink-0 animate-fade-in items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition-[opacity,transform,border-color,background-color] duration-200 ${
        done
          ? "border-success/50 bg-success/10 text-success-ink"
          : "border-warning/50 bg-warning/[0.12] text-warning-ink hover:border-warning hover:bg-warning/20"
      } ${phase === "closing" ? "-translate-y-1 opacity-0" : ""}`}
    >
      <Icon name={done ? "check" : "alertTriangle"} size={12} className="shrink-0" />
      {/* ≤900px 截断 IP（index.css），≤740px 整条隐藏——与 UpdateReadout 同一套退化曲线 */}
      <span className="pending-pill-text max-w-[150px] truncate tabular-nums">
        {done ? "已复制，待执行" : `${pending.ip} · 复制命令`}
      </span>
    </button>
  );
}
