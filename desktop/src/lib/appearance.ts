/**
 * 外观（经典 / 现代）统一管理层。
 * 复用 lib/theme.ts 的 localStorage 模式：外观偏好存于 localStorage，
 * 并反映到 <html> 的 data-appearance 属性。与深/浅主题正交叠加。
 *
 * 经典为默认，保持现有 HSL token 与组件结构不变；现代态仅通过
 * index.css 的 [data-appearance="modern"] 作用域叠加 OKLCH 主题。
 */

export type Appearance = "classic" | "modern";

const KEY = "appearance";

export function getStoredAppearance(): Appearance {
  return localStorage.getItem(KEY) === "modern" ? "modern" : "classic";
}

/** 将外观应用到 <html> 并持久化，分发 appearancechange 事件供组件同步。 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.setAttribute("data-appearance", appearance);
  localStorage.setItem(KEY, appearance);
  window.dispatchEvent(new CustomEvent<Appearance>("appearancechange", { detail: appearance }));
}

/** 切换外观并应用。返回新的外观值。 */
export function setAppearance(appearance: Appearance): Appearance {
  applyAppearance(appearance);
  return appearance;
}
