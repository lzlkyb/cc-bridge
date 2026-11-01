import { memo } from "react";
import { MarkdownText } from "./MarkdownText";
import type { CcMark } from "../../lib/ccMarkdown";

/**
 * 助手正文（2026-10-25 起 = Markdown 渲染）。此前只认行内反引号 —— 模型正文里
 * 的 fenced 块 / 列表 / 表格全部以源码形态裸奔；评审通过的设计稿
 * 《对话页-Markdown与TodoWrite卡片》把它升级为全量渲染。
 *
 * 保留本文件作薄壳：调用方 import 不动，渲染实现在 `MarkdownText`
 * （词法与叶子游走在 `lib/ccMarkdown.ts`，与会话内搜索共用）。
 *
 * `marks`：会话内搜索的命中标注（透传）。
 *
 * `streaming`：这条正文是否还在生成（决定末尾要不要画光标）。由 `MessageList`
 * 按「是否本轮最后一条消息」判定，本组件只透传 —— 薄壳不持有判断。
 */
function MessageTextImpl({ text, marks, streaming }: { text: string; marks?: CcMark[]; streaming?: boolean }) {
  return <MarkdownText text={text} marks={marks} streaming={streaming} />;
}

export const MessageText = memo(MessageTextImpl);
