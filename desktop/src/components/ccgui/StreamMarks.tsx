import { Icon, type IconName } from "../ui/icon";

/**
 * 流里的两条分隔线：**停止点**与**清空线**。
 *
 * 它们不是消息，是对时间轴的注释 —— 所以都不进 `messages`：
 * - 停止点来自运行时事件（`CcView.stops`，消息里没有痕迹）；
 * - 清空线**从消息内容推导**（这条用户消息是 `/clear`），因此历史重放也自动有。
 *
 * 为什么非有不可：中断后正文停在半句、工具行停在「已中断」，过一会儿翻回来
 * 分不清是被打断的还是模型本来就说成这样 —— 而「这一轮没跑完」恰恰决定了
 * 要不要重发。`/clear` 更极端：界面上一个字都没变，模型那边已经忘光了，
 * 接着上文提问只会得到莫名其妙的回答。
 */

function MarkLine({ icon, tone, children }: { icon: IconName; tone: string; children: React.ReactNode }) {
  return (
    <div className={`my-1 flex items-center gap-2 text-[11px] ${tone}`}>
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1">
        <Icon name={icon} size={10} className="shrink-0 opacity-70" />
        {children}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 用户按了停止：这一轮没跑完，不会有下文。 */
export function StopMark() {
  return (
    <MarkLine icon="pause" tone="text-muted-foreground">
      已停止 · 这一轮没跑完
    </MarkLine>
  );
}

/** `/clear` 之后：以上内容模型不再记得。 */
export function ClearMark() {
  return (
    <MarkLine icon="refresh" tone="text-warning-ink">
      上下文已清空 · 以上内容模型不再记得
    </MarkLine>
  );
}
