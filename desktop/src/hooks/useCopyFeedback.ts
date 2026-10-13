import { useRef, useState } from "react";
import { copyText } from "../lib/utils";
import { useToast } from "../components/ui/toast";

/**
 * 复制反馈唯一规范（连接页评审修复 ⑤）。
 *
 * 之前「复制成功」有六套独立实现（ConnectTab 两套 / TokenManager / AddressPicker /
 * IpChangedBanner / ToolGuide），反馈时长、toast 有无、是否收口各不相同，每加一处
 * 复制就多一套。统一后的规范：
 *
 * 1. 成功 = 按钮内联反馈（「复制」→「已复制」，2s 回滚）——高频动作，**不再弹 toast**
 *    （toast 只留给失败）；
 * 2. 失败 = toast error（「复制失败：<原因>」），按钮不变——不让按钮谎报；
 * 3. 反馈节点挂 `aria-live="polite"`（由各按钮自行添加），读屏可感知；
 * 4. 复制成功的**业务副作用**（落盘 scope、收口 banner 等）由调用方 `onCopied`
 *    回调承担，与反馈解耦。
 *
 * 单实例可服务多个复制按钮：`copy(key, text)` 以 key 区分，`isCopied(key)` 查询。
 */
export function useCopyFeedback(timeoutMs = 2000) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const { toast } = useToast();

  const copy = (key: string, text: string, opts?: { onCopied?: () => void }) => {
    if (!text) return;
    void copyText(
      text,
      () => {
        setCopiedKey(key);
        // 连续复制不同目标时重置回滚计时，避免先复制的先到期把后复制的反馈一并清掉。
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopiedKey(null), timeoutMs);
        opts?.onCopied?.();
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  const isCopied = (key: string) => copiedKey === key;

  return { copy, isCopied };
}
