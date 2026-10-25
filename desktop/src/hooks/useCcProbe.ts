import { useCallback, useEffect, useState } from "react";
import type { CcProbe } from "../lib/ccEventTypes";

/**
 * 探测状态机：进页面 / 换目标时自动探一次，外加一个手动「重试」。
 *
 * 2026-10-24 从 `CcGuiTab` 拆出：`probing` 的生命周期完全跟着探测调用走
 * （进页面置 true、落地置 false、卸载要拦住迟到的 setState），与页面其它状态
 * 没有牵连；留着把宿主组件推过「8 个 useState/useEffect」的门槛。
 *
 * `runProbe` 由调用方给（`useCcSession` 的那个，内部还管着 claudePath 缓存），
 * 这里只包一层「正在探」的界面状态。
 */
export function useCcProbe(runProbe: () => Promise<CcProbe | null>, targetId: string) {
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    let alive = true;
    setProbing(true);
    void runProbe().finally(() => {
      // 卸载后迟到的 finally 不能碰 state：探一次要几百毫秒，切页比它快是常态。
      if (alive) setProbing(false);
    });
    return () => {
      alive = false;
    };
  }, [runProbe, targetId]);

  const retry = useCallback(() => {
    setProbing(true);
    void runProbe().finally(() => setProbing(false));
  }, [runProbe]);

  return { probing, retry };
}
