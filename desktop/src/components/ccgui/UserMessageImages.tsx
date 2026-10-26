import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";

/**
 * 用户消息气泡里的图片（缩略图 + 点开大图）。
 *
 * ## 只有缩略图，没有原图
 *
 * 原图只走 stdin 那一次，不落盘（`CcEvent::UserMessage.images` 的注释写了原因：
 * 事件流水有 4 MB 上限，几张原图就能把整条会话的上下文挤掉）。所以这里显示的是
 * 长边 256px 的 JPEG/PNG 缩略图 —— 看清「哪张图」够用，放大看原文里的字不够。
 *
 * 🔴 放大浮层里必须把「这已经是最大的了」说出来：256px 的图铺到全屏会糊，
 * 不说的话用户会以为是渲染坏了，转头去翻原图（而原图根本不存在）。
 *
 * ## 为什么给固定宽度
 *
 * 气泡宽 `max-w-[86%]`、本身是 shrink-to-fit；图片若写 `w-full` 就会形成
 * 「父宽依赖子、子宽依赖父」的循环，Chrome 会退化成 0 宽或撑破气泡。给网格一个
 * 定宽（300px，再用 `max-w-full` 兜住窄窗）是唯一稳定的写法。
 */
export function UserMessageImages({ images }: { images: string[] }) {
  const n = images.length;
  // 多于三张只画前三张，最后一张盖 +N。再多画下去每条消息都是一个相册，
  // 把下面所有对话推到屏幕外。
  const shown = n > 3 ? images.slice(0, 3) : images;
  const gridCols = n === 1 ? "grid-cols-1" : n === 2 ? "grid-cols-2" : "grid-cols-3";
  const cellShape = n === 1 ? "" : n === 2 ? "aspect-[4/3]" : "aspect-square";
  /** 正在放大看的那张（原图下标）。`null` = 没开。 */
  const [zoom, setZoom] = useState<number | null>(null);

  // Esc 关。用 fixed 全屏遮罩而不是绝对定位：消息区是 `overflow-y-auto`，
  // 绝对定位的浮层会被滚动容器裁掉（本项目踩过的老坑）。
  useEffect(() => {
    if (zoom === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null);
      if (e.key === "ArrowLeft") setZoom((z) => (z === null ? z : (z + n - 1) % n));
      if (e.key === "ArrowRight") setZoom((z) => (z === null ? z : (z + 1) % n));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoom, n]);

  return (
    <div className="w-[300px] max-w-full">
      <div className={`grid gap-1.5 ${gridCols}`}>
        {shown.map((src, i) => (
          <button
            // 缩略图列表在同一条消息里不会重排，index 做 key 足够（也没有更稳的 id）。
            key={i}
            type="button"
            onClick={() => setZoom(i)}
            aria-label={`查看第 ${i + 1} 张图（共 ${n} 张）`}
            className={`relative overflow-hidden rounded-[7px] border border-border/80 bg-muted transition-opacity hover:opacity-90 ${cellShape}`}
          >
            <img
              src={src}
              alt=""
              className={`block w-full object-cover ${n === 1 ? "max-h-[180px]" : "h-full"}`}
            />
            {n > 3 && i === 2 && (
              <span className="absolute inset-0 flex items-center justify-center bg-[rgba(17,24,39,0.55)] text-[13px] font-semibold text-white">
                +{n - 3}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* 单图不需要计数（一眼就数得清）；多图才需要「还有几张没显示」的提示。 */}
      {n > 1 && <p className="mt-1 text-[11px] text-muted-foreground">{n} 张</p>}

      {zoom !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="查看图片"
          className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/75 p-8"
          onPointerDown={() => setZoom(null)}
        >
          <img
            src={images[zoom]}
            alt=""
            // 图本身不接点击：点图不该关掉（想细看的人最容易点在图上）。
            onPointerDown={(e) => e.stopPropagation()}
            className="max-h-[76vh] max-w-full rounded-lg bg-white/5 object-contain shadow-2xl"
          />
          <div
            className="flex items-center gap-3 text-[11px] text-white/75"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {n > 1 && (
              <button
                type="button"
                onClick={() => setZoom((z) => (z === null ? z : (z + n - 1) % n))}
                aria-label="上一张"
                className="rounded border border-white/25 p-1 hover:bg-white/10"
              >
                <Icon name="chevronLeft" size={12} />
              </button>
            )}
            <span>
              {n > 1 ? `${zoom + 1} / ${n} · ` : ""}
              会话里只存了缩略图（原图不落盘），这已经是最大的了
            </span>
            {n > 1 && (
              <button
                type="button"
                onClick={() => setZoom((z) => (z === null ? z : (z + 1) % n))}
                aria-label="下一张"
                className="rounded border border-white/25 p-1 hover:bg-white/10"
              >
                {/* 图标集里只有 chevronLeft，右箭头靠翻转 —— 不 RTL 场景下等价。 */}
                <Icon name="chevronLeft" size={12} className="rotate-180" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
