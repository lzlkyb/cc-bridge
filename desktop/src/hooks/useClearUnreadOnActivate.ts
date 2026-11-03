import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { clearTabMetaUnread, type TermTabMeta } from "../lib/terminalTabMeta";

/**
 * 「看过即读」：切换标签时把**离开的和进入的两个都清**。
 *
 * - 进入的清了 = 切过去就算看过了；
 * - 离开的清了 = 刚才停在那一页的那一眼已经看到了。
 *
 * 只清进入的那个，会把「盯着它跑完再切走」的标签永久留在高亮态——正是调研里说的
 * 「done 永久高亮」。
 *
 * 🔴 挂在 `activeId` 上而不是塞进 `openSession()`：激活入口有六条（连接成功 / 重连回标签 /
 * 关标签后选下一个 / 恢复会话 / 掉线 / Ctrl+Tab 循环），逐个补清零点必漏。
 */
export function useClearUnreadOnActivate(
  activeId: string | null,
  setMeta: Dispatch<SetStateAction<Record<string, TermTabMeta>>>,
) {
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const ids = [prevActiveRef.current, activeId].filter((x): x is string => x !== null);
    prevActiveRef.current = activeId;
    if (ids.length === 0) return;
    setMeta((m) => clearTabMetaUnread(m, ids));
  }, [activeId, setMeta]);
}
