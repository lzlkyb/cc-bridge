import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";

/**
 * 侧栏一行的「⋯」菜单：重命名 / 归档（3-1d）。
 *
 * ## 为什么重命名就地把输入框放进菜单里
 *
 * 名字只有一格宽，就地编辑（行内 input）要处理「点别处保存还是取消」「失焦时
 * 正好在滚动」这些边界；而改名本来就是一次「打开菜单 → 写 → 回车」的动作，
 * 把输入框放在菜单里，焦点、提交、取消三件事都在同一个容器里闭环。
 *
 * ## 为什么归档不需要二次确认
 *
 * R17：不做弹窗式确认。归档**不删内容**（只写一个时间戳），用户随时能在
 * 「显示已归档」里捞回来 —— 一个有退路的动作不该拦一道门。
 *
 * ## 没有 `rowId` 的那一行
 *
 * 还没落过盘的新会话没有库里的行号。改名/归档都无处可写，菜单里给一条说明
 * 而不是把按钮做灰了让人猜为什么点不动。
 */
export function SessionRowMenu({
  rowId,
  title,
  archived,
  onRename,
  onArchive,
}: {
  rowId: number | null;
  title: string;
  /** 当前是否已归档（决定菜单第二项是「归档」还是「取消归档」）。 */
  archived: boolean;
  onRename: (rowId: number, title: string) => Promise<unknown>;
  onArchive: (rowId: number, archived: boolean) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 浮层坐标（`position: fixed`）。
   *
   * 🔴 不能用 `absolute right-0 top-full`：侧栏列表容器是 `overflow-y-auto`，
   * 绝对定位的子元素会被它**裁掉**（CSS 里一个轴不是 visible 时另一个轴会变成
   * auto）—— 最后一行的菜单会「点了没反应」，其实是被裁在容器外。
   * 所以按按钮的 `getBoundingClientRect()` 算屏幕坐标，靠近底部时向上翻。
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const MENU_W = 210;
  /** 估算高度（两行菜单 + 说明），只用于判断「下面放不放得下」。 */
  const MENU_H = 132;

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return false;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    const below = r.bottom + 4;
    const top =
      below + MENU_H > window.innerHeight - 8
        ? Math.max(8, r.top - MENU_H - 4)
        : below;
    setPos({ top, left });
    return true;
  };

  // 点外面 / Esc 关（与 ModelPicker 同一条规矩：pointerdown Capture，按下即收）。
  // 另外滚动时直接关：fixed 浮层不会跟着行滚，留着它就会飘在别的行上。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setRenaming(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc 先退掉「正在改名」，再退菜单 —— 一步退到底会丢掉刚写的内容。
      if (renaming) {
        setRenaming(false);
        setError(null);
      } else {
        setOpen(false);
      }
    };
    const onScroll = () => {
      setOpen(false);
      setRenaming(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, renaming]);

  const startRename = () => {
    setDraft(title);
    setRenaming(true);
    setError(null);
  };

  const submit = async () => {
    if (rowId === null || busy) return;
    const next = draft.trim();
    if (!next) {
      setError("标题不能为空");
      return;
    }
    setBusy(true);
    try {
      await onRename(rowId, next);
      setRenaming(false);
      setOpen(false);
    } catch (e) {
      // 后端会把「行已经不在库里」说清楚，原样转给用户。
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (rowId === null || busy) return;
    setBusy(true);
    try {
      await onArchive(rowId, !archived);
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={boxRef} className="shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        title="更多操作（重命名 / 归档）"
        aria-label={`更多操作：${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            setRenaming(false);
            return;
          }
          if (!place()) return;
          setRenaming(false);
          setError(null);
          setOpen(true);
        }}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/[.07] focus-visible:opacity-100 group-hover:opacity-100 data-[open]:opacity-100"
        data-open={open || undefined}
      >
        <Icon name="more" size={12} />
      </button>

      {open && pos && (
        <div
          role="menu"
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
          className="fixed z-40 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        >
          {rowId === null ? (
            <p className="px-3 py-2 text-[11px] leading-[1.5] text-muted-foreground">
              这条会话还没落过盘（说一句话之后才能改名 / 归档）。
            </p>
          ) : renaming ? (
            <form
              className="p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="会话标题"
                maxLength={120}
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(false);
                    setError(null);
                  }}
                  className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  取消
                </button>
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                  {draft.trim().length}/120
                </span>
              </div>
              {error && (
                <p className="mt-1 text-[11px] leading-[1.4] text-destructive-ink">{error}</p>
              )}
            </form>
          ) : (
            <div className="flex flex-col p-1">
              <button
                type="button"
                role="menuitem"
                onClick={startRename}
                className="rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/60"
              >
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void toggleArchive()}
                disabled={busy}
                className="rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/60 disabled:opacity-50"
              >
                {archived ? "取消归档" : "归档"}
              </button>
              <p className="px-2 pb-1 pt-0.5 text-[11px] leading-[1.4] text-muted-foreground">
                {archived
                  ? "取消后回到历史列表，并重新参与自动恢复。"
                  : "归档只收起来，不删内容；自动恢复会跳过它。"}
              </p>
              {error && <p className="px-2 pb-1 text-[11px] text-destructive-ink">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
