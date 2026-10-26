import { useEffect, useState } from "react";

/**
 * 到期倒计时（审批 / 提问卡的「Ns 后自动拒绝」）。
 *
 * `expiresInSec` 是 CLI 侧真实的超时（`APPROVAL_TIMEOUT_SEC`，60s）——以前直接
 * 把常量印在卡上一动不动，看着像倒计时其实是假的。这里每秒走一格，到 0 停住：
 * CLI 到点会撤回请求（`permissionCancel`），卡片随之消失，所以 0 不需要本地兜底动作。
 *
 * @param identity 倒计时归属的身份（审批 id）。**换了它就必须重来** —— 两条审批的
 *   `expiresInSec` 都是 60，只按秒数做依赖会把上一条的余数原样带过来（侧栏那一行
 *   不会随审批换人而重新挂载，这个坑只在侧栏出现，卡片上因为整卡重挂载而看不见）。
 * @param enabled `false` ⇒ 不跑 interval。侧栏里绝大多数行不在等批准，
 *   为几十个空闲行各养一个每秒 tick 的定时器没有意义。
 */
export function useExpiryCountdown(
  expiresInSec: number,
  identity?: string,
  enabled = true,
): number {
  const [left, setLeft] = useState(expiresInSec);
  useEffect(() => {
    if (!enabled) return;
    setLeft(expiresInSec);
    const startedAt = Date.now();
    const t = window.setInterval(() => {
      const next = Math.max(0, expiresInSec - Math.floor((Date.now() - startedAt) / 1000));
      setLeft((cur) => (cur === next ? cur : next));
    }, 1000);
    return () => window.clearInterval(t);
  }, [expiresInSec, identity, enabled]);
  return left;
}
