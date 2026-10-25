import type { SlashCommand } from "../../lib/ccSlash";
import { SLASH_WHITELIST_TEXT } from "../../lib/ccSlash";

/**
 * slash 命令面板：输入框里打出 `/` 时浮在输入区上方。
 *
 * ## 为什么不占布局
 *
 * 走 `absolute`：占高度会把消息区顶上去，正在读的位置跟着跳。与 `HistoryPanel`
 * 同一条理由（那边是终端 `fit` 重排，这边是滚动位置丢失）。
 *
 * ## 键盘交互为什么不在这个组件里
 *
 * 焦点始终在 textarea 上（方向键 / Enter / Esc 都由它收），这里只负责渲染与
 * 鼠标点选。放在组件里就要管焦点迁移，那是给自己挖坑。
 */
export function SlashPanel({
  matches,
  active,
  query,
  onPick,
}: {
  matches: SlashCommand[];
  /** 当前高亮项的下标。 */
  active: number;
  /** 正在输入的查询（空 = 刚打出 `/`）。空态文案用。 */
  query: string;
  onPick: (cmd: SlashCommand) => void;
}) {
  return (
    <div
      aria-label="slash 命令"
      className="absolute bottom-full left-3 right-3 z-30 mb-1 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="font-mono text-[12px] font-semibold text-foreground">/</span>
        <span className="text-[11px] text-muted-foreground">CC 内置命令 · 由 CLI 执行</span>
      </div>

      {matches.length === 0 ? (
        <p className="px-3 py-3 text-[11px] leading-[1.6] text-muted-foreground">
          没有匹配「/{query}」的命令。对话页只转发 {SLASH_WHITELIST_TEXT}，其它命令请到终端页里用。
        </p>
      ) : (
        <div className="flex flex-col py-1">
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              // 按住别抢焦点：点一下输入框就该失焦的话，面板白给。
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(c)}
              className={`flex items-baseline gap-2 px-3 py-[5px] text-left transition-colors ${
                i === active ? "bg-muted/70" : "hover:bg-muted/40"
              }`}
            >
              <span className="shrink-0 font-mono text-[12px] text-foreground">{c.name}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="border-t border-border px-3 py-1 text-[10.5px] text-muted-foreground">
        ↑↓ 选择 · Enter 填入 · Esc 关闭 · 只转发白名单命令
      </div>
    </div>
  );
}
