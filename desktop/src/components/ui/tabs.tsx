import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { createContext, useContext } from "react";

interface TabsProps {
  defaultValue: string;
  children: ReactNode;
  className?: string;
}

interface TabsContextValue {
  active: string;
  setActive: (v: string) => void;
  registerTrigger: (value: string, el: HTMLElement | null) => void;
}

const TabsContext = createContext<TabsContextValue>({
  active: "",
  setActive: () => {},
  registerTrigger: () => {},
});

export function Tabs({ defaultValue, children, className = "" }: TabsProps) {
  const [active, setActive] = useState(defaultValue);
  const triggerRefs = useRef<Map<string, HTMLElement>>(new Map());

  const registerTrigger = useCallback((value: string, el: HTMLElement | null) => {
    if (el) {
      triggerRefs.current.set(value, el);
    } else {
      triggerRefs.current.delete(value);
    }
  }, []);

  return (
    <TabsContext.Provider value={{ active, setActive, registerTrigger }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/** Segmented pill 容器：等分撑满整行，带滑动高亮指示器 */
export function TabsList({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { active } = useContext(TabsContext);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  // 监听 active 变化时重新计算指示器位置
  const updateIndicator = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    // 通过 data-value 属性查找当前激活的 trigger
    const activeBtn = list.querySelector(`[data-value="${active}"]`) as HTMLElement | null;
    if (!activeBtn) return;
    const listRect = list.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    setIndicatorStyle({
      left: btnRect.left - listRect.left,
      width: btnRect.width,
    });
  }, [active]);

  useEffect(() => {
    // 初始渲染后计算
    const raf = requestAnimationFrame(updateIndicator);
    return () => cancelAnimationFrame(raf);
  }, [updateIndicator]);

  // 窗口大小变化时重算
  useEffect(() => {
    const onResize = () => requestAnimationFrame(updateIndicator);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateIndicator]);

  return (
    <div ref={listRef} className={`relative flex w-full gap-0.5 rounded-xl bg-secondary p-1 ${className}`}>
      {/* 滑动指示器 — 绝对定位的高亮块，带 transform 过渡 */}
      <div
        className="absolute top-1 h-[calc(100%-8px)] rounded-lg bg-card shadow-sm transition-all duration-250 ease-out pointer-events-none"
        style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
      />
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children, className = "" }: { value: string; children: ReactNode; className?: string }) {
  const { active, setActive, registerTrigger } = useContext(TabsContext);
  const isActive = active === value;
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerTrigger(value, btnRef.current);
    return () => registerTrigger(value, null);
  }, [value, registerTrigger]);

  return (
    <button
      ref={btnRef}
      data-value={value}
      onClick={() => setActive(value)}
      className={`relative z-[1] flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-200 ${
        isActive
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children, className = "" }: { value: string; children: ReactNode; className?: string }) {
  const { active } = useContext(TabsContext);
  if (active !== value) return null;
  return <div className={`animate-fade-in ${className}`}>{children}</div>;
}
