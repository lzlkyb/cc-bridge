import { useEffect, useRef, useState } from "react";

interface Props {
  initial: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
}

/**
 * 标签重命名的行内输入框（双击标签名出现）。
 *
 * WHY 需要：标签名此前只能来自连接名，而**改连接名不影响已开着的标签**——
 * 同一台机器开三个终端（一个 `tail -f`、一个编译、一个调试）时三个标签同名，
 * 分屏与 Ctrl+Tab 切换全靠猜。
 *
 * 语义：Enter / 失焦提交，Esc 取消，**清空 = 恢复默认名**（连接名或主机名）。
 * 不用 window.prompt：那是阻塞式系统弹窗，与 Tauri 风格割裂，也没法 Esc 取消。
 */
export function TabRenameInput({ initial, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      aria-label="重命名标签"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value.trim())}
      className="h-5 w-28 min-w-0 rounded border border-primary bg-background px-1 text-xs text-foreground outline-none"
    />
  );
}
