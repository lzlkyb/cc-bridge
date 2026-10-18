import { useEffect } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { clampToWorkArea, parseSavedSize, saveSize, WINDOW_SIZE_KEY } from "../lib/windowState";

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
        // 🔴 按当前显示器尺寸夹取（审查 P2）：换到更小的屏幕后，上次的 2400×1400
        // 会让窗口比屏幕还大，标题栏跑到屏幕外、右下角永远拖不到。
        // 拿不到显示器信息时传 Infinity，clampToWorkArea 只做最小尺寸兜底。
        let availW = Number.POSITIVE_INFINITY;
        let availH = Number.POSITIVE_INFINITY;
        try {
          // `currentMonitor` 是模块级函数（`Window` 实例上没有这个方法，只有
          // `availableMonitors()` 这类静态导出）。
          const monitor = await currentMonitor();
          const scale = monitor?.scaleFactor && monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
          if (monitor) {
            availW = monitor.size.width / scale;
            availH = monitor.size.height / scale;
          }
        } catch {
          // 权限缺失/纯浏览器：不夹取，保持原尺寸
        }
        const size = clampToWorkArea(saved, availW, availH);
        await win.setSize(new LogicalSize(size.width, size.height));
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
