import type { ReactNode } from "react";

/**
 * 子设置容器：缩进 + 左侧竖线，表示「这几项属于上面那个开关」。
 *
 * 为何需要它：之前壳层选择与「命令执行」隔了 3 个开关、审计保留天数与
 * 「审计日志」隔了 4 张卡，于是关掉父开关后子项依旧可改——看不出两者有关。
 * 现在子项紧跟父开关，并在 `disabled` 时整块置灰。
 *
 * 禁用实现（信息架构重排设计稿屏 4，修伪禁用）：用原生 `<fieldset disabled>`
 * ——它**语义级**禁用全部后代表单控件（button/input/select/textarea）：
 * 不可聚焦（键盘 Tab 直接跳过）、不可点击激活、读屏播报禁用；恢复时自动
 * 还原各控件自身的 disabled 状态。旧版只有 `pointer-events-none`，只挡鼠标
 * ——键盘 Tab 仍能进入并真实保存，界面说「暂不生效」系统说「已保存」。
 * fieldset 替代了逐控件置 disabled + tabIndex=-1 的手工遍历（React 18.3 无
 * inert 属性，DOM 遍历方案还得自己记账恢复，极易漏）。
 *
 * `disabled` **不代替后端约束**：后端依然自己判断开关状态，前端置灰仅为了
 * 不让用户调一个不生效的参数。`pointer-events-none` 保留作双保险。
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
      {/* fieldset 的 UA 默认样式（边框/内边距/min-inline-size）全部重置到视觉中性，
          替换掉原来的 div；disabled 由浏览器语义化下发。 */}
      <fieldset
        disabled={disabled || undefined}
        className={`m-0 min-w-0 border-0 p-0 ${disabled ? "pointer-events-none opacity-45" : ""}`}
        aria-disabled={disabled || undefined}
      >
        {children}
      </fieldset>
      {disabled && hint && (
        <p className="pb-2 text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
