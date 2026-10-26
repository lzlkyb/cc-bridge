import { Icon } from "../ui/icon";

/**
 * 「上一条 / 下一条我的提问」——浮在消息流底部的一组小按钮，与「回到底部」并排。
 *
 * 只在上滚离开底部时出现（跟 `ScrollToBottom` 同一时机）：贴底时用户在看最新内容，
 * 这时给导航按钮只会占地方；回看时它才是刚需。
 */
export function MessageNav({ onPrev, onNext }: { onPrev: () => void; onNext: () => void }) {
  return (
    // `pointer-events-auto`：外层浮条是 `pointer-events-none`（不挡住底下的正文），
    // 按钮必须自己收回来。`shrink-0`：和「回到底部」并排时不许被压窄。
    <span className="pointer-events-auto flex shrink-0 items-center overflow-hidden rounded-full border border-border bg-card shadow-card">
      <button
        type="button"
        onClick={onPrev}
        title="跳到上一条我的提问"
        aria-label="跳到上一条我的提问"
        className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="chevronDown" size={13} className="rotate-180" />
      </button>
      <span aria-hidden className="h-4 w-px bg-border" />
      <button
        type="button"
        onClick={onNext}
        title="跳到下一条我的提问"
        aria-label="跳到下一条我的提问"
        className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="chevronDown" size={13} />
      </button>
    </span>
  );
}
