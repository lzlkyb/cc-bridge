import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "../components/ui/toast";
import { classifySlash } from "../lib/ccSlash";
import type { CcImage } from "../lib/ccImage";
import type { CcInputMode } from "../lib/ccInput";
import type { ComposerAttachHandle } from "../components/ccgui/ComposerAttachments";

/**
 * 输入区的「发送」这件事本身：闸门 + 在途锁 + 失败保留草稿。
 *
 * 2026-11 从 `Composer.tsx` 整块外移（审查 P3-1）：那个组件已顶到 300 行门禁，
 * 而里面反复出现「两条语句挤一行」的压缩痕迹 —— 门禁是靠压行维持的，
 * 下次加功能只能再压一次。这里搬走的是**一个完整的关注点**（一次发送从判定到
 * 清理的全过程），不是把代码切一半塞进 hook 凑行数。
 *
 * 三条不变式（搬的时候一个字没改）：
 * 1. `sendingRef` 是**同步锁**：`onSend` 要等后端起进程（远端 SSH 可能数秒），
 *    用 state 挡不住同一帧内的连发（第二次会把同一条文本再排进队列）。
 * 2. 发送失败（`accepted === false`）⇒ 草稿与附件全部保留。那是用户刚拼好的东西。
 * 3. 白名单外的 slash 命令只提示、**不清空输入**：字得留着改。
 */
/** 与 `Composer` 的 `onSend` 同形：返回 `false` 表示没送出去（保留草稿），
 *  `true` / `undefined` 都算受理（排队也算受理）。 */
export type ComposerSender = (text: string, images: CcImage[]) => Promise<boolean | void> | boolean | void;

export function useComposerSend({
  value,
  setValue,
  attachRef,
  delivery,
  setDelivery,
  running,
  onSend,
  onSteer,
  onSendNow,
  onStopAndSend,
  steering,
  onUnknownSlash,
  onSent,
  onResetPolish,
}: {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  attachRef: RefObject<ComposerAttachHandle | null>;
  delivery: CcInputMode;
  setDelivery: (mode: CcInputMode) => void;
  running?: boolean;
  onSend: ComposerSender;
  onSteer?: ComposerSender;
  onSendNow?: ComposerSender;
  onStopAndSend?: ComposerSender;
  /** 有插话通道 ⇒ 发完回到「补充」档。 */
  steering: boolean;
  /** 白名单外的 slash 命令：由调用方把提示挂到面板上。 */
  onUnknownSlash: (name: string) => void;
  /** 发送受理后的收尾（关闭补全面板等）。 */
  onSent: () => void;
  /** 已发出的草稿不再可「撤销润色」。 */
  onResetPolish: () => void;
}) {
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);

  const send = async (forcedMode?: CcInputMode) => {
    if (sendingRef.current) return;
    const text = value.trim();
    const images = attachRef.current?.ready() ?? [];
    // 图还在编码：此刻发出去只有文字到达，用户却以为图也跟着走了。
    if (attachRef.current?.busy()) {
      toast("图片还在处理，稍等一下再发", "info");
      return;
    }
    // 纯图片消息合法：没有文字但有图就照发。
    if (!text && images.length === 0) return;
    const verdict = classifySlash(text);
    if (verdict.kind === "unknown") {
      onUnknownSlash(verdict.name);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      const mode = text.startsWith("/") || text.startsWith("!") ? "queue" : forcedMode ?? delivery;
      const submit =
        !running || mode === "queue"
          ? onSend
          : mode === "steer"
            ? onSteer ?? onSend
            : onSendNow ?? onStopAndSend ?? onSend;
      const accepted = await submit(text, images);
      if (accepted === false) return;
      // 发送在途时用户若又改了输入框，那是新草稿，不能跟着已发出的那句一起清掉。
      setValue((cur) => (cur.trim() === text ? "" : cur));
      setDelivery(steering ? "steer" : "queue");
      onSent();
      onResetPolish();
      attachRef.current?.clear(images);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return { send, sending };
}
