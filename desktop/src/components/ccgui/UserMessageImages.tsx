/**
 * 用户消息气泡里的图片（缩略图）。
 *
 * ## 只有缩略图，没有原图
 *
 * 原图只走 stdin 那一次，不落盘（`CcEvent::UserMessage.images` 的注释写了原因：
 * 事件流水有 4 MB 上限，几张原图就能把整条会话的上下文挤掉）。所以这里显示的是
 * 长边 256px 的 JPEG/PNG 缩略图 —— 看清「哪张图」够用，放大看原文里的字不够。
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

  return (
    <div className="w-[300px] max-w-full">
      <div className={`grid gap-1.5 ${gridCols}`}>
        {shown.map((src, i) => (
          <div
            // 缩略图列表在同一条消息里不会重排，index 做 key 足够（也没有更稳的 id）。
            key={i}
            className={`relative overflow-hidden rounded-[7px] border border-border/80 bg-muted ${cellShape}`}
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
          </div>
        ))}
      </div>
      {/* 单图不需要计数（一眼就数得清）；多图才需要「还有几张没显示」的提示。 */}
      {n > 1 && <p className="mt-1 text-[11px] text-muted-foreground">{n} 张</p>}
    </div>
  );
}
