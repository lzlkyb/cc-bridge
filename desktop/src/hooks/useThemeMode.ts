import { useEffect, useState } from "react";
import { getStoredTheme, type Theme } from "../lib/theme";

/**
 * 订阅全局亮暗主题。
 *
 * `lib/theme.ts` 的 `applyTheme()` 在切换时会派发 `themechange` 事件（Header 与命令面板都走它），
 * 这里接住即可，无需再各自维护一份状态。
 */
export function useThemeMode(): Theme {
  const [mode, setMode] = useState<Theme>(() => getStoredTheme());
  useEffect(() => {
    const onChange = (e: Event) => setMode((e as CustomEvent<Theme>).detail);
    window.addEventListener("themechange", onChange);
    // 首次挂载与上一次切换之间可能已经错过一次事件（例如组件懒加载晚于用户点主题按钮），
    // 这里补一次读取兜底，避免停在初始值上。
    setMode(getStoredTheme());
    return () => window.removeEventListener("themechange", onChange);
  }, []);
  return mode;
}
