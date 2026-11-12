/**
 * 自绘标题栏的拖拽判定（H8，2026-11-10）。
 *
 * 背景：tauri 内置 `drag.js` 在 drag region 上收到 mousedown 就无条件
 * `invoke('plugin:window|start_dragging')`，不判断窗口此刻是否已经聚焦。
 * 结果是从别的软件点进来那一下就已经进了系统原生移动循环，鼠标动一两个像素
 * 窗口就跟着跑（用户 2026-11-04 反馈的「自动吸附」）。
 *
 * 上游 wry 0.57.2 的 #1910 只修了「移动窗口时 webview 失焦再重新聚焦」
 * （焦点抖动 / 拖完光标不闪），不覆盖这一层：实测升级到 tauri 2.12.5 + wry 0.57.2
 * 后，从别的窗口点顶栏再微动 6×4 px，窗口仍然跟着位移 6×4。
 *
 * 所以顶栏自己接管：`data-tauri-drag-region` 全部置 false 关闭内置脚本，
 * mousedown 时先判断「这一下是不是用来把窗口从后台激活的」。
 * 是则只让系统完成激活，不启动拖动（macOS `acceptFirstMouse=false` 同款语义）。
 */

/**
 * 窗口获得焦点后多久之内的 mousedown 视为「本次点击触发的激活」。
 *
 * 为什么是时间窗而不是 `document.hasFocus()`：issue 与实测都表明 mousedown
 * 派发时焦点已经到手，hasFocus() 恒为 true，区分不出「刚被这次点击激活」。
 * 400ms 是手速上限内仍算同一次点击的宽裕值；误判代价只是「第一下只激活」，
 * 而漏判的代价是窗口被拖走，两害相权取宽。
 */
export const ACTIVATE_GRACE_MS = 400;

/**
 * 这次 mousedown 是否应该启动窗口拖动。
 *
 * @param now        当前时间（`performance.now()`）
 * @param focusedAt  窗口最近一次获得焦点的时间；`0` 表示本次会话还没记录过
 *                   （组件刚挂载，窗口本来就在前台，按已聚焦处理）
 * @param focused    窗口此刻是否处于聚焦态
 */
export function shouldStartDrag(
  now: number,
  focusedAt: number,
  focused: boolean,
): boolean {
  // 窗口在后台：这一下只能用来激活，不能拖
  if (!focused) return false;
  // 焦点是几毫秒前才拿到的 ⇒ 同样是这次点击触发的激活
  if (focusedAt > 0 && now - focusedAt < ACTIVATE_GRACE_MS) return false;
  return true;
}
