/**
 * 终端尺寸拟合的纯计算部分。
 *
 * 抽成纯函数是为了能单测：这段逻辑修的是「全屏后底部最后一行被切掉半截」，
 * 而那个现象需要真机 + 真实 TUI 才能复现，没法在本机验证。至少把算法本身钉死。
 */

/**
 * 亚像素容差（px）。
 *
 * 布局高度常常是小数（缩放 125% 下尤其如此），两个盒子各自舍入后可能差出不足 1px。
 * 不给容差的话，这种纯取整误差会被当成真溢出，白白退掉一整行——
 * 把「底部被切」换成「底部少一行」，同样是 bug。
 */
export const FIT_OVERFLOW_TOLERANCE_PX = 1;

/**
 * fit() 之后算出终端应该回退几行。
 *
 * WHY 需要这一步：FitAddon 算的是 `rows = floor(可用高 ÷ 行高)`，理论上不会溢出，
 * 但它用的行高取自 `_renderService.dimensions.css.cell.height`——那是上一次字体度量的**缓存值**。
 * 全屏切换、拖到不同缩放的显示器这种尺寸剧变时它可能偏小，rows 就多算一行，
 * 内容比容器高 → 最后一行被容器 overflow-hidden 切掉半截。
 * 与其去猜行高什么时候是脏的，不如直接量渲染结果，并用**实测行高**算该退几行。
 *
 * @param contentHeight 实测的终端内容高度（px，可含小数）
 * @param boxHeight     实测的容器可用高度（px，可含小数）
 * @param rows          当前行数
 * @returns             应回退的行数；0 = 不需要改
 */
export function rowsToDrop(contentHeight: number, boxHeight: number, rows: number): number {
  // 只剩一行时无路可退（退到 0 行会把终端弄成无效尺寸）。
  if (!(rows > 1)) return 0;
  // 容器被隐藏（切会话 / 切 app tab 都是 display:none）时两边都是 0，任何结论都不可信。
  if (!(contentHeight > 0) || !(boxHeight > 0)) return 0;
  const over = contentHeight - boxHeight;
  if (over <= FIT_OVERFLOW_TOLERANCE_PX) return 0;
  const cellHeight = contentHeight / rows; // 实测行高，不信 xterm 的缓存值
  if (!(cellHeight > 0)) return 0;
  return Math.min(rows - 1, Math.ceil(over / cellHeight));
}
