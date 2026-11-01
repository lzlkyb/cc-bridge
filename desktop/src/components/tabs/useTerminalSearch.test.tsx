// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

/**
 * 用假插件复刻真 `@xterm/addon-search` 的关键行为：`if (regex) new RegExp(query)` —— 裸构造、无保护。
 * 真插件在 jsdom 里没法实例化（要后端 buffer 测量），但它致命的正是这一行，
 * 恰好也是被测代码必须挡在门外的部分。
 */
// vi.mock 的提升早于普通 const：共享状态必须用 vi.hoisted，否则工厂里取到 TDZ。
const seen = vi.hoisted(() => [] as { query: string; regex: boolean; incremental: boolean }[]);
vi.mock("@xterm/addon-search", () => {
  class FakeSearchAddon {
    constructor(_opts?: unknown) {}
    loadAddon() {}
    dispose() {}
    clearDecorations() {}
    onDidChangeResults() {
      return { dispose() {} };
    }
    findNext(q: string, o?: { regex?: boolean; incremental?: boolean }) {
      // 复刻真插件：非法正则直接抛 SyntaxError（真机上它会一路冒到 App 级 ErrorBoundary）。
      if (o?.regex) new RegExp(q);
      if (q === "BOOM") throw new SyntaxError("addon blew up"); // 「兜底闸」用例的注入点
      seen.push({ query: q, regex: !!o?.regex, incremental: !!o?.incremental });
    }
    findPrevious(q: string, o?: { regex?: boolean; incremental?: boolean }) {
      if (o?.regex) new RegExp(q);
      if (q === "BOOM") throw new SyntaxError("addon blew up");
      seen.push({ query: q, regex: !!o?.regex, incremental: false });
    }
  }
  return { SearchAddon: FakeSearchAddon };
});

import { useTerminalSearch, isValidPattern, type TerminalSearch } from "./useTerminalSearch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  seen.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 把 hook 的返回值与 attach 拿出来，便于在 act 里驱动。 */
let api: TerminalSearch;
const fakeTerm = { loadAddon: () => undefined, focus: () => undefined } as unknown as Terminal;

function Harness() {
  api = useTerminalSearch({ current: fakeTerm }, "dark");
  return null;
}

function setup() {
  act(() => root.render(<Harness />));
  act(() => api.attach(fakeTerm));
  act(() => api.openSearch());
}

describe("isValidPattern", () => {
  it("非正则模式下任何输入都算合法（`[` 就是普通字符）", () => {
    expect(isValidPattern("[", false)).toBe(true);
    expect(isValidPattern("(unclosed", false)).toBe(true);
  });

  it("正则模式下识别半截表达式，识别完整表达式", () => {
    expect(isValidPattern("[", true)).toBe(false);
    expect(isValidPattern("(abc", true)).toBe(false);
    expect(isValidPattern("a{2,1}", true)).toBe(false);
    expect(isValidPattern("[a-z]+", true)).toBe(true);
    expect(isValidPattern("", true)).toBe(true);
  });
});

describe("useTerminalSearch 正则兜底", () => {
  it("🔴 半截正则不进 addon，也不把异常抛给 React（真机上会整屏错误页、全部终端卸载）", () => {
    setup();
    act(() => api.toggleRegex());
    // 这一句以前会抛 SyntaxError → ErrorBoundary；现在必须安静地标「模式非法」。
    expect(() => act(() => api.setQuery("["))).not.toThrow();
    expect(api.patternError).toBe(true);
    expect(api.result).toEqual({ index: -1, count: 0 });
    // 一次都没交给 addon：真插件里唯一会抛的地方就是这里。
    expect(seen).toEqual([]);
  });

  it("legit 正则照常下发（守卫不是把正则功能关掉）", () => {
    setup();
    act(() => api.toggleRegex());
    act(() => api.setQuery("[a-z]+"));
    expect(api.patternError).toBe(false);
    expect(seen).toEqual([{ query: "[a-z]+", regex: true, incremental: true }]);
  });

  it("补完整后自动恢复搜索", () => {
    setup();
    act(() => api.toggleRegex());
    act(() => api.setQuery("["));
    expect(api.patternError).toBe(true);
    act(() => api.setQuery("[a-z]"));
    expect(api.patternError).toBe(false);
    expect(seen.map((s) => s.query)).toEqual(["[a-z]"]);
  });

  it("addon 万一还是抛了，兜底闸接住并降级为「模式非法」", () => {
    setup();
    // 非正则模式：isValidPattern 放行，交给 addon —— 让它抛，验证 try/catch 这层网。
    expect(() => act(() => api.setQuery("BOOM"))).not.toThrow();
    expect(api.patternError).toBe(true);
  });

  it("findNext / findPrev 同样不抛", () => {
    setup();
    act(() => api.toggleRegex());
    act(() => api.setQuery("["));
    expect(() => act(() => api.findNext())).not.toThrow();
    expect(() => act(() => api.findPrev())).not.toThrow();
    expect(seen).toEqual([]);
  });
});
