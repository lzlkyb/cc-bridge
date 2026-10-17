import { useState, useCallback, createContext, useContext, type ReactNode } from "react";
import { ActivityPanel } from "./ActivityPanel";

interface TabsProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  children: ReactNode;
  className?: string;
}

interface TabsContextValue {
  active: string;
  setActive: (v: string) => void;
}

const TabsContext = createContext<TabsContextValue>({
  active: "",
  setActive: () => {},
});

export function Tabs({ defaultValue, value: controlledValue, onValueChange, children, className = "" }: TabsProps) {
  const [internalActive, setInternalActive] = useState(defaultValue ?? "");
  const isControlled = controlledValue !== undefined;
  const active = isControlled ? controlledValue : internalActive;

  const setActive = useCallback(
    (v: string) => {
      if (!isControlled) setInternalActive(v);
      onValueChange?.(v);
    },
    [isControlled, onValueChange],
  );

  return (
    <TabsContext.Provider value={{ active, setActive }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsContent({ value, children, className = "", keepMounted = false }: { value: string; children: ReactNode; className?: string; keepMounted?: boolean }) {
  const { active } = useContext(TabsContext);
  if (keepMounted) return <ActivityPanel active={active === value} data-page-panel data-page-motion={value === "terminal" ? "fade" : "slide"} data-scroll-viewport className={`animate-tab-in ${className}`}>{children}</ActivityPanel>;
  if (active !== value) return null;
  return <div data-page-panel data-page-motion={value === "terminal" ? "fade" : "slide"} className={`animate-tab-in ${className}`}>{children}</div>;
}
