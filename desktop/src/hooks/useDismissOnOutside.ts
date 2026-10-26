import { useEffect, useRef, type RefObject } from "react";

/**
 * 「面板开着时，点外面 / 按 Esc 就关掉」。
 *
 * 从 `Composer.tsx` 外移（2026-10-26）：`/` 命令面板与 `@` 引用面板都要这套行为，
 * 而它是一段纯 DOM 监听，与输入区的任何状态都无关 —— 放在组件里只会把组件顶到
 * 体量门禁的天花板上。
 *
 * ## 两个细节都不是随手写的
 *
 * - `pointerdown` + 捕获阶段：等到 `click` 再关，面板会先被点中的元素吃掉那一帧，
 *   表现是「点了外面，面板还闪了一下才消失」。
 * - 「点在框里就不关」：框里包含面板本身与输入框 —— 点面板是选择，点输入框是
 *   继续打字，两种都不该关。
 *
 * @param active 面板是否开着。关着不挂监听。
 * @param boxRef 判定框（输入区 + 面板的外层容器）。
 * @param onDismiss 关闭动作。**不要求稳定引用**（内部用 ref 镜像最新值）：
 *   调用方写内联箭头也不会导致监听反复重挂 —— 如果这里把 `onDismiss` 放进依赖，
 *   每次渲染都会拆一次监听再加一次，而「拆与加之间」正是点击可能被漏掉的窗口。
 */
export function useDismissOnOutside(
  active: boolean,
  boxRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      latest.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") latest.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, boxRef]);
}
