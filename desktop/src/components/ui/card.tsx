import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card-lift rounded-xl border bg-card text-card-foreground shadow-card ${className}`} {...props} />;
}

export function CardHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex flex-col space-y-1.5 p-5 pb-3 ${className}`} {...props} />;
}

/** CardTitle：可选 icon 参数，渲染成靛蓝淡底圆角 chip（设计稿 D）*/
export function CardTitle({
  className = "",
  icon,
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { icon?: ReactNode }) {
  return (
    <h3 className={`flex items-center gap-2.5 text-[15px] font-semibold leading-none tracking-tight ${className}`} {...props}>
      {icon && <span className="title-chip">{icon}</span>}
      {children}
    </h3>
  );
}

export function CardContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 pb-5 ${className}`} {...props} />;
}
