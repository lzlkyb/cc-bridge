import type { MentionItem } from "../../lib/ccMention";
import { Icon } from "../ui/icon";

/**
 * @引用补全面板（设计稿《对话页-@引用与排版偏好》A/B 期）。
 *
 * 形态与键位沿用 SlashPanel 语言：焦点不进面板（textarea 收全部键），
 * 这里只负责渲染与鼠标点选 —— 放在组件里管焦点迁移是给自己挖坑。
 */
export function MentionPanel({
  items,
  active,
  filter,
  crumb,
  loading,
  error,
  onPick,
  onHover,
}: {
  items: MentionItem[];
  active: number;
  filter: string;
  /** 当前层路径；null = 根层（本机：白名单 + 会话目录；远端：会话 cwd）。 */
  crumb: string | null;
  loading: boolean;
  error: string | null;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      aria-label="引用文件或目录"
      className="absolute bottom-full left-3 right-3 z-30 mb-1 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="font-mono text-[12px] font-semibold text-foreground">@</span>
        <span className="text-[11px] text-muted-foreground">引用文件或目录 · 目录进入，文件插入</span>
        <span className="ml-auto max-w-[46%] truncate font-mono text-[11px] text-muted-foreground" title={crumb ?? undefined}>
          {crumb ?? "根目录"}
        </span>
      </div>

      {error ? (
        <p className="break-all px-3 py-3 text-[11px] leading-[1.6] text-destructive-ink">{error}</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-3 text-[11px] leading-[1.6] text-muted-foreground">
          {loading ? "正在列目录…" : `没有匹配「${filter}」的条目`}
        </p>
      ) : (
        <div className="flex max-h-[186px] flex-col overflow-y-auto py-1">
          {items.map((it, i) => (
            <button
              key={it.path}
              type="button"
              // 按住别抢焦点：点一下输入框就该失焦的话，面板白给。
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(it)}
              onMouseEnter={() => onHover(i)}
              className={`flex items-center gap-2 px-3 py-[5px] text-left transition-colors ${
                i === active ? "bg-muted/70" : "hover:bg-muted/40"
              }`}
            >
              <Icon
                name={it.isDir ? "folder" : "file"}
                size={12}
                className={it.isDir ? "shrink-0 text-primary/85" : "shrink-0 text-muted-foreground"}
              />
              <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground">{it.name}</span>
              {it.tag && <span className="ml-auto shrink-0 text-[11px] text-primary/90">{it.tag}</span>}
              {!it.tag && typeof it.size === "number" && it.size > 0 && (
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
                  {it.size >= 1048576 ? `${(it.size / 1048576).toFixed(1)}MB` : it.size >= 1024 ? `${Math.round(it.size / 1024)}KB` : `${it.size}B`}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
        ↑↓ 选择 · Enter / Tab 填入 · Esc 关闭 · 目录在前
      </div>
    </div>
  );
}
