import { trimCopyText } from "./terminalPaste";

/**
 * 选区缓存的有效期。
 *
 * 🔴 没有这条线时缓存只增不减，是一个真实的误操作陷阱：按过一次 Ctrl+Shift+A
 * 全选之后，之后任何一次「复制选中」只要当下没有选区，都会静默回退到那份
 * **整个滚动历史（5000 行）**的缓存——用户以为复制的是刚拖选的内容。
 * 缓存的唯一用途是抵御 TUI 每帧重绘冲空 live selection，那是毫秒级的事，
 * 10 秒远远够用。
 */
export const SELECTION_CACHE_TTL_MS = 10_000;

/** 同一次松手可能触发多个 pointerup（或 HMR 累积的多个监听闭包），窗口内只复制一次。 */
export const COPY_DEDUP_MS = 500;

export interface SelectionCache {
  /** 记下最近一次非空选区（空串直接忽略——TUI 重绘会不断 fire 空选区）。 */
  remember(text: string | undefined): void;
  /** 读缓存的选区；超期就当没有，并顺手丢掉（不让一份 5000 行的字符串常驻）。 */
  read(): string;
  /** 领取一次复制额度：去重窗口内重复调用返回 false（不写第二次剪贴板）。 */
  claim(): boolean;
  /** 写剪贴板（复制前按 trimCopyText 剥尾随空白）；回调带剪辑后的字数供 UI 报「已复制 N 字」。 */
  write(text: string, onDone: (ok: boolean, length: number) => void): void;
}

/**
 * 终端选区缓存：拖选即复制的三件套（记忆 / 去重 / 写剪贴板）。
 *
 * WHY 抽成模块：这三件事原本散在 `useSshTerminalSelect` 里，把它顶到 300 行棘轮线上。
 * 它们是纯状态机（三个时间戳语义），与 React 无关，放 lib 才能同时被 hook 和单测复用。
 *
 * 🔴 不引 UI 层：提示文案（toast）留给调用方，lib 只报成败——避免 lib → components 的反向依赖。
 */
export function createSelectionCache(): SelectionCache {
  let last = { text: "", at: 0 };
  let lastCopyAt = 0;
  return {
    remember(text) {
      if (text) last = { text, at: Date.now() };
    },
    read() {
      if (!last.text) return "";
      if (Date.now() - last.at > SELECTION_CACHE_TTL_MS) {
        last = { text: "", at: 0 };
        return "";
      }
      return last.text;
    },
    claim() {
      const now = Date.now();
      if (now - lastCopyAt < COPY_DEDUP_MS) return false;
      lastCopyAt = now;
      return true;
    },
    write(text, onDone) {
      const clean = trimCopyText(text);
      navigator.clipboard.writeText(clean).then(
        () => onDone(true, clean.length),
        () => onDone(false, clean.length),
      );
    },
  };
}
