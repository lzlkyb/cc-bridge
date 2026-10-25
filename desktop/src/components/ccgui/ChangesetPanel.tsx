import { useEffect, useRef } from "react";
import type { ChangesetEntry } from "../../lib/ccChangeset";
import { changesetStat } from "../../lib/ccChangeset";
import { Icon } from "../ui/icon";

/**
 * 变更集面板：本会话 CC 改过的文件（批 2-3）。
 *
 * 数据来自会话事件流（`collectChangeset`），**不查 git**——理由见那个模块的
 * 头注释。点条目跳到流里第一处 diff（`onJump` 收消息 id，滚动 + 高亮由
 * `CcGuiTab` 做），跳完即关面板：浮层盖着消息区，用户看不见自己跳到了哪儿。
 *
 * 浮层不占布局（`absolute`）：同 HistoryPanel，占高度会把消息区顶跳。
 */
export function ChangesetPanel({
  entries,
  onJump,
  onClose,
}: {
  entries: ChangesetEntry[];
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stat = changesetStat(entries);

  // 点外面关 + Esc 关。`pointerdown` 而不是 `click`：按下的那一刻就该收。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="本会话改动"
      className="absolute right-0 top-full z-30 mt-1 flex w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="file" size={12} className="shrink-0 opacity-70" />
        <span className="text-[12px] font-semibold text-foreground">本会话改动</span>
        <span className="text-[11px] text-muted-foreground">
          {stat.files} 个文件 · {stat.edits} 处改动
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="ml-auto flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon name="close" size={11} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] leading-[1.7] text-muted-foreground">
            这一会话还没有改过文件。
            <br />
            CC 用 Edit / Write 改动文件后，会列在这里。
          </p>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => onJump(e.messageId)}
              className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-[6px] text-left transition-colors last:border-0 hover:bg-muted/50"
            >
              <Icon
                name={e.failed > 0 ? "alertTriangle" : "file"}
                size={11}
                className={`shrink-0 ${e.failed > 0 ? "text-warning-ink" : "opacity-60"}`}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={e.path}>
                {e.label}
              </span>
              {e.created && (
                <span className="shrink-0 rounded bg-success/12 px-1 py-px text-[10px] text-success-ink">新建</span>
              )}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {e.edits > 1 ? `×${e.edits}` : ""}
              </span>
              {e.failed > 0 && (
                <span className="shrink-0 text-[11px] text-warning-ink" title={`其中 ${e.failed} 次失败`}>
                  {e.failed} 败
                </span>
              )}
            </button>
          ))
        )}
      </div>

      <p className="shrink-0 border-t border-border px-3 py-1.5 text-[10.5px] leading-[1.5] text-muted-foreground">
        来自会话事件流（Edit / Write / NotebookEdit），不查 git · 点击跳到流里第一处 diff
      </p>
    </div>
  );
}
