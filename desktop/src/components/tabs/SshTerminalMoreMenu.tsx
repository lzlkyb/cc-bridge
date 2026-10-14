import { useState } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { Modal } from "../ui/Modal";

/**
 * 工具条「更多」下拉 + 终端快捷键面板（critique P2-2）。
 *
 * 从 SshTerminalToolbar 抽出：工具栏本体贴 300 行棘轮线，而快捷键面板需要
 * 一块自包含的新 UI——连同 ButtonIcon 一起迁到这里，工具栏反向引用本文件。
 *
 * 快捷键面板的动机（critique P2-2）：全部救急键此前只存在于各按钮的 hover
 * title 里，而最需要它们的键盘用户恰恰看不到 title。这里是唯一汇总处。
 * 清单必须与真实键位同步：改动键位时同步维护（来源：SshTerminal.tsx 键盘
 * 处理 / lib/terminalScroll.ts / useTerminalFontSize / TerminalTab）。
 */
const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "Ctrl+Shift+F", desc: "查找终端内容（Enter / Shift+Enter 切下/上一个）" },
  { keys: "Ctrl+Shift+↑ / ↓", desc: "跳到上一条 / 下一条命令的提示符行" },
  { keys: "Shift+Enter", desc: "输入框内换行（LF，Claude Code 多行输入）" },
  { keys: "Alt+Enter", desc: "换行并转义（ESC+CR）" },
  { keys: "Ctrl+Shift+C", desc: "复制选中" },
  { keys: "Ctrl+Shift+A", desc: "全选" },
  { keys: "Ctrl+V / Ctrl+Shift+V", desc: "粘贴文本 / 粘贴剪贴板图片到远端" },
  { keys: "Shift+滚轮", desc: "强制滚本地历史（TUI 全屏程序里救急）" },
  { keys: "Ctrl+滚轮", desc: "缩放字号（9–24px，全局生效）" },
  { keys: "Ctrl+Shift+B", desc: "折叠 / 展开会话侧栏" },
  { keys: "F11", desc: "终端全屏 / 退出全屏" },
  { keys: "Ctrl+K", desc: "全局命令面板（应用级）" },
];

export function MoreMenu({
  selectMode,
  onCopyScreen,
  onToggleSelectMode,
  onClear,
  onRepaint,
  onExport,
}: {
  selectMode: boolean;
  onCopyScreen: () => void;
  onToggleSelectMode: () => void;
  onClear: () => void;
  onRepaint: () => void;
  /** 导出整个滚动历史为 .txt（断开态也能用——读的是本地缓冲区）。 */
  onExport: () => void;
}) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  return (
    <>
      <Menu
        trigger={(open, toggle) => (
          <ButtonIcon title="更多" highlight={open} onClick={toggle}>
            <Icon name="more" size={14} />
          </ButtonIcon>
        )}
      >
        {(close) => (
          <>
            <MenuItem label="复制整屏" icon="monitor" onClick={() => { onCopyScreen(); close(); }} />
            <MenuItem
              label={selectMode ? "退出选择模式" : "选择模式"}
              hint={selectMode ? "恢复鼠标报告" : "拖选复制"}
              icon="sliders"
              active={selectMode}
              onClick={() => { onToggleSelectMode(); close(); }}
            />
            <MenuItem label="清屏" icon="refresh" onClick={() => { onClear(); close(); }} />
            <MenuItem
              label="强制重绘"
              hint="画面残影/花屏时用"
              icon="paintbrush"
              onClick={() => { onRepaint(); close(); }}
            />
            <MenuItem
              label="导出终端内容…"
              hint="滚动历史 → .txt"
              icon="download"
              onClick={() => { onExport(); close(); }}
            />
            <MenuItem
              label="快捷键"
              hint="全部键位一览"
              icon="info"
              onClick={() => { setShortcutsOpen(true); close(); }}
            />
          </>
        )}
      </Menu>
      {shortcutsOpen && <TerminalShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}

/** 快捷键一览面板：终端页全部键位的唯一汇总处（此前散落在 8 个 hover title 里）。 */
function TerminalShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} zIndex={60} className="mx-4 w-full max-w-md rounded-xl modal-surface p-5">
      <h4 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Icon name="info" size={16} className="text-primary" />
        终端快捷键
      </h4>
      <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="flex items-center gap-3 text-xs">
            <kbd className="shrink-0 whitespace-nowrap rounded border border-b-2 bg-background px-1.5 py-px font-mono text-[11px] text-foreground">
              {s.keys}
            </kbd>
            <span className="min-w-0 flex-1 leading-relaxed text-muted-foreground">{s.desc}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
        除 Ctrl+K 外，快捷键在终端聚焦时生效。Shift+滚轮与 Ctrl+Shift+↑/↓ 是 TUI
        全屏程序（如 Claude Code）里的滚动救急键。
      </p>
    </Modal>
  );
}

export function ButtonIcon({
  title,
  onClick,
  highlight,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  highlight?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        highlight ? "bg-primary/15 text-primary hover:bg-primary/20" : ""
      }`}
    >
      {children}
    </button>
  );
}
