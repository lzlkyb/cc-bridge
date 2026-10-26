import { Icon } from "../ui/icon";
import { SLASH_WHITELIST_TEXT } from "../../lib/ccSlash";

/**
 * 输入区上方的两行提示：排队条数与 slash 被拦下的说明。
 *
 * 从 `Composer` 拆出的（2026-10-25）：那两行是「条件渲染 + 各自的关闭动作」，
 * 与草稿状态、命令面板没有交集，留在同一个文件里只会把 `Composer` 顶到体量门禁。
 */
export function ComposerNotices({
  queueCount,
  queuePaused = false,
  onClearQueue,
  slashReject,
}: {
  queueCount: number;
  /** 队首发送失败后自动发送已暂停：提示文案要改，否则「本轮结束后自动发送」是假话。 */
  queuePaused?: boolean;
  onClearQueue: () => void;
  /** 被闸门拦下的命令名。`null` = 不显示。 */
  slashReject: string | null;
}) {
  return (
    <>
      {queueCount > 0 && (
        <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Icon name="clock" size={11} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1">
            {queuePaused
              ? `排队的第一条发送失败，已暂停自动发送（仍保留 ${queueCount} 条）· 排除问题后再发一条即可继续，或清空`
              : `已排队 ${queueCount} 条 · 本轮结束后按顺序自动发送`}
          </span>
          <button
            type="button"
            onClick={onClearQueue}
            className="shrink-0 rounded border border-border px-1.5 py-[1px] text-[11px] transition-colors hover:border-destructive/40 hover:text-destructive-ink"
          >
            清空
          </button>
        </div>
      )}
      {slashReject && (
        <div className="mb-1 flex items-start gap-1.5 px-1 text-[11px] leading-[1.5] text-warning-ink">
          <Icon name="alertTriangle" size={11} className="mt-[1px] shrink-0 opacity-80" />
          <span className="min-w-0 flex-1">
            未发送 <span className="font-mono">{slashReject}</span>：不在白名单里。对话页只转发{" "}
            {SLASH_WHITELIST_TEXT}，其它命令请到终端页里用。要发的是路径？前面加几个字即可（如「看下{" "}
            <span className="font-mono">/var/log/x.log</span>」）。
          </span>
        </div>
      )}
    </>
  );
}
