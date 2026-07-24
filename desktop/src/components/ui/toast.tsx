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

const variantStyles: Record<ToastVariant, string> = {
  success: "border-success/30 bg-success/10 text-success",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-primary/30 bg-primary/10 text-primary",
};

const variantIcons: Record<ToastVariant, string> = {
  success: "check",
  error: "alertTriangle",
  warning: "alertTriangle",
  info: "activity",
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
      {/* Toast 容器：右上角固定定位 */}
      <div className="fixed right-4 top-16 z-[2000] flex flex-col gap-2 pointer-events-none">
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
      className={`pointer-events-auto flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm font-medium shadow-pop backdrop-blur-md cursor-pointer select-none transition-all duration-300 max-w-[380px] ${
        variantStyles[item.variant]
      } ${
        visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
      }`}
    >
      <Icon name={variantIcons[item.variant] as any} size={15} className="shrink-0" />
      <span className="leading-snug">{item.message}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="ml-1 shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
