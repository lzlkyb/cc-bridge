/**
 * 窗口尺寸持久化——纯逻辑层（零 Tauri 依赖，可单测）。
 *
 * WHY：tauri.conf.json 的默认尺寸 1280x840 只管「第一次见面」，用户手动调整后
 * 重启会丢。不引入 tauri-plugin-window-state（多一个 Rust 依赖 + 锁文件体积），
 * 走「onResized → localStorage → 启动 restore」纯前端方案。
 *
 * 设计边界：
 * - 只持久化「尺寸」、不持久化「位置」：窗口保持 tauri.conf 的 center:true 居中，
 *   避免换显示器/改缩放后窗口恢复到已不存在的坐标（经典 off-screen bug）。
 * - 最大化/最小化期间不落盘（临时尺寸不该覆盖用户偏好）。
 * - localStorage 读出的值一律过 parseSavedSize 校验，防污染恢复出离谱尺寸。
 */

export const WINDOW_SIZE_KEY = "cc-bridge.window.size.v1";

/** 与 tauri.conf.json 的 minWidth/minHeight 保持一致，改那边必须同步这里 */
export const MIN_WIDTH = 560;
export const MIN_HEIGHT = 600;

/** localStorage 被污染时的兜底上限 */
const MAX_DIM = 20000;

export interface SavedSize {
  width: number;
  height: number;
}

/**
 * 校验并归一化 localStorage 读出的尺寸。
 * 任何不合法（缺失/非数字/越界/低于最小值）都返回 null，调用方走默认尺寸。
 */
export function parseSavedSize(raw: string | null): SavedSize | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { width?: unknown; height?: unknown };
    const w = typeof o.width === "number" ? Math.floor(o.width) : NaN;
    const h = typeof o.height === "number" ? Math.floor(o.height) : NaN;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    if (w < MIN_WIDTH || h < MIN_HEIGHT || w > MAX_DIM || h > MAX_DIM) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
}

/** 落盘前的基础钳制（调用方保证已折算成逻辑像素）。 */
export function saveSize(width: number, height: number): void {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return;
  localStorage.setItem(
    WINDOW_SIZE_KEY,
    JSON.stringify({ width: Math.floor(width), height: Math.floor(height) }),
  );
}
