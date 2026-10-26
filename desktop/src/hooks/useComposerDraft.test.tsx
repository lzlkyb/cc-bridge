// @vitest-environment jsdom
import { act, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDraft } from "./useComposerDraft";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = (pane: string) => `ccbridge_composer_draft:${pane}`;
const stored = (pane: string) => localStorage.getItem(KEY(pane));

/** 把 hook 的 setter 掏出来，测试里直接改值（等价于用户打字）。 */
let setDraft: Dispatch<SetStateAction<string>> | null = null;

function Probe({ pane }: { pane: string }) {
  const [text, set] = useComposerDraft(pane);
  setDraft = set;
  return <span data-testid="draft">{text}</span>;
}

const shown = () => container.querySelector('[data-testid="draft"]')?.textContent ?? "";

let container: HTMLDivElement;
let root: Root;
let unmounted: boolean;

beforeEach(() => {
  localStorage.clear();
  // 只伪造计时器：React 自己的调度也用 timer，全量伪造会让 `act` 里的提交卡住。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setDraft = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  unmounted = false;
});

afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const type = async (text: string) => {
  await act(async () => setDraft!(text));
};

describe("草稿落盘的时机", () => {
  it("打字期间不写，停下 400ms 才写", async () => {
    await act(async () => root.render(<Probe pane="p1" />));
    await type("你");
    await type("你好");
    // 还在打：一次都没落盘（每敲一个字同步写 localStorage 会卡输入）。
    expect(stored("p1")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(stored("p1")).toBe("你好");
  });

  /// 🔴 用户打完最后一个字立刻关窗口，防抖还没到点。卸载时补写一次，
  ///    否则丢掉的那几个字正是他刚想好的收尾。
  it("卸载时把防抖窗口里的字补上", async () => {
    await act(async () => root.render(<Probe pane="p1" />));
    await type("写了一半");
    await act(async () => root.unmount());
    unmounted = true;
    expect(stored("p1")).toBe("写了一半");
  });

  /// 卸载 flush 必须读**最新**的值：cleanup 闭包捕获的 `value` 可能已经落后
  /// 一两次渲染，拿捕获值会写回倒数第二个字。
  it("卸载写的是最新值，不是首次渲染的捕获值", async () => {
    await act(async () => root.render(<Probe pane="p1" />));
    await type("第一版");
    await type("第一版改");
    await act(async () => root.unmount());
    unmounted = true;
    expect(stored("p1")).toBe("第一版改");
  });

  /// 发送成功后输入框被清空 ⇒ 落盘也清空（写空串 = 删键）。
  it("清空输入框会把草稿删掉", async () => {
    await act(async () => root.render(<Probe pane="p1" />));
    await type("发出去的话");
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(stored("p1")).toBe("发出去的话");
    await type("");
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(stored("p1")).toBeNull();
  });
});

describe("草稿的恢复", () => {
  /// 🔴 这条是整件事的意义：上次没发出去的字，挂载那一刻就要在输入框里
  ///    （惰性初值，不是渲染后再补 —— 先空后填的闪烁会让人以为丢失）。
  it("挂载时直接读出上次的草稿", async () => {
    localStorage.setItem(KEY("p1"), "上次没发完的一段话");
    await act(async () => root.render(<Probe pane="p1" />));
    expect(shown()).toBe("上次没发完的一段话");
  });

  it("只读自己 pane 的草稿", async () => {
    localStorage.setItem(KEY("p2"), "别人的");
    await act(async () => root.render(<Probe pane="p1" />));
    expect(shown()).toBe("");
  });
});
