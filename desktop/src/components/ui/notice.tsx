import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";

/**
 * 统一通知组件族（三级分级模型的 L2 / L3，见 design/统一通知系统设计稿.html）：
 *  - InlineNotice：页内上下文提示条（L2），统一替代各处手写的 warning/error 圆角块。
 *  - ActionCard  ：需用户行动的全局事件横幅（L3）。默认折叠为细条，关键操作
 *                  （复制命令）直接放在细条上、免展开一步完成；点击其余区域展开详情；
 *                  autoCollapseSec > 0 时带可视倒计时环，到 0 自动收起（细条常驻不消失）。
 * 配色只用语义 token（warning/destructive/success/primary），深浅主题天然适配；
 * 动效由 index.css 尾部的 prefers-reduced-motion 全局降级兜底。
 */

export type NoticeVariant = "info" | "warning" | "error" | "success";
type Tone = "warning" | "destructive" | "info";

const noticeStyles: Record<NoticeVariant, { box: string; icon: string; iconName: string }> = {
  info: {
    box: "border-primary/25 bg-accent text-accent-foreground",
    icon: "text-primary",
    iconName: "info",
  },
  warning: {
    box: "border-warning/35 bg-warning/[0.08] text-warning-foreground",
    icon: "text-warning",
    iconName: "alertTriangle",
  },
  error: {
    box: "border-destructive/35 bg-destructive/[0.08] text-destructive",
    icon: "text-destructive",
    iconName: "alertTriangle",
  },
  success: {
    box: "border-success/35 bg-success/[0.08] text-success",
    icon: "text-success",
    iconName: "check",
  },
};

/** L2 页内提示条：icon + 配色由组件内置，业务只传文案 */
export function InlineNotice({
  variant = "info",
  icon,
  className = "",
  children,
}: {
  variant?: NoticeVariant;
  icon?: string;
  className?: string;
  children: ReactNode;
}) {
  const s = noticeStyles[variant];
  return (
    <div
      role={variant === "error" ? "alert" : undefined}
      className={`flex items-start gap-2.5 rounded-[calc(var(--radius)+2px)] border p-3 text-[12.5px] leading-relaxed ${s.box} ${className}`}
    >
      <Icon name={(icon ?? s.iconName) as any} size={16} className={`mt-0.5 shrink-0 ${s.icon}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const toneStyles: Record<Tone, { bar: string; iconBox: string; title: string; pill: string }> = {
  warning: {
    bar: "border-warning/35 hover:border-warning/60",
    iconBox: "bg-warning/[0.14] text-warning",
    title: "text-warning-foreground",
    pill: "bg-warning/[0.13] text-warning",
  },
  destructive: {
    bar: "border-destructive/35 hover:border-destructive/60",
    iconBox: "bg-destructive/[0.14] text-destructive",
    title: "text-destructive",
    pill: "bg-destructive/[0.13] text-destructive",
  },
  info: {
    bar: "border-primary/30 hover:border-primary/60",
    iconBox: "bg-accent text-primary",
    title: "text-primary",
    pill: "bg-primary/10 text-primary",
  },
};

const RING_CIRC = 2 * Math.PI * 10.5; // r=10.5 → 周长 65.97

/** 倒计时进度环：resolved 变绿示意「已处理」 */
function CountdownRing({ remain, total, resolved, tone }: { remain: number; total: number; resolved: boolean; tone: Tone }) {
  const color = resolved ? "stroke-success" : tone === "destructive" ? "stroke-destructive" : "stroke-warning";
  return (
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
          className={`${color} transition-[stroke-dashoffset] duration-300 ease-linear`}
          strokeDasharray={RING_CIRC}
          strokeDashoffset={RING_CIRC * (1 - remain / Math.max(total, 1))}
        />
      </svg>
      <span
        className={`absolute inset-0 grid place-items-center text-[9px] font-bold tabular-nums ${
          resolved ? "text-success" : "text-muted-foreground"
        }`}
      >
        {resolved ? "✓" : remain}
      </span>
    </span>
  );
}

/** L3 行动卡：折叠细条（带直接复制）+ 平滑展开详情 */
export function ActionCard({
  tone = "warning",
  icon = "alertTriangle",
  title,
  pill,
  summary,
  autoCollapseSec = 0,
  defaultExpanded = false,
  resolved = false,
  copyLabel,
  onCopy,
  copyDisabled = false,
  onDismiss,
  children,
}: {
  tone?: Tone;
  icon?: string;
  title: ReactNode;
  pill?: string;
  summary?: ReactNode;
  /** >0 时展开态显示倒计时环，到 0 自动收起（细条常驻）；展开动作会重置倒计时 */
  autoCollapseSec?: number;
  defaultExpanded?: boolean;
  /** 外部标记「已处理」：环变绿、显示 ✓，此后不再倒计时 */
  resolved?: boolean;
  /** 传入即在细条上渲染复制按钮（免展开直接复制）；复制成功 flashes「已复制」 */
  copyLabel?: string;
  onCopy?: () => void;
  copyDisabled?: boolean;
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [remain, setRemain] = useState(autoCollapseSec);
  const [cycle, setCycle] = useState(0);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number>(0);
  const ts = toneStyles[tone];

  // 倒计时：每次展开（cycle 变化）重新计满；到 0 自动收起；resolved 后停止
  useEffect(() => {
    if (resolved || autoCollapseSec <= 0) return;
    setRemain(autoCollapseSec);
    const start = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((autoCollapseSec * 1000 - (Date.now() - start)) / 1000));
      setRemain(left);
      if (left <= 0) {
        window.clearInterval(id);
        setExpanded(false);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [resolved, autoCollapseSec, cycle]);

  const toggle = () => {
    setExpanded((e) => {
      if (!e && autoCollapseSec > 0 && !resolved) setCycle((c) => c + 1);
      return !e;
    });
  };

  const handleCopy = () => {
    if (!onCopy || copyDisabled) return;
    onCopy();
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  // resolved 后环保持显示并变绿 ✓（「已处理」反馈），仅停止倒计时
  const showRing = autoCollapseSec > 0;

  return (
    <div className={`animate-fade-in overflow-hidden rounded-[calc(var(--radius)+3px)] border bg-card shadow-card ${ts.bar}`}>
      {/* 折叠细条：整条可点展开；复制按钮独立、免展开 */}
      <div
        onClick={toggle}
        role={tone === "destructive" ? "alert" : undefined}
        className="flex cursor-pointer select-none items-center gap-2.5 py-2 pl-3 pr-2.5 transition-shadow duration-200 hover:shadow-pop"
      >
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${ts.iconBox} ${
            !resolved ? "notice-pulse" : ""
          }`}
        >
          <Icon name={icon as any} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`flex items-center gap-2 text-[13px] font-semibold ${ts.title}`}>
            <span className="truncate">{title}</span>
            {pill && (
              <span className={`shrink-0 rounded-full px-2 py-px text-[10px] font-bold ${ts.pill}`}>{pill}</span>
            )}
          </span>
          {summary && <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{summary}</span>}
        </span>
        {showRing && <CountdownRing remain={remain} total={autoCollapseSec} resolved={resolved} tone={tone} />}
        {copyLabel && onCopy && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            disabled={copyDisabled}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-all hover:-translate-y-px hover:shadow-card disabled:cursor-not-allowed disabled:opacity-40 ${
              copied || resolved
                ? "border-success/50 bg-success/10 text-success"
                : "border-warning/45 bg-warning/[0.09] text-warning-foreground hover:border-warning"
            } ${copied ? "animate-scale-in" : ""}`}
          >
            <Icon name={copied || resolved ? "check" : "copy"} size={12} />
            {copied ? "已复制" : copyLabel}
          </button>
        )}
        <Icon
          name="chevronDown"
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
        />
        {onDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            aria-label="关闭提示"
            title="本次会话忽略此提示"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      {/* 展开详情：grid-rows 0fr→1fr 平滑高度过渡 */}
      <div
        className={`grid transition-[grid-template-rows] duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t px-4 py-3.5 pl-[50px]">{children}</div>
        </div>
      </div>
    </div>
  );
}
