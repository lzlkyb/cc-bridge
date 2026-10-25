import { useEffect, useState } from "react";

/**
 * 到期倒计时（审批 / 提问卡的「Ns 后自动拒绝」）。
 *
 * `expiresInSec` 是 CLI 侧真实的超时（`APPROVAL_TIMEOUT_SEC`，60s）——以前直接
 * 把常量印在卡上一动不动，看着像倒计时其实是假的。这里每秒走一格，到 0 停住：
 * CLI 到点会撤回请求（`permissionCancel`），卡片随之消失，所以 0 不需要本地兜底动作。
 */
export function useExpiryCountdown(expiresInSec: number): number {
  const [left, setLeft] = useState(expiresInSec);
  useEffect(() => {
    setLeft(expiresInSec);
    const startedAt = Date.now();
    const t = window.setInterval(() => {
      const next = Math.max(0, expiresInSec - Math.floor((Date.now() - startedAt) / 1000));
      setLeft((cur) => (cur === next ? cur : next));
    }, 1000);
    return () => window.clearInterval(t);
  }, [expiresInSec]);
  return left;
}
