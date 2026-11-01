import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 让任务栏图标闪一下（Windows）/ 跳动（macOS Dock）。
 *
 * WHY 需要：远端 BEL 铃此前只有标签上 1.5px 的小圆点 + 一条会自己消失的 toast，
 * 而 toast 在**窗口最小化或被别的应用盖住时根本看不见**——「跑完提醒我一声」这个
 * 最常见的用法等于没有。OSC 9 通知同理。
 *
 * 只闪 `Informational`（2，闪一下/短暂跳动），不用 `Critical`：后者会一直闪到用户
 * 点窗口，对「后台编译完成」这种消息太吵。
 */
export function flashWindow(): void {
  // 用户已经在看这个窗口时不需要闪（页面内的标签圆点/toast 已经够了）。
  if (typeof document !== "undefined" && document.hasFocus()) return;
  try {
    // 非 Tauri 环境（纯浏览器 dev、单测）里 getCurrentWindow() 会**同步**抛错。
    void getCurrentWindow().requestUserAttention(2).catch(() => {});
  } catch {
    /* 没有窗口 API：这不是关键路径，静默降级 */
  }
}
