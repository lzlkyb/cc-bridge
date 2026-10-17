import { useState, useCallback, useEffect, useRef, createContext, useContext, type ReactNode } from "react";
import { Icon } from "./icon";
import { usePresence } from "../../hooks/usePresence";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useAppHidden } from "../../lib/appVisibility";

type ToastVariant = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

/**
 * Toast 文案规范（UI 精修统一约定，调用方请遵守）：
 *  - success：操作成功类（"已复制" / "已还原到操作前版本"），用 check 图标
 *  - error：  失败/异常类（"复制失败：…" / 接口报错），用 alertTriangle 图标
 *  - warning：需提醒但非阻断（保留）
 *  - info：   中性提示（保留）
 * 约定：文案简洁、动宾结构；成功态不重复写"成功"二字（图标已表达）。
 *
 * 统一通知方案升级（design/统一通知系统设计稿.html）：
 *  - 容器从 top-16 移到右下角（远离主操作区，不遮 Header / 横幅区）；
 *  - 图标带语义底色块，底部倒计时与实际驻留同步；悬停/聚焦时暂停，关闭统一退场。
 */
export function useToast() {
  return useContext(ToastContext);
}

// 模块级单例：供非组件代码（如 lib/tauri.ts 的 invokeOrToast）直接调用 toast。
// 由 ToastProvider 挂载时写入实现；未挂载时调用为 no-op。
let toastImpl: ((message: string, variant?: ToastVariant) => void) | null = null;

export function toast(message: string, variant: ToastVariant = "info") {
  toastImpl?.(message, variant);
}

let toastId = 0;
const TOAST_LIFETIME = 3500;

// 文字用 -ink 变体：基础语义色在 12–14px 淡底上只有 2.3–3.8:1（浅色），不达 AA 4.5:1。
// info 走 primary（浅色 5.33:1）本就达标，故保持基础色。
const variantStyles: Record<ToastVariant, string> = {
  success: "border-success/30 bg-success/10 text-success-ink",
  error: "border-destructive/30 bg-destructive/10 text-destructive-ink",
  warning: "border-warning/30 bg-warning/10 text-warning-ink",
  info: "border-primary/30 bg-primary/10 text-primary",
};

const variantIcons: Record<ToastVariant, string> = {
  success: "check",
  error: "alertTriangle",
  warning: "alertTriangle",
  info: "activity",
};

const variantIconBoxes: Record<ToastVariant, string> = {
  success: "bg-success/[0.14] text-success-ink",
  error: "bg-destructive/[0.14] text-destructive-ink",
  warning: "bg-warning/[0.14] text-warning-ink",
  info: "bg-accent text-primary",
};

const variantProgress: Record<ToastVariant, string> = {
  success: "bg-success",
  error: "bg-destructive",
  warning: "bg-warning",
  info: "bg-primary",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const stackRef = useAutoAnimateRM<HTMLDivElement>();

  const addToast = useCallback((message: string, variant: ToastVariant = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, variant }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // 将实现暴露给模块级单例（供非组件调用，如 invokeOrToast）
  useEffect(() => {
    toastImpl = addToast;
    return () => { if (toastImpl === addToast) toastImpl = null; };
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast 容器：右下角堆叠，z-[2000] 在 Header 之上，错误项用 role=alert 走 assertive 播报 */}
      <div
        ref={stackRef}
        className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex flex-col gap-2 toast-stack"
        role="region"
        aria-label="通知"
        aria-live="polite"
      >
        {toasts.map((t) => (
          // FLIP 只移动槽位，避免覆盖通知自身的 transform 进退场。
          <div key={t.id}><ToastItemView item={t} onDismiss={removeToast} /></div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItemView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [open, setOpen] = useState(true);
  const [interaction, setInteraction] = useState({ hover: false, focus: false });
  const { mounted, entered } = usePresence(open);
  const hidden = useAppHidden();
  const paused = interaction.hover || interaction.focus || hidden;
  const remaining = useRef(TOAST_LIFETIME);

  // 计时归通知自身所有：手动关闭、卸载及暂停均清理同一个时钟。
  useEffect(() => {
    if (!open || paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setOpen(false), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [open, paused]);

  useEffect(() => { if (!mounted) onDismiss(item.id); }, [mounted, item.id, onDismiss]);

  if (!mounted) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      onMouseEnter={() => setInteraction(v => ({ ...v, hover: true }))}
      onMouseLeave={() => setInteraction(v => ({ ...v, hover: false }))}
      onFocusCapture={() => setInteraction(v => ({ ...v, focus: true }))}
      onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setInteraction(v => ({ ...v, focus: false })); }}
      data-state={entered ? "open" : "closed"}
      data-exiting={!open || undefined}
      role={item.variant === "error" ? "alert" : "status"}
      className={`pointer-events-auto relative flex w-[320px] max-w-[calc(100vw-2rem)] cursor-pointer select-none items-start gap-2.5 overflow-hidden rounded-lg border px-3.5 pb-3.5 pt-3 text-sm font-medium shadow-pop backdrop-blur-md toast ${
        item.variant === "error" ? "err" : item.variant === "warning" ? "warn" : ""
      } ${variantStyles[item.variant]}`}
    >
      <span
        className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg ${variantIconBoxes[item.variant]}`}
      >
        <Icon name={variantIcons[item.variant] as any} size={15} />
      </span>
      <span className="min-w-0 flex-1 break-words py-1 leading-snug">{item.message}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        aria-label="关闭"
      >
        <Icon name="close" size={12} />
      </button>
      {/* CSS 与 JS 共用暂停条件，剩余时间不会在阅读通知时悄悄流逝。 */}
      <span
        aria-hidden
        className={`toast-countdown absolute bottom-0 left-0 h-[2.5px] rounded-full ${variantProgress[item.variant]}`}
        style={{ animationDuration: `${TOAST_LIFETIME}ms`, animationPlayState: paused || !open ? "paused" : "running" }}
      />
    </div>
  );
}
