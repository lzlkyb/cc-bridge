import { useEffect, useState, type CSSProperties, type RefObject } from "react";

/** 视口边缘留白。与各浮层自己的 `calc(100vw - 24px)` 取同一个值。 */
const EDGE = 12;

/**
 * 把浮层从「相对锚点的 absolute」换成「相对视口的 fixed」。
 *
 * ## 为什么必须换
 *
 * 这些浮层都挂在会话条上，而会话条的祖先是 `data-cc-panel`（`overflow-hidden`，
 * 为了让 pane 的圆角裁掉消息流）。浮层用 `absolute right-0 w-[260px]` 时只在
 * **锚点靠右**的情况下不越界。会话条是 `flex-wrap` 的：窗口一窄，右端那一组
 * （模型 / 用量 / 权限 / 动作）整组换到第二行、从 pane 左端开始排 —— 于是
 * `claude-opus-5` 这个锚点跑到离左边界只有几十像素的地方，浮层向左伸 260px
 * 的前半截被面板裁掉。
 *
 * 表现不是「报错」而是**文字缺开头**：`Opus Plan` 显示成 `s Plan`，
 * 「下一轮生效」显示成「效」。截图上看着像排版脏，实际是整块被切。
 * `calc(100vw - …)` 救不了 —— 裁切来自面板，不是视口。
 *
 * ## 为什么还带 clamp
 *
 * `fixed` 只解决「被祖先裁」，不解决「跑出视口」。窗口缩到最小宽度（560px）
 * 时锚点可能在最右边，浮层要么越右界要么贴到屏幕外，所以左右都按视口夹一次，
 * 并在下方空间不足时翻到锚点上方。
 */
export function useAnchoredPopover(
  anchorRef: RefObject<HTMLElement>,
  open: boolean,
  opts: {
    /** 目标宽度（px）。视口更窄时按视口收窄。 */
    width: number;
    /** 与锚点的间距。默认 4（对应 `mt-1`）。 */
    gap?: number;
    /** 左边缘对齐锚点左边缘，还是右边缘对齐锚点右边缘。默认 `start`。 */
    align?: "start" | "end";
    /** 翻到上方所需的最小下方空间（px）。低于它就尝试翻转。 */
    minBelow?: number;
    /** 自身高度上限（px）。与可用空间取小。 */
    maxH?: number;
  },
): CSSProperties | undefined {
  const { width, gap = 4, align = "start", minBelow = 240, maxH } = opts;
  const [style, setStyle] = useState<CSSProperties>();

  useEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.max(200, Math.min(width, vw - EDGE * 2));
      let left = align === "end" ? r.right - w : r.left;
      left = Math.min(Math.max(EDGE, left), vw - EDGE - w);

      const below = vh - r.bottom - gap - EDGE;
      const above = r.top - gap - EDGE;
      const cap = (space: number) => (maxH ? Math.min(maxH, space) : space);
      // 只有「下方确实放不下、且上方更宽裕」才翻 —— 否则会话条贴在窗口顶部时
      // 每个浮层都会朝上开到标题栏外面去。
      if (below < minBelow && above > below) {
        setStyle({
          position: "fixed",
          left,
          width: w,
          bottom: vh - r.top + gap,
          maxHeight: Math.max(160, cap(above)),
        });
      } else {
        setStyle({
          position: "fixed",
          left,
          width: w,
          top: r.bottom + gap,
          maxHeight: Math.max(160, cap(below)),
        });
      }
    };
    place();
    window.addEventListener("resize", place);
    // 捕获阶段接滚动：消息区一滚锚点如果是随流移动的就得跟着走。会话条本身不滚，
    // 但同一个 hook 服务上下文面板（挂在会话条里）与历史面板，跟着量一次最省心。
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, width, gap, align, minBelow, maxH]);

  return style;
}
