import { useEffect, useState } from "react";
import { useUpdate } from "../../contexts/UpdateContext";

/** 淡出时长，与 index.css 的 --dur-slow（320ms）对齐，结束时留一拍再卸载。 */
const FADE_MS = 320;

/**
 * 下载期窗口级进度线（方案 B，2026-10-16 二次改造后**仅剩这一种浮层**）。
 *
 * 2px 通栏，位在窗口最顶，只回答「走了多远」——最克制的一档。它的独特价值是
 * **全屏终端态（`fixed inset-0 z-50`）下依然可见**：那是顶栏被盖住、中段读数
 * 一起消失的唯一场景，此时窗口里就只剩它还报着进度。
 *
 * 🔴 必须 `position: fixed` + `pointer-events: none`，**绝不参与布局**：
 *    一旦改成占位元素（哪怕只是给 `app-main` 加个 `border-top`），内容区高度就会
 *    变 1–2px ⇒ 终端面板触发一次 fit ⇒ 远端 TUI 重排。这条红线与读数同源。
 */
export function UpdateProgressLine() {
  const { status, progress, progressIndeterminate } = useUpdate();
  const active = status === "downloading";

  // 淡入 / 淡出：只在下载期存在，但结束时不要「啪」地消失。
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    if (active) {
      setVisible(true);
      return;
    }
    const t = setTimeout(() => setVisible(false), FADE_MS);
    return () => clearTimeout(t);
  }, [active]);

  if (!visible) return null;

  const pct = Math.min(100, Math.max(0, progress));
  return (
    <div className={`update-line${active ? " is-on" : ""}`} aria-hidden="true">
      {progressIndeterminate ? (
        <i className="update-line-sweep" />
      ) : (
        <i style={{ transform: `scaleX(${pct / 100})` }} />
      )}
    </div>
  );
}
