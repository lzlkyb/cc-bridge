import { Modal } from "../ui/Modal";
import { SHORTCUT_GROUPS, keycapLabel } from "../../lib/shortcuts";

/**
 * 快捷键速查层（`?` 唤起，设计稿《命令面板-拼音模糊与最近使用》D 期）。
 *
 * 键盘化程度高，但键位**不可发现**是另一半 —— 没有这层，Ctrl+F / Ctrl+N
 * 只活在源码注释里。数据从 `lib/shortcuts.ts` 单一真源渲染；
 * Modal 原语自带 Esc / 遮罩关闭与焦点陷阱。
 */
export function ShortcutSheet({
  open,
  onClose,
  platform,
}: {
  open: boolean;
  onClose: () => void;
  platform?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="快捷键速查"
      className="mx-4 w-full max-w-[520px] rounded-xl modal-surface p-5"
      zIndex={1000}
    >
      <h3 className="mb-1 text-sm font-semibold">快捷键</h3>
      <p className="mb-3 text-[11px] text-muted-foreground">
        非输入态按 <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">?</kbd> 随时唤起本速查
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title}>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h4>
            <ul className="m-0 list-none space-y-1 p-0">
              {g.rows.map((r) => (
                <li key={r.desc} className="flex items-center gap-3 text-xs">
                  <span className="flex min-w-[118px] shrink-0 gap-1">
                    {r.keys.map((k, i) => (
                      <kbd
                        key={i}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {keycapLabel(k, platform)}
                      </kbd>
                    ))}
                  </span>
                  <span className="min-w-0 text-muted-foreground">{r.desc}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
