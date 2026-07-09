import { useState, type ReactNode } from "react";

interface TabsProps {
  defaultValue: string;
  children: ReactNode;
  className?: string;
}

interface TabsContextValue {
  active: string;
  setActive: (v: string) => void;
}

import { createContext, useContext } from "react";

const TabsContext = createContext<TabsContextValue>({ active: "", setActive: () => {} });

export function Tabs({ defaultValue, children, className = "" }: TabsProps) {
  const [active, setActive] = useState(defaultValue);
  return (
    <TabsContext.Provider value={{ active, setActive }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/** Segmented pill 容器：等分撑满整行 */
export function TabsList({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex w-full gap-0.5 rounded-xl bg-secondary p-1 ${className}`}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children, className = "" }: { value: string; children: ReactNode; className?: string }) {
  const { active, setActive } = useContext(TabsContext);
  const isActive = active === value;
  return (
    <button
      onClick={() => setActive(value)}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
        isActive
          ? "bg-card text-primary shadow-sm"
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
