/** 界面材质独立于明暗与终端配色；只切根节点属性，保留页面和会话节点。 */
export type Appearance = "classic" | "glass";

const KEY = "cc-bridge.ui-style";
const EVENT = "appearancechange";

export function getStoredAppearance(): Appearance {
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "glass";
  } catch {
    return "glass";
  }
}

export function getAppearance(): Appearance {
  return document.documentElement.dataset.uiStyle === "classic" ? "classic" : "glass";
}

/** 在 React 挂载前恢复，避免先绘制经典界面再闪成玻璃。初始化不写偏好。 */
export function initializeAppearance(): void {
  document.documentElement.dataset.uiStyle = getStoredAppearance();
}

/** 返回是否成功记住选择；存储不可用时，本次切换仍然生效。 */
export function applyAppearance(appearance: Appearance): boolean {
  const changed = getAppearance() !== appearance;
  document.documentElement.dataset.uiStyle = appearance;
  let persisted = true;
  try {
    localStorage.setItem(KEY, appearance);
  } catch {
    persisted = false;
  }
  if (changed) window.dispatchEvent(new Event(EVENT));
  return persisted;
}

export function subscribeAppearance(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
