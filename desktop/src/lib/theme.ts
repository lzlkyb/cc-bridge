/**
 * 主题（深/浅色）统一管理层。
 * WHY：命令面板(P0-1)也需要切换主题，但主题状态此前散落在 Header 内部。
 * 抽成共享模块后，Header 与命令面板共用同一份逻辑，并通过 `themechange`
 * 事件保持图标/UI 同步，避免各组件各自维护导致状态分裂。
 */

export type Theme = "dark" | "light";

export function getStoredTheme(): Theme {
  return localStorage.getItem("theme") === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // 切换主题时启用一次性过渡，避免硬闪；transitionend 后移除 class。
  root.classList.add("theme-transition");
  const onEnd = (e: TransitionEvent) => {
    if (e.target === root) root.classList.remove("theme-transition");
  };
  root.addEventListener("transitionend", onEnd, { once: true });
  root.classList.toggle("dark", theme === "dark");
  localStorage.setItem("theme", theme);
  window.dispatchEvent(new CustomEvent<Theme>("themechange", { detail: theme }));
}

export function toggleTheme(): Theme {
  const next: Theme = getStoredTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
