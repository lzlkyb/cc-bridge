/** 在终端本地复制选区，同时保留无选区时的中断快捷键。 */
/** 复制语义总开关：`false` = 回到老行为（带选区时 Ctrl+C 仍是中断）。 */
export const CTRL_C_COPIES_SELECTION = true;

export interface CtrlCContext {
  /** 终端当前有真实选区，包括只选中空白。 */
  hasSelection: boolean;
  /** 输入法正在组合（拼音未上屏）。组合期的 Ctrl 组合是取消输入，绝不能变成远端信号。 */
  composing: boolean;
  /** 复制语义开关，默认取 `CTRL_C_COPIES_SELECTION`。 */
  copiesSelection?: boolean;
  /** 同一次按住产生的自动重复（`KeyboardEvent.repeat`）。 */
  repeat?: boolean;
  /** 本次**按住**已经触发过「复制」（选区已被清空）。 */
  copiedInHold?: boolean;
}

/**
 * - `swallow`：本地吃掉，不发任何字节（输入法组合期 / 复制之后的按键自动重复）；
 * - `copy`：复制 live 选区并清选区，不发字节；
 * - `interrupt`：原样放行给 xterm，由它发 `\x03`。
 */
export type CtrlCAction = "copy" | "interrupt" | "swallow";

export function decideCtrlC(c: CtrlCContext): CtrlCAction {
  // 🔴 组合期必须最先判：中文输入法里 Ctrl+C 是「取消这次拼音」，此时把 \x03 发给
  // 远端既是误会也是事故——TUI 正在跑任务就被它杀了。
  if (c.composing) return "swallow";
  // 🔴 复制之后**按住不放**：选区已被清空，若不拦，第 1 次自动重复（约 500ms 后）
  // 就会被当成「第二次按 Ctrl+C」直接发 \x03 —— 又回到「想复制，任务被杀」，
  // 而且用户往往正是因为「复制没反应」才继续按。只要这一次按住始于复制，
  // 整个按住期间的重复都吞掉；松手后再按才升级为中断。
  // （没有复制过的按住依然照旧连续发 \x03，shell 里「按住 Ctrl+C 强杀」不能被削。）
  if (c.repeat && c.copiedInHold) return "swallow";
  if ((c.copiesSelection ?? CTRL_C_COPIES_SELECTION) && c.hasSelection) return "copy";
  return "interrupt";
}

/**
 * 中断类控制字节：`^C`(SIGINT) / `^\`(SIGQUIT) / `^Z`(SIGTSTP)。
 *
 * 用途只有一个：**注入期缓冲的按键重放前剥掉它们**。`useTerminalOsc` 会在
 * `stty -echo` 期间把用户按键攒进 `typedBufRef`，200ms 后原样重放——若那段时间里
 * 用户按过 Ctrl+C（比如以为卡住了想打断），它会在几秒后「自己」发出去，落在
 * 已经跑起来的任务上。按键的原意是「现在」，重放的 `^C` 只是迟到的误伤。
 *
 * 只剥这 3 个字节，其余（含 ESC 序列、退格、普通字符）一律原样保留：重放的目的是
 * 补回用户敲的内容，不是重写输入。
 */
export const INTERRUPT_BYTES = "\x03\x1a\x1c";

export function stripInterruptBytes(data: string): string {
  if (!data) return data;
  let out = "";
  for (const ch of data) {
    if (!INTERRUPT_BYTES.includes(ch)) out += ch;
  }
  return out;
}
