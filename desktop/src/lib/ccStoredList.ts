import type { CcStoredSummary } from "./ccEventTypes";

/**
 * 侧栏「历史」区的纯逻辑：时间文案 + 该显示哪些。**不碰 React，不碰 IPC。**
 *
 * 单独成文是为了能被单元测试钉住「已打开的那条不该出现在历史里」这条判据 ——
 * 它错了不会报错，只会让同一个会话在侧栏出现两次，看起来像 bug 又找不到原因。
 */

/**
 * 粗粒度时间：列表里只需要「最近」还是「很久以前」。
 *
 * 一周以外给日期不给相对时间：`37 天前` 这种要用户在脑子里做减法，
 * 而日期本身就能定位。
 */
export function agoText(updatedAt: number, now = Date.now()): string {
  // 后端给的是秒；容错处理毫秒（测试里手写时间戳容易搞混）。
  const ms = updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
  const diff = now - ms;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
}

/**
 * 历史区该显示哪些。
 *
 * 四道过滤：
 * 1. **已经打开的** ⇒ 不摆。同一个会话在侧栏出现两次，用户会以为有两条。
 *    两个判据一起用（缺一个就会在某个瞬间漏）：
 *    - `rowIds` —— 库里的行号。刚恢复完就能知道（`cc_restore` 的返回值），
 *      但盘上还没落过盘的新会话没有；
 *    - `cliIds` —— CC 的 session id。要有 `Init` 事件之后才有，
 *      但新建的会话最终都会有。
 * 2. 没有标题也没有轮数的空行 ⇒ 不摆。那是「点进去一句话没说就关了」的残留
 *    （理论上 `persist` 会跳过空流水，但老库/异常退出可能留下）；
 * 3. 搜索词不匹配 ⇒ 不摆。匹配口径与主列表一致（标题 / 正文预览 / 目录）。
 */
export function filterStored(
  rows: CcStoredSummary[],
  open: { cliIds?: Set<string>; rowIds?: Set<number> },
  query = "",
): CcStoredSummary[] {
  const k = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (open.rowIds?.has(r.rowId)) return false;
    if (r.sessionId && open.cliIds?.has(r.sessionId)) return false;
    if (!r.title && r.messageCount <= 0) return false;
    if (!k) return true;
    const hay = `${r.title ?? ""} ${r.preview ?? ""} ${r.cwd ?? ""}`.toLowerCase();
    return hay.includes(k);
  });
}
