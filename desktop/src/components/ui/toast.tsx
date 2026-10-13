import { useState, useCallback, useEffect, createContext, useContext, type ReactNode } from "react";
import { Icon } from "./icon";

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
 *  - 图标带语义底色块，底部倒计时进度条，error 入场附带 shake 强调。
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

  const addToast = useCallback((message: string, variant: ToastVariant = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // 将实现暴露给模块级单例（供非组件调用，如 invokeOrToast）
  useEffect(() => {
    toastImpl = addToast;
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast 容器：右下角堆叠，z-[2000] 在 Header 之上，错误项用 role=alert 走 assertive 播报 */}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex flex-col gap-2 toast-stack"
        role="region"
        aria-label="通知"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastItemView key={t.id} item={t} onDismiss={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItemView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // 下一帧触发入场动画
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 退场：父级在 3500ms 移除前，于 3200ms 先触发滑出（与 transition duration-300 对齐），
  // 补齐此前缺失的退场动画（原 toast 只有进场、关闭是瞬间消失）。
  useEffect(() => {
    const hideTimer = window.setTimeout(() => setVisible(false), 3200);
    return () => window.clearTimeout(hideTimer);
  }, []);

  return (
    <div
      onClick={onDismiss}
      role={item.variant === "error" ? "alert" : undefined}
      className={`pointer-events-auto relative flex w-[320px] max-w-[calc(100vw-2rem)] cursor-pointer select-none items-start gap-2.5 overflow-hidden rounded-lg border px-3.5 pb-3.5 pt-3 text-sm font-medium shadow-pop backdrop-blur-md transition-all duration-300 toast ${
        item.variant === "error" ? "err animate-shake" : item.variant === "warning" ? "warn" : ""
      } ${variantStyles[item.variant]} ${visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"}`}
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
          onDismiss();
        }}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        aria-label="关闭"
      >
        <Icon name="close" size={12} />
      </button>
      {/* 倒计时进度条：3.5s 与父级移除时刻对齐；width 动画由全局减弱动效守卫降级 */}
      <span
        aria-hidden
        className={`absolute bottom-0 left-0 h-[2.5px] rounded-full ${variantProgress[item.variant]}`}
        style={{ animation: "toast-progress 3.5s linear forwards" }}
      />
    </div>
  );
}
