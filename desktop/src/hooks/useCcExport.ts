import { useCallback } from "react";
import { toast } from "../components/ui/toast";
import { conversationMarkdown } from "../lib/ccExport";
import type { CcMessage } from "../lib/ccGuiTypes";
import { copyText } from "../lib/utils";

/**
 * 把整段对话导出成 Markdown（复制到剪贴板）。
 *
 * ## 为什么是剪贴板而不是文件
 *
 * 落盘要一条新后端命令（前端没有 fs 插件），而「贴到 issue / 笔记 / 另一个
 * 模型」这个真实用途里，剪贴板少一步。要文件的人粘一下就行。
 *
 * ## 为什么用 toast 而不是按钮内联「已复制」
 *
 * `useCopyFeedback` 的规范是「高频复制用内联反馈、不弹 toast」（连接页评审
 * 修复 ⑤）。导出是低频动作，而会话条上已经挤满控件 —— 内联反馈会把按钮
 * 宽度撑出一个来回。低频 + 空间紧张，用 toast 更合适。
 *
 * ## 入参为什么拆平
 *
 * 与 `paneForkSeed` 同一个理由：`messages` 在流式期间每 tick 换引用，而
 * `title` / `cwd` / `model` 不是。整包一个对象当依赖，等于每次流式碎片都换
 * 一个回调身份。
 */
export function useCcExport({
  messages,
  title,
  cwd,
  model,
}: {
  messages: CcMessage[];
  title: string;
  cwd: string;
  model: string;
}): { exportMarkdown: () => void; canExport: boolean } {
  const exportMarkdown = useCallback(() => {
    const md = conversationMarkdown(messages, {
      title,
      cwd,
      model,
      at: new Date().toLocaleString(),
    });
    void copyText(
      md,
      () => toast(`已复制 Markdown（${md.length.toLocaleString()} 字符）`, "info"),
      (e) => toast(`复制失败：${e}`, "error"),
    );
  }, [messages, title, cwd, model]);

  // 一条消息都没有的会话没什么可导出，入口直接不摆（与「$0.00 不占位」同一条规矩）。
  return { exportMarkdown, canExport: messages.length > 0 };
}
