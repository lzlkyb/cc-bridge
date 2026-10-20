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

/**
 * 「松手即复制」允许回退的缓存时限（2026-10-20 加）。
 *
 * 🔴 自动复制不能吃 10 秒那份缓存：拖选一片空白时 `getSelection()` 是空串
 * （xterm 的 `translateBufferLineToString(..., trimRight=true)`，探针实测
 * `hasSelection()===true` 但文本为 `""`），一兜底就把**十秒前的旧选区**写进剪贴板，
 * 还弹「已复制 N 字」——用户以为复制了刚选的。缓存条目在选区每次变化时都会刷新
 * （remember），所以「本次手势刚记下的」必然是毫秒级，1.5s 足够覆盖 TUI 重绘冲空的
 * 那一刻，又不可能摸到上一次手势的内容。
 *
 * 手动复制（工具栏 / 右键 / Ctrl+Shift+C）仍用 10 秒：那里的场景是「选完过几秒才点」，
 * 且用户能立刻看到复制结果。
 */
export const GESTURE_COPY_CACHE_MS = 1_500;

export interface SelectionCache {
  /** 记下最近一次非空选区（空串直接忽略——TUI 重绘会不断 fire 空选区）。 */
  remember(text: string | undefined): void;
  /**
   * 读缓存的选区；超出 `maxAgeMs` 就当没有，并顺手丢掉（不让一份 5000 行的字符串常驻）。
   * 默认 10 秒（手动复制）；自动复制传 GESTURE_COPY_CACHE_MS。
   */
  read(maxAgeMs?: number): string;
  /** 写剪贴板（复制前按 trimCopyText 剥尾随空白）；回调带剪辑后的字数供 UI 报「已复制 N 字」。 */
  write(text: string, onDone: (ok: boolean, length: number) => void): void;
}

/**
 * 终端选区缓存：拖选即复制的两件套（记忆 / 写剪贴板）。
 *
 * WHY 抽成模块：这两件事原本散在 `useSshTerminalSelect` 里，把它顶到 300 行棘轮线上。
 * 它们是与 React 无关的纯状态机，放 lib 才能同时被 hook 和单测复用。
 * 「同一次手势只复制一次」的去重不在这里——它要按手势号判，见
 * `terminalSelectGesture.ts` 的 createSelectGesture。
 *
 * 🔴 不引 UI 层：提示文案（toast）留给调用方，lib 只报成败——避免 lib → components 的反向依赖。
 */
export function createSelectionCache(): SelectionCache {
  let last = { text: "", at: 0 };
  return {
    remember(text) {
      if (text) last = { text, at: Date.now() };
    },
    read(maxAgeMs = SELECTION_CACHE_TTL_MS) {
      if (!last.text) return "";
      const age = Date.now() - last.at;
      if (age > maxAgeMs) {
        // 只有超过**最长**时限才真丢。短时限（自动复制 1.5s）只当没看见，
        // 否则一次「拖选空白」就把手动复制还能用的缓存顺手清了。
        if (age > SELECTION_CACHE_TTL_MS) last = { text: "", at: 0 };
        return "";
      }
      return last.text;
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
