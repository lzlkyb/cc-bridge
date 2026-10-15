import type { Terminal } from "@xterm/xterm";
import { MOUSE_REPORT_OFF } from "./terminalMouse";

/**
 * Shift 鼠标事件捕获级拦截（对齐 Ghostty `mouse-shift-capture = never`）。
 *
 * 🔴 为什么必须 capture：xterm 的 mouse 监听在子元素上，container 级冒泡监听
 * 收到时 xterm 已经把带 Shift 的事件转发给 TUI——首击泄漏（Claude Code 把
 * Shift+点击当成一次 TUI 点击）。capture 阶段在 container 上先于 xterm 拦下
 * 所有含 Shift 的鼠标事件并 stopPropagation，TUI 一个都收不到。
 *
 * 拦下之后向 xterm 合成**无 Shift** 的等价事件驱动本地选区：
 * - mousedown 走 `onShiftDown`（调用方关鼠标报告 + 补发合成 mousedown，见
 *   useSshTerminalSelect 的 replaySelectionStart）；
 * - mousemove/mouseup 直接转发无 Shift 版，延伸/提交 xterm 选区。
 *
 * 合成事件同步派发，`composing` 标志在 dispatch 期间放行 capture 层防递归。
 * 无鼠标报告时不拦——Shift 对 xterm 原生选择本就无害。
 */
export function attachShiftCapture(
  term: Terminal,
  container: HTMLElement,
  opts: {
    /** Shift+mousedown：调用方置选择态并关报告补发合成 mousedown。 */
    onShiftDown: (x: number, y: number) => void;
  },
): () => void {
  let composing = false;

  const synthMouseEvent = (
    type: string,
    x: number,
    y: number,
    button: number,
    buttons: number,
  ) => {
    composing = true;
    const target = (term.element?.querySelector(".xterm-screen") ?? term.element) as HTMLElement | null;
    target?.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button,
        buttons,
        detail: 1,
      }),
    );
    composing = false;
  };

  const synthWithoutShift = (e: MouseEvent) => synthMouseEvent(e.type, e.clientX, e.clientY, e.button, e.buttons);

  const shiftCapture = (e: MouseEvent) => {
    if (composing || !e.shiftKey) return;
    if (term.modes.mouseTrackingMode === "none") return;
    e.stopPropagation();
    if (e.type === "mousedown") {
      opts.onShiftDown(e.clientX, e.clientY);
    } else {
      synthWithoutShift(e);
    }
  };

  container.addEventListener("mousedown", shiftCapture, true);
  container.addEventListener("mousemove", shiftCapture, true);
  container.addEventListener("mouseup", shiftCapture, true);
  return () => {
    container.removeEventListener("mousedown", shiftCapture, true);
    container.removeEventListener("mousemove", shiftCapture, true);
    container.removeEventListener("mouseup", shiftCapture, true);
  };
}

/**
 * 关鼠标报告后用原始按点坐标补发一次合成 mousedown，驱动 xterm 本地选区启动。
 *
 * 🔴 鼠标报告活跃时（Claude Code 每帧重绘 ?1006h），拖拽中途关报告**必须补发**：
 * xterm 选区只能在 mousedown 时启动（SelectionService.handleMouseDown），拖拽中途
 * 关报告后 mousemove 只延伸"已存在"的选区、无法凭空新建——headless 实测中途关后
 * 选区恒空（关前报告已发给 TUI 无法避免；合成 mousedown 复用原始按点坐标，只驱动
 * 本地选区，此时报告已关不会二次发送）。`guard` 由调用方提供（如 pointerDown 守卫，
 * 防"松手后迟到的回调"补出幽灵选区）。
 */
export function replaySelectionStart(
  term: Terminal,
  x: number,
  y: number,
  guard: () => boolean,
): void {
  term.write(MOUSE_REPORT_OFF, () => {
    if (!guard()) return;
    if (term.modes.mouseTrackingMode !== "none") return;
    // 此处不走 synthMouseEvent：它带 composing 标志（只服务 capture 层防递归），
    // 回放时机在 write 回调里，与 capture 层无竞争。
    const target = (term.element?.querySelector(".xterm-screen") ?? term.element) as HTMLElement | null;
    target?.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
        detail: 1,
      }),
    );
  });
}
