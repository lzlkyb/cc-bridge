import { useSyncExternalStore } from "react";

/**
 * 发送键（Enter 发送 / Ctrl+Enter 发送）。
 *
 * 🔴 默认 `enter`：这是主流对话界面的默认（ChatGPT / Claude / Cursor 一致），
 *    换行用 `Shift+Enter`。此前的实现固定成 Ctrl+Enter 且**没有设置入口** ——
 *    对绝大多数人来说，回车键打出去一句半截的话是每天都会发生的事，而明明想
 *    换行的人只会得到「怎么发出去了」。
 *
 * 与 `chatVerbosity` / `diffView` / `chatTypography` 同构：模块级 store +
 * `useSyncExternalStore` + localStorage 全局记忆，不穿 props 链。
 *
 * 断行键在两档下都是 `Shift+Enter`（`enter` 档下 Enter 已被发送占用）。
 */
export type SendKey = "enter" | "ctrlEnter";

/** 分段控件上的短标签与 hover 全文。 */
export const SEND_KEY_META: Record<SendKey, { label: string; hint: string }> = {
  enter: { label: "Enter", hint: "Enter 发送 · Shift+Enter 换行（主流用法）" },
  ctrlEnter: { label: "Ctrl+Enter", hint: "Ctrl+Enter 发送 · Enter 换行（旧习惯）" },
};

const KEY = "ccbridge_send_key";

function read(): SendKey {
  try {
    return localStorage.getItem(KEY) === "ctrlEnter" ? "ctrlEnter" : "enter";
  } catch {
    return "enter";
  }
}

let current: SendKey = read();
const listeners = new Set<() => void>();

function write(next: SendKey) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 存不进只丢「跨重启记忆」，本窗口内仍即时生效
  }
  listeners.forEach((f) => f());
}

export function setSendKey(next: SendKey): void {
  if (next !== current) write(next);
}

export function toggleSendKey(): SendKey {
  const next: SendKey = current === "enter" ? "ctrlEnter" : "enter";
  write(next);
  return next;
}

export function useSendKey(): SendKey {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/**
 * 这次按键该不该发送。
 *
 * - `enter`：不带修饰的 Enter 就发；`Shift+Enter` 是换行；`Ctrl/⌘+Enter` 也发
 *   （不冲突，顺手兼容老习惯的人）。
 * - `ctrlEnter`：只有 `Ctrl/⌘+Enter` 发，Enter 一律换行（旧行为）。
 *
 * 抽成纯函数是为了能钉住「Shift+Enter 在两档下都必须换行」——
 * 这条要是写反了，用户每敲一次换行就会发出一条消息。
 */
export function isSendKey(
  key: SendKey,
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): boolean {
  if (e.key !== "Enter") return false;
  // Shift+Enter 先单独拦掉：它在**两档**下都是换行。`ctrlEnter` 档若漏了这一步，
  // Ctrl+Shift+Enter 会被 `ctrlKey` 判定成发送 —— 想换行的人正好按住 Ctrl 打字时
  // 就会发出半截消息。
  if (e.shiftKey) return false;
  return key === "enter" ? true : e.ctrlKey || e.metaKey;
}
