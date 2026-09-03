import { Icon } from "../ui/icon";

/** 还没有任何终端会话时右侧的空态。 */
export function TerminalEmptyState({
  collapsed,
  onExpand,
}: {
  collapsed: boolean;
  onExpand: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <div className="text-center">
        <Icon name="terminal" size={28} className="mx-auto mb-2 opacity-50" />
        {/* 折叠态下左侧只剩一条 48px 窄条，再说「从左侧选择」就是指不到东西 */}
        {collapsed ? (
          <>
            <div>还没有打开的终端</div>
            <button
              type="button"
              onClick={onExpand}
              className="mt-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
            >
              展开连接列表
            </button>
          </>
        ) : (
          "从左侧选择一个连接开始"
        )}
      </div>
    </div>
  );
}
