import { useEffect } from "react";
import { initAppVisibility } from "../lib/appVisibility";

/**
 * 在 App 顶层调一次，启动全局可见性监听。
 *
 * 具体行为、信号源与取舍都在 `lib/appVisibility.ts`；这里只负责把它挂到
 * React 生命周期上。需要读取状态的组件用 `useAppHidden()`，不要重复调本 hook。
 *
 * 为何需要它：cc-bridge 是常驻托盘应用，绝大多数时间窗口不可见，而 WebView2
 * **不会**像浏览器隐藏标签页那样自动节流宿主窗口隐藏后的动画，轮询也不会自己停。
 */
export function useAppHiddenFlag() {
  useEffect(() => initAppVisibility(), []);
}
