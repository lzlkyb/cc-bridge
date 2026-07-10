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

export function useToast() {
  return useContext(ToastContext);
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

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast 容器：右上角固定定位 */}
      <div className="fixed right-4 top-16 z-[999] flex flex-col gap-2 pointer-events-none">
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

  return (
    <div
      onClick={onDismiss}
      className={`pointer-events-auto flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm font-medium shadow-lg backdrop-blur-md cursor-pointer select-none transition-all duration-300 ${
        variantStyles[item.variant]
      } ${
        visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
      }`}
      style={{ maxWidth: 380 }}
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
