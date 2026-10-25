import { useSyncExternalStore } from "react";

/**
 * 对话正文排版偏好（设计稿《对话页-@引用与排版偏好》C 期）。
 *
 * 三档循环，localStorage 全局记忆（跨 pane、跨重启）。刻意只作用于**正文**
 * （助手 / 用户气泡）：工具行 / 思考是 metadata 层，跟着正文变字号会把
 * 24px 行撑乱。管道走 CSS 变量（ConversationStream 挂、MarkdownText 消费），
 * 不穿 props 链 —— pane 们共享同一份 store。
 */

export type ChatTypography = "s" | "m" | "l";

export const CHAT_TYPOGRAPHY: Record<ChatTypography, { label: string; px: string; lh: string }> = {
  s: { label: "小", px: "12px", lh: "1.65" },
  m: { label: "中", px: "13px", lh: "1.72" },
  l: { label: "大", px: "14.5px", lh: "1.8" },
};

const KEY = "ccbridge_chat_typography";
const ORDER: ChatTypography[] = ["s", "m", "l"];

function read(): ChatTypography {
  try {
    const v = localStorage.getItem(KEY);
    return v === "s" || v === "l" ? v : "m";
  } catch {
    return "m";
  }
}

let current: ChatTypography = read();
const listeners = new Set<() => void>();

function write(next: ChatTypography) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 存不进只丢「跨重启记忆」，本窗口内仍即时生效
  }
  listeners.forEach((f) => f());
}

/** 「Aa」钮：小 → 中 → 大 循环。 */
export function cycleChatTypography(): ChatTypography {
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  write(next);
  return next;
}

export function useChatTypography(): ChatTypography {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
