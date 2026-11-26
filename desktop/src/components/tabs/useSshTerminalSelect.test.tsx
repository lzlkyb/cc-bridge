// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useSshTerminalSelect } from "./useSshTerminalSelect";
import { isSelectHold, setInputHoldBase, setSelectHold } from "../../lib/terminalInputHold";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement, container: HTMLDivElement;
let api: ReturnType<typeof useSshTerminalSelect>;
let term: Terminal;

function Harness() {
  api = useSshTerminalSelect({
    termRef,
    focusedRef: { current: false },
    dragSelectEnabled: true,
    copyOnSelectEnabled: true,
  });
  return null;
}
const termRef: { current: Terminal | null } = { current: null };

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  container = document.createElement("div");
  host.append(container);
  term = {
    options: {} as Record<string, unknown>,
    getSelection: () => "",
    hasSelection: () => false,
    onSelectionChange: () => ({ dispose: () => undefined }),
    scrollLines: () => undefined,
  } as unknown as Terminal;
  termRef.current = term;
  root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("A 方案：按下即闭闸 + 松手补点击（侧栏收起后拖选抖动的修复）", () => {
  it("🔴 TUI 里普通点击：按下就闭闸，松手后补出 press + release，远端看到的仍是一次点击", async () => {
    const sent: string[] = [];
    const t = term as unknown as { modes: unknown; element: unknown };
    t.modes = { mouseTrackingMode: "any" }; // 远端开着 ?1003h（Claude Code）
    t.element = { querySelector: () => ({ dispatchEvent: (e: MouseEvent) => (sent.push(e.type), true) }) };
    act(() => {
      api.attach(term, container);
    });

    act(() => {
      container.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    });
    // 按下这一刻闸必须已闭：否则报告外泄会让远端 TUI 重绘 / 把视口弹回底部
    expect(term.options.disableStdin).toBe(true);

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    });
    // 同一任务内先不补：紧随 pointerup 的真实 mouseup 报告要被闸拦下
    expect(sent).toHaveLength(0);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent).toEqual(["mousedown", "mouseup"]);
    expect(term.options.disableStdin).toBe(false);
  });
});

describe("输入闸的兜底自愈", () => {
  it("🔴 闸卡在闭合态时，普通点击（pointerup）就能松开——不用靠滚一格滚轮", () => {
    act(() => {
      api.attach(term, container);
    });
    // 模拟异常路径：右键按在终端上，指针在窗口外松手 → 没有 pointerup，闸一直闭着
    setSelectHold(term, true);
    expect(term.options.disableStdin).toBe(true);

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    });
    expect(isSelectHold(term)).toBe(false);
    expect(term.options.disableStdin).toBe(false);
  });

  it("会话层基础闸不受影响（断开状态不会被一次点击重新放行输入）", () => {
    act(() => {
      api.attach(term, container);
    });
    setInputHoldBase(term, true);
    setSelectHold(term, true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    });
    expect(isSelectHold(term)).toBe(false);
    // 基础闸仍然闭着：断开后输入必须继续被拦住
    expect(term.options.disableStdin).toBe(true);
    setInputHoldBase(term, false);
  });

  it("选择手势进行中不会被这次自愈误开闸（走延后一拍的正规路径）", async () => {
    act(() => {
      api.attach(term, container);
    });
    // 起手带 Shift → 进选择态并闭闸
    act(() => {
      container.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    setSelectHold(term, true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    });
    // 松手走 releaseSelectHoldSoon（0ms 延后）：不当场开闸，保护紧随的 mouseup 报告。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(term.options.disableStdin).toBe(false);
  });
});

describe("TUI 虚拟滚动条不吃选择手势", () => {
  /** 滚动条 DOM 与终端共用一个容器；sent 收集所有合成鼠标事件（起选区 / 补点击都会留痕）。 */
  function setupScrollbar() {
    const sent: string[] = [];
    const t = term as unknown as { modes: unknown; element: unknown };
    t.modes = { mouseTrackingMode: "any" };
    t.element = { querySelector: () => ({ dispatchEvent: (e: MouseEvent) => (sent.push(e.type), true) }) };
    const bar = document.createElement("div");
    bar.setAttribute("data-tui-scrollbar", "");
    const thumb = document.createElement("div");
    bar.append(thumb);
    container.append(bar);
    act(() => {
      api.attach(term, container);
    });
    return { sent, bar, thumb };
  }

  it("🔴 拖 thumb 越过 4px：不闭输入闸、不起幻影选区（否则滚动条自己合成的 wheel 全被丢掉）", () => {
    const { sent, thumb } = setupScrollbar();
    act(() => {
      thumb.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, clientX: 300, clientY: 100 }));
    });
    expect(term.options.disableStdin).not.toBe(true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1, clientX: 300, clientY: 160 }));
    });
    expect(term.options.disableStdin).not.toBe(true);
    expect(api.dragSelecting).toBe(false);
    expect(sent).toEqual([]);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    });
    expect(sent).toEqual([]);
  });

  it("🔴 点轨道翻屏：不闭闸，松手也不补发点击给远端 TUI", async () => {
    const { sent, bar } = setupScrollbar();
    act(() => {
      bar.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, clientX: 300, clientY: 40 }));
    });
    expect(term.options.disableStdin).not.toBe(true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent).toEqual([]);
  });

  it("对照：同一容器里的终端区域按下仍照常闭闸（排除只针对滚动条子树）", () => {
    setupScrollbar();
    const screen = document.createElement("div");
    container.append(screen);
    act(() => {
      screen.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    });
    expect(term.options.disableStdin).toBe(true);
  });
});
