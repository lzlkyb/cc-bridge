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
