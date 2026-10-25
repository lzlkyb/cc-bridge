import { memo, useState } from "react";
import type { CcMark } from "../../lib/ccMarkdown";
import { MessageText } from "./MessageText";

/**
 * 用户消息气泡 + 「编辑并重发 / 从此处分叉」（批 3-3）。
 *
 * ## 为什么两个动作最后都走同一条路
 *
 * 「分叉」= 用原文重跑；「编辑并重发」= 用改过的文字重跑。差别只有那一段文本，
 * 底层都是「另开一条会话，带着这段之前的对话重跑」。做成两个后端动作只会多一套
 * 一模一样的生命周期。
 *
 * ## 为什么必须当面说清代价
 *
 * CLI 的会话是它自己那份转录，我们没有「回到第 N 轮」的原语（改 `~/.claude/*`
 * 是红线）。所以新会话的模型**看不到截断点之后的工具调用与文件改动**，
 * 那些改动也不会被撤销。这是产品做不到的事，界面不能装成做到了 ——
 * 提示条常驻在编辑态，不藏在 tooltip 里。
 */
function UserMessageBubbleImpl({
  text,
  marks,
  onFork,
}: {
  text: string;
  /** 会话内搜索的命中标注（透传给 MessageText）。 */
  marks?: CcMark[];
  /** 用（可能是编辑后的）文本开一条新会话说出去。 */
  onFork: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  if (!editing) {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        {/* data-cc-bubble：玻璃阅读面上 primary/.12 会混成脏紫，改同色系高一档 */}
        <div
          data-cc-bubble
          className="max-w-[86%] rounded-xl rounded-br-sm border border-border bg-muted/60 px-3 py-1.5"
        >
          <MessageText text={text} marks={marks} />
        </div>
        <div className="flex items-center gap-2 pr-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
            className="text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            编辑并重发
          </button>
          <button
            type="button"
            onClick={() => onFork(text)}
            className="text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            从此处分叉
          </button>
        </div>
      </div>
    );
  }

  const submit = () => {
    const next = draft.trim();
    if (!next) return;
    setEditing(false);
    onFork(next);
  };

  return (
    <div className="flex w-full flex-col items-end gap-1">
      <div
        data-cc-bubble
        className="w-full max-w-[86%] rounded-xl rounded-br-sm border border-primary/40 bg-card px-2 py-1.5"
      >
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘+Enter 发送：与输入区一致；裸 Enter 留作换行（改多行提示是常态）。
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") setEditing(false);
          }}
          rows={Math.min(10, Math.max(2, draft.split("\n").length))}
          aria-label="编辑这条消息"
          className="w-full resize-y bg-transparent text-[13px] leading-[1.6] outline-none"
        />
        <div className="mt-1 flex items-center gap-1.5 border-t border-border pt-1.5">
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
          >
            新会话重跑
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            取消
          </button>
          <span className="ml-auto text-[10.5px] text-muted-foreground">⌘/Ctrl+Enter 发送</span>
        </div>
      </div>
      <p className="max-w-[86%] text-right text-[10.5px] leading-[1.5] text-muted-foreground">
        会<strong className="font-medium text-foreground">另开一条会话</strong>重跑，原会话不动；
        新会话只带这段之前的对话正文，其中的工具调用与文件改动它看不到，也不会被撤销。
      </p>
    </div>
  );
}

/** memo：与 MessageText / ToolCard / ThinkingBlock 同一口径 —— 流式 tick 不重渲染历史节点。 */
export const UserMessageBubble = memo(UserMessageBubbleImpl);
