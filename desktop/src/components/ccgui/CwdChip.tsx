import { useState } from "react";
import { Icon } from "../ui/icon";
import { CwdPicker } from "./CwdPicker";

/**
 * 会话条上的「工作目录」chip —— 点开可换。
 *
 * 单独成组件：`SessionBar` 已经贴到体量门禁，而这里只是「一个开关按钮 + 一个浮层」，
 * 与那一行里的其它东西没有状态往来。
 *
 * 🔴 它不只是「显示当前目录」：以前目录只能在空状态里改，说过第一句话之后这个 chip
 *    就变成了死文本 —— 想换个项目只能关会话重开，上下文一起丢。
 */
export function CwdChip({
  cwd,
  isRemote,
  hasMessages,
  onChange,
}: {
  /** 空串 = 跟随 CLI 默认（本机是家目录）。 */
  cwd: string;
  isRemote: boolean;
  /** 说过话的会话换目录 = 下一句另起一条（浮层里要说清）。 */
  hasMessages: boolean;
  onChange: (cwd: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative flex min-w-0 shrink-0 items-center">
      <button
        type="button"
        data-cc-toggle="cwd"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="工作目录（点击修改）"
        title={cwd || "默认目录 · 点击修改"}
        className={`flex min-w-0 items-center gap-1 rounded px-1 py-[2px] text-[11px] transition-colors hover:bg-muted/60 ${
          open ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Icon name="folder" size={11} className="shrink-0 opacity-70" />
        <span className="max-w-[220px] truncate font-mono">{cwd || "默认目录"}</span>
        <Icon name="chevronDown" size={10} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <CwdPicker
          value={cwd}
          isRemote={isRemote}
          hasMessages={hasMessages}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
