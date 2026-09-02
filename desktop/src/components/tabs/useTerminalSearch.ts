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

  // 条件（关键词/大小写/正则）变了就重搜。空关键词清掉高亮。
  useEffect(() => {
    const addon = addonRef.current;
    if (!addon) return;
    if (!open || !query) {
      addon.clearDecorations();
      setResult({ index: -1, count: 0 });
      return;
    }
    // incremental：边敲边匹配时不要每次都跳到下一个，否则输入过程中屏幕会一直跳。
    addon.findNext(query, { ...optsRef.current, incremental: true });
  }, [open, query, caseSensitive, regex]);

  const findNext = useCallback(() => {
    if (query) addonRef.current?.findNext(query, optsRef.current);
  }, [query]);
  const findPrev = useCallback(() => {
    if (query) addonRef.current?.findPrevious(query, optsRef.current);
  }, [query]);

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
