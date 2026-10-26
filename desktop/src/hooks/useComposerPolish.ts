import { useState } from "react";

/**
 * 输入区的「润色草稿」状态（原在 Composer 里内联，2026-10-26 因体量门禁外移）。
 *
 * ## 为什么备份只在「拿到新文本」时建立
 *
 * 润色失败时绝不能动用户的草稿：`onPolish` 抛错 / 超时 / 返回空串都保持原样。
 * 备份只在真的换成改写稿之后才有意义 —— 它存在的唯一目的是让用户一键退回自己
 * 写的那句。
 *
 * ## 为什么一打字就作废
 *
 * 用户接着改了两笔之后再点「撤销润色」，还原回去会把这两笔一起抹掉，
 * 而界面上的按钮看起来只是「撤销润色」。宁可让按钮消失。
 */
export function useComposerPolish(onPolish?: (draft: string) => Promise<string | null>) {
  /** 润色前的原文。非空 = 显示「撤销润色」。 */
  const [backup, setBackup] = useState<string | null>(null);
  /**
   * 润色在跑。
   *
   * 刻意留在输入区这一层而不是上抛：它是**输入区自己的**忙碌状态（按钮转圈 +
   * 防重复点），父组件不拿它做任何判断。
   */
  const [polishing, setPolishing] = useState(false);

  /** 返回改写后的文本；失败或没配返回 `null`（调用方据此不动草稿）。 */
  const run = async (draft: string): Promise<string | null> => {
    if (!draft || !onPolish || polishing) return null;
    setPolishing(true);
    try {
      const out = await onPolish(draft);
      if (!out || !out.trim()) return null;
      setBackup(draft);
      return out.trim();
    } finally {
      // 失败 / 超时也要复位：卡在「润色中」的按钮再也点不动。
      setPolishing(false);
    }
  };

  /** 拿回润色前的原文（并作废备份）。已经作废就返回 `null`。 */
  const undo = (): string | null => {
    const prev = backup;
    setBackup(null);
    return prev;
  };

  /** 作废备份（发送之后、或用户重新打字时）。 */
  const reset = () => setBackup(null);

  return { backup, polishing, run, undo, reset, enabled: Boolean(onPolish) };
}
