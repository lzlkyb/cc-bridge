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

/**
 * 运行中「立即调整」（软中断 + 立即重发）的按键。
 *
 * 两档各用一个键，且**都不与「主发送方式」重合**：
 * - `enter` 档：`Ctrl/⌘+Enter`。注意它在空闲时也**是**发送键（`isSendKey` 为兼容
 *   老习惯收下了它，见上一条），所以这里是一处**刻意的语义分叉**：空闲时 Ctrl+Enter
 *   = 发送（按 `delivery` 档，运行中即「补充」），运行中 Ctrl+Enter = 立即调整。
 *   理由是 `enter` 档的主发送方式是裸 Enter，运行中「补充」还能用裸 Enter 触发，
 *   让 Ctrl+Enter 在运行中升级成「中断并重发」不会让人丢掉任何能力。
 * - `ctrlEnter` 档：`Alt+Enter`。这一档没有分叉的余地 —— Ctrl+Enter 就是**唯一**的
 *   发送键，运行中若把它借给「立即调整」，用户按发送键得到的是软中断 + 重发，
 *   而界面上一个字都不提示。所以换一个不与任何既有绑定冲突的键。
 *
 * 对应文案在 `ComposerFooter`（`sendNowHint`），两边必须一起改。
 */
export function isSendNowKey(
  key: SendKey,
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (key === "enter") return (e.ctrlKey || e.metaKey) && !e.altKey;
  return e.altKey && !e.ctrlKey && !e.metaKey;
}

/** 「立即调整」在提示里的按键片段（`enter` 档复用发送键的修饰符标签）。 */
export function sendNowHint(key: SendKey, mod: string): string {
  return key === "enter" ? `${mod}+Enter` : "Alt+Enter";
}
