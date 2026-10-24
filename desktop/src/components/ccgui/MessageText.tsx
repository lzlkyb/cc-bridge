import { memo } from "react";

/**
 * 极简行内 code 渲染：只认反引号。
 *
 * 🔴 刻意不引 markdown 库（marked + dompurify 约 20KB br）：对话里 95% 的格式化
 *    需求就是「行内代码」和「代码块」，代码块由工具卡承担，剩下的不值得一个依赖。
 */
function MessageTextImpl({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <p className="text-[13px] leading-[1.72] text-foreground">
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code
            key={i}
            data-cc-inset
            className="mx-[1px] rounded bg-muted px-[3px] py-[1px] font-mono text-[12px] text-foreground/90"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

export const MessageText = memo(MessageTextImpl);
