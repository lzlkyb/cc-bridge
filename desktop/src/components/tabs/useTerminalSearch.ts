import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { searchDecorations } from "../../lib/terminalTheme";
import type { Theme } from "../../lib/theme";

export interface TerminalSearch {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  /** 当前是第几个命中（从 0 开始，-1 = 无）与总命中数。 */
  result: { index: number; count: number };
  /** 正则模式下表达式不合法（如刚敲到 `[`）。与「无结果」必须分开显示，否则用户以为搜过了。 */
  patternError: boolean;
  setQuery: (v: string) => void;
  toggleCase: () => void;
  toggleRegex: () => void;
  openSearch: () => void;
  close: () => void;
  findNext: () => void;
  findPrev: () => void;
  /** 终端创建后调用，挂载 SearchAddon；返回注销函数。 */
  attach: (term: Terminal) => () => void;
}

/**
 * 正则模式下先自检一次表达式。
 *
 * WHY 必须自检：`@xterm/addon-search` 内部是 `if (regex) { const t = new RegExp(query, …) }`，
 * 没有任何保护；抛出的 SyntaxError 发生在 effect / 事件回调里 ⇒ 冒到 App 级 ErrorBoundary ⇒
 * 整屏变成「应用遇到错误」，所有 xterm 卸载、**全部历史输出一起丢**。
 * 用户只是敲到 `[` 或 `(` 这一瞬间的半截表达式而已。
 */
export function isValidPattern(query: string, regex: boolean): boolean {
  if (!regex || !query) return true;
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

/**
 * 终端内搜索（Ctrl+Shift+F）。
 *
 * 为什么不是 Ctrl+F：它在 readline 里是「光标右移」、vim 里是「翻页」，抢不得。
 * 与已有的 Ctrl+Shift+C / Ctrl+Shift+A 保持一致。
 */
export function useTerminalSearch(
  termRef: MutableRefObject<Terminal | null>,
  mode: Theme,
): TerminalSearch {
  const addonRef = useRef<SearchAddon | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState({ index: -1, count: 0 });
  const [patternError, setPatternError] = useState(false);

  // 主题变了高亮色也要变，用 ref 承接供稳定的回调读取。
  const optsRef = useRef<ISearchOptions>({});
  optsRef.current = {
    caseSensitive,
    regex,
    decorations: searchDecorations(mode),
  };

  const attach = useCallback((term: Terminal) => {
    // highlightLimit 默认 1000；我们把滚动历史提到了 5000，匹配项多时限制装饰数量避免卡顿。
    const addon = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(addon);
    addonRef.current = addon;
    const off = addon.onDidChangeResults((e) =>
      setResult({ index: e.resultIndex, count: e.resultCount }),
    );
    return () => {
      off.dispose();
      addon.dispose();
      addonRef.current = null;
    };
  }, []);

  /**
   * 所有进 addon 的调用都从这里过。addon 内部裸构造 RegExp，异常一旦冒到 React 就是
   * App 级错误页 + 全部终端卸载，所以这层 try/catch 是**兜底闸**，不是可选保护。
   */
  const runSafe = useCallback((fn: () => void) => {
    try {
      fn();
      return true;
    } catch {
      setPatternError(true);
      setResult({ index: -1, count: 0 });
      return false;
    }
  }, []);

  // 条件（关键词/大小写/正则）变了就重搜。空关键词清掉高亮。
  useEffect(() => {
    const addon = addonRef.current;
    if (!addon) return;
    if (!open || !query) {
      runSafe(() => addon.clearDecorations());
      setResult({ index: -1, count: 0 });
      setPatternError(false);
      return;
    }
    if (!isValidPattern(query, regex)) {
      // 半截正则（刚敲到 `[`）：清高亮 + 标「模式非法」，绝不交给 addon。
      runSafe(() => addon.clearDecorations());
      setResult({ index: -1, count: 0 });
      setPatternError(true);
      return;
    }
    setPatternError(false);
    // incremental：边敲边匹配时不要每次都跳到下一个，否则输入过程中屏幕会一直跳。
    runSafe(() => addon.findNext(query, { ...optsRef.current, incremental: true }));
  }, [open, query, caseSensitive, regex, runSafe]);

  const findNext = useCallback(() => {
    const addon = addonRef.current;
    if (!addon || !query) return;
    if (!isValidPattern(query, regex)) {
      setPatternError(true);
      return;
    }
    runSafe(() => addon.findNext(query, optsRef.current));
  }, [query, regex, runSafe]);
  const findPrev = useCallback(() => {
    const addon = addonRef.current;
    if (!addon || !query) return;
    if (!isValidPattern(query, regex)) {
      setPatternError(true);
      return;
    }
    runSafe(() => addon.findPrevious(query, optsRef.current));
  }, [query, regex, runSafe]);

  const openSearch = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    addonRef.current?.clearDecorations();
    setResult({ index: -1, count: 0 });
    // 焦点还给终端，否则关了搜索框还得再点一下才能敲。
    termRef.current?.focus();
  }, [termRef]);

  return {
    open,
    query,
    caseSensitive,
    regex,
    result,
    patternError,
    setQuery: setQueryState,
    toggleCase: () => setCaseSensitive((v) => !v),
    toggleRegex: () => setRegex((v) => !v),
    openSearch,
    close,
    findNext,
    findPrev,
    attach,
  };
}
