import { useState, type KeyboardEvent, type RefObject } from "react";
import { filterSlash, isSlashTyping, type SlashCommand } from "../lib/ccSlash";
import { useDismissOnOutside } from "./useDismissOnOutside";

/**
 * 输入框的 slash 命令交互：面板开合、高亮项、被闸门拦下的提示、补全与键位。
 *
 * 从 `Composer` 拆出（这一块自成一个状态机，与草稿 / 附件 / 润色没有交集）；
 * 什么能从输入框出去的判定（白名单闸门）仍在 `lib/ccSlash.ts`，发送前的拦截在
 * `Composer.send`，这里只管「面板怎么开、键怎么走」。
 */
export function useCcSlashInput(
  value: string,
  setValue: (v: string) => void,
  /** 整个输入区（含面板）的定位锚点：点它外面关面板。 */
  boxRef: RefObject<HTMLElement>,
) {
  /** 命令面板的高亮项。值一变就回 0（`onTyped` 里做）。 */
  const [sel, setSel] = useState(0);
  /** 用户按过 Esc：值不变就让面板一直关着，不然 Esc 毫无效果。 */
  const [dismissed, setDismissed] = useState(false);
  /** 被闸门拦下的命令名。非空 = 显示提示；一打字就清。 */
  const [reject, setReject] = useState<string | null>(null);

  // 命令面板：`/` 开头且没打空格时开着。Esc / 点外面关。
  const open = isSlashTyping(value) && !dismissed;
  const matches = open ? filterSlash(value.slice(1)) : [];
  const active = Math.min(sel, Math.max(0, matches.length - 1));
  useDismissOnOutside(open, boxRef, () => setDismissed(true));

  /** 把命令名填进输入框，尾部留一个空格给参数。不直接发：/model 要写参数。 */
  const insert = (cmd: SlashCommand) => {
    setValue(`${cmd.name} `);
    setSel(0);
  };

  /**
   * 面板点选 / Enter。已经完整打出且不要参数的命令（/compact、/clear）
   * 直接发送——「打完回车就走」是最顺手的路径；其余落入输入框等补全。
   */
  const pick = (cmd: SlashCommand, send: () => void) => {
    if (value.trim() === cmd.name && !cmd.needsArg) {
      send();
      return;
    }
    insert(cmd);
  };

  /** 输入框内容被用户改动：高亮回 0、面板重新可开、拦截提示作废。 */
  const onTyped = () => {
    setSel(0);
    setDismissed(false);
    setReject(null);
  };

  /** 一条消息已发出：高亮与拦截提示复位。 */
  const onSent = () => {
    setSel(0);
    setReject(null);
  };

  /**
   * 面板开着时方向键 / Enter / Tab 归它。Enter 在输入框里本是换行，但「正选着
   * 命令」的时刻用户要的是补全；换行还有 Shift+Enter（浏览器原生行为，不用我们接）。
   * 返回 `true` = 这个键已被面板处理，调用方不要再往下走。
   */
  const handleKey = (e: KeyboardEvent, send: () => void): boolean => {
    if (!open || matches.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((v) => (v + 1) % matches.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((v) => (v - 1 + matches.length) % matches.length);
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      insert(matches[active]);
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pick(matches[active], send);
      return true;
    }
    return false;
  };

  return { open, matches, active, reject, setReject, pick, onTyped, onSent, handleKey };
}
