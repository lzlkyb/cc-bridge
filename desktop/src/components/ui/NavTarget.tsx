import type { KeyboardEvent, ReactNode } from "react";

/**
 * 可点击跳转的包装层。把无障碍与防误触集中写一次。
 *
 * 为何不直接给 div 加 onClick：那样会悄悄丢掉三件事——键盘不可达、读屏器不知道它能点、
 * 焦点没有可见环。四张卡 + 九个胶囊 + 三段链路共 16 处，逐处手写必漏。
 *
 * **用 div + `role="button"` 而不是真 `<button>`**：卡片内部已经有 `<button>`
 * （停止/重启、复制），而 button 嵌套 button 是非法 HTML，浏览器会把结构拆掉。
 */
export function NavTarget({
  onNavigate,
  tab,
  anchor,
  title,
  className = "",
  children,
}: {
  /** 不传则退化为纯展示（不可点、无指针、不进 Tab 焦点序列）。 */
  onNavigate?: (tab: string, anchor?: string) => void;
  tab: string;
  anchor?: string;
  /** 悬停提示。写成“去……”，让用户点前就知道会跳到哪。 */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  if (!onNavigate) return <div className={className}>{children}</div>;

  const go = () => onNavigate(tab, anchor);
  const onKeyDown = (e: KeyboardEvent) => {
    // 只拦 Enter / Space，且要 preventDefault——Space 默认会滚页。
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    go();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      onClick={go}
      onKeyDown={onKeyDown}
      className={`nav-target ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * 卡内交互元素的阻冒包装。
 *
 * 🔴 **为何必需**：整卡可点后，卡内的按钮 / 链接点击会**冒泡到卡片**，
 * 变成“点停止服务顺便跳了页”。`RunningCommandsCard` 里已有同样的处理。
 * 同时拦 keydown：否则在卡内按钮上敲空格会同时触发按钮和卡片跳转。
 */
export function StopClick({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
