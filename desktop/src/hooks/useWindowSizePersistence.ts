import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { parseSavedSize, saveSize, WINDOW_SIZE_KEY } from "../lib/windowState";

/** 拖拽缩放时 onResized 每像素都触发，防抖后再写 localStorage */
const SAVE_DEBOUNCE_MS = 400;

/**
 * 窗口尺寸持久化：启动恢复上次尺寸 + resize 防抖落盘（纯前端，零 Rust 改动）。
 * 设计边界见 lib/windowState.ts 顶部注释。
 */
export function useWindowSizePersistence(): void {
  useEffect(() => {
    // 纯浏览器 dev（非 Tauri WebView）里 getCurrentWindow 会直接抛错，静默跳过
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 1) 启动恢复。上次关闭时若是最大化则跳过——恢复出来的也是最后一次的正常尺寸。
    void (async () => {
      try {
        const saved = parseSavedSize(localStorage.getItem(WINDOW_SIZE_KEY));
        if (!saved || (await win.isMaximized())) return;
        await win.setSize(new LogicalSize(saved.width, saved.height));
      } catch {
        // Tauri API 不可用时静默跳过
      }
    })();

    // 2) resize 落盘。最大化期间不写（临时尺寸不覆盖用户偏好）；
    //    onResized 载荷在 Windows 下是物理像素，按 devicePixelRatio 折算成
    //    逻辑像素再存（用 devicePixelRatio 而非 win.scaleFactor()，省一个
    //    core:window:allow-scale-factor 权限；两者语义等价）。
    //    最小化不再单独判：最小化尺寸 160x27 低于最小值，saveSize 钳制天然拒收。
    void win
      .onResized(async ({ payload }) => {
        try {
          if (await win.isMaximized()) return;
          const logical = payload.toLogical(window.devicePixelRatio || 1);
          clearTimeout(timer);
          timer = setTimeout(() => saveSize(logical.width, logical.height), SAVE_DEBOUNCE_MS);
        } catch {
          // 同上：API 不可用时静默
        }
      })
      .then((fn) => {
        // 竞态防护：监听建立前组件已卸载，则立即解绑
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, []);
}
