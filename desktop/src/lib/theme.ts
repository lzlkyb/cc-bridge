/**
 * 主题（深/浅色）统一管理层。
 * WHY：命令面板(P0-1)也需要切换主题，但主题状态此前散落在 Header 内部。
 * 抽成共享模块后，Header 与命令面板共用同一份逻辑，并通过 `themechange`
 * 事件保持图标/UI 同步，避免各组件各自维护导致状态分裂。
 */

export type Theme = "dark" | "light";
let transitionTimer: ReturnType<typeof setTimeout>;

/**
 * 安全读 localStorage：DOM Storage 可能被策略禁用（企业策略 / 隐私模式 /
 * 第三方上下文），此时**访问 `localStorage` 属性本身就抛 SecurityError**。
 * 本模块在 `main.tsx` 的模块初始化阶段就被调用，一次未捕获异常 = 整个应用白屏
 * （审查 P2）。主题偏好属于纯装饰，读不到就用默认值，绝不能让应用挂掉。
 */
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // 配额满 / 被禁用：主题仍在本次会话内生效（class 已切），只是不记忆。
    return false;
  }
}

export function getStoredTheme(): Theme {
  return safeGetItem("theme") === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): boolean {
  const root = document.documentElement;
  // transitionend 会从子元素冒泡，也可能根本不触发；用有界计时器清理，连切可续期。
  clearTimeout(transitionTimer);
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("theme-transition");
    transitionTimer = setTimeout(() => root.classList.remove("theme-transition"), 320);
  } else {
    root.classList.remove("theme-transition");
  }
  root.classList.toggle("dark", theme === "dark");
  const stored = safeSetItem("theme", theme);
  window.dispatchEvent(new CustomEvent<Theme>("themechange", { detail: theme }));
  return stored;
}

export function toggleTheme(): Theme {
  const next: Theme = getStoredTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
