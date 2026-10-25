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
 */
function MessageTextImpl({ text, marks }: { text: string; marks?: CcMark[] }) {
  return <MarkdownText text={text} marks={marks} />;
}

export const MessageText = memo(MessageTextImpl);
