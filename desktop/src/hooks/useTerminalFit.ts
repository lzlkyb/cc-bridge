import { useCallback, type MutableRefObject, type RefObject } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { rowsToDrop } from "../lib/terminalFit";

interface Args {
  containerRef: RefObject<HTMLDivElement>;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
}

/**
 * 终端尺寸适配：fit 一次，再实测、超了就回退行数。
 *
 * 回退算法与「为什么必须回退」见 `lib/terminalFit.ts`，这里只做 DOM 测量与落地。
 *
 * WHY 单独成文件：这段是**纯 DOM 测量 + 尺寸修正**，与 SSH 会话生命周期
 * （连断 / 输入输出 / 事件订阅）没有任何耦合，却占着 30 行——留在
 * `useSshTerminalSession` 里会把它顶到行���上限，而它压根不属于「会话」这件事。
 *
 * 引用永久稳定（只读 ref），所以 `doFit` 可以安全地进任何 effect 的依赖数组。
 */
export function useTerminalFit({ containerRef, termRef, fitRef }: Args): () => void {
  return useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    const box = containerRef.current;
    if (!fit || !term || !box) return;
    // 🔴 容器被隐藏时必须在 fit() **之前**就返回。
    // 切会话 / 切 app tab 都是用 display:none 隐藏（为保活 SSH 会话不卸载），此时容器尺寸为 0，
    // 而 FitAddon 算出的是 `Math.max(1, floor(0/行高)) = 1` 行 × 2 列——它会把这个尺寸
    // 通过 onResize 发给远端 PTY，远端 TUI 会照着 1x2 重排。ResizeObserver 在元素变为
    // display:none 时会以 0×0 触发，所以这条路径是真会走到的。
    if (box.clientHeight === 0 || box.clientWidth === 0) return;
    try {
      fit.fit();
    } catch {
      return; // 元素未挂载时 fit 会抛，忽略
    }
    const el = term.element;
    if (!el) return;
    // 量 `.xterm-screen`（正是 rows × 行高 那个盒子）与 `.xterm` 两者的较大值：
    // 前者直接对应渲染出来的字符网格，后者在不同 xterm 版本的 DOM 结构下未必跟随内容高。
    // 用 getBoundingClientRect 而不是 offsetHeight/clientHeight：后者是取整值，两个盒子各自
    // 舍入会凭空造出不足 1px 的“溢出”（缩放 125% 下很常见）。
    const screen = el.querySelector<HTMLElement>(".xterm-screen");
    const contentH = Math.max(
      el.getBoundingClientRect().height,
      screen?.getBoundingClientRect().height ?? 0,
    );
    const drop = rowsToDrop(contentH, box.getBoundingClientRect().height, term.rows);
    if (drop > 0) term.resize(term.cols, term.rows - drop);
  }, [containerRef, termRef, fitRef]);
}
