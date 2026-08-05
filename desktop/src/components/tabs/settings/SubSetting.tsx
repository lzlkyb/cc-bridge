import type { ReactNode } from "react";

/**
 * 子设置容器：缩进 + 左侧竖线，表示「这几项属于上面那个开关」。
 *
 * 为何需要它：之前壳层选择与「命令执行」隔了 3 个开关、审计保留天数与
 * 「审计日志」隔了 4 张卡，于是关掉父开关后子项依旧可改——看不出两者有关。
 * 现在子项紧跟父开关，并在 `disabled` 时整块置灰。
 *
 * `disabled` 只做视觉与交互拦截（`pointer-events-none`），**不代替后端约束**：
 * 后端依然自己判断开关状态，前端置灰仅为了不让用户调一个不生效的参数。
 */
export function SubSetting({
  children,
  disabled = false,
  hint,
}: {
  children: ReactNode;
  disabled?: boolean;
  /** 置灰原因，仅在 disabled 时展示 */
  hint?: string;
}) {
  return (
    <div className="ml-1 border-l-2 border-primary/25 pl-3.5">
      <div
        className={disabled ? "pointer-events-none opacity-45" : undefined}
        aria-disabled={disabled || undefined}
      >
        {children}
      </div>
      {disabled && hint && (
        <p className="pb-2 text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
