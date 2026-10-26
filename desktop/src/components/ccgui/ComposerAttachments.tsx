import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { formatBytes, type CcImage } from "../../lib/ccImage";
import { useCcImageAttach } from "../../hooks/useCcImageAttach";
import { Icon } from "../ui/icon";

/** 从粘贴事件里挑出图片文件。`items` 优先，空了再看 `files`。 */
export function collectPastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items)
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
  if (fromItems.length > 0) return fromItems;
  // 资源管理器「复制文件」这条路走的是 `files`，items 里没有 file 项。
  return Array.from(data.files).filter((f) => f.type.startsWith("image/"));
}

/** 给 Composer 用的把手。Chrome 的受控组件在发送那一刻需要「读当前值」，不是订阅。 */
export type ComposerAttachHandle = {
  /** 编好的图（不含还在编码的）。 */
  ready: () => CcImage[];
  /** 还有图在编码。此时发送会把文字和图拆开发，必须先拦住。 */
  busy: () => boolean;
  clear: () => void;
  add: (files: File[]) => void;
};

/**
 * 输入区上方的待发图片（chips + 被拒提示）。
 *
 * ## 为什么用 ref 把手而不是把状态提到 Composer
 *
 * `Composer.tsx` 已经贴着体量门禁（300 行 / 8 个 useState+useEffect），再多两个
 * 状态就是压垮它的最后一根稻草 —— 而附件区本来就自成一块：它只管「有哪些图」，
 * 发送流程只在**同一件事的两端**碰它（问「准备好了吗」、完事「清掉」）。
 * `useImperativeHandle` + 一个镜像 ref 正好表达这两次交互，且不引入响应式依赖。
 *
 * 代价：`busy` 的变化不会让 Composer 重渲染（发送按钮不会自己变灰）。所以
 * Composer 在发送前先 `busy()` 拦一道 —— 用户看到一句「图片还在处理」，比
 * 「文字发出去了、图没跟上」好得多。
 */
export const ComposerAttachments = forwardRef<
  ComposerAttachHandle,
  {
    /**
     * 「现在有图吗」。Composer 只订阅这一个布尔量 —— 发送按钮能不能点亮。
     *
     * 传 `setState` 本身即可（引用稳定，不会把 effect 变成每次渲染都跑）。
     */
    onHasImages?: (has: boolean) => void;
  }
>(function ComposerAttachments({ onHasImages }, ref) {
  const attach = useCcImageAttach();
  // 镜像：`useImperativeHandle` 的依赖是 []（handle 必须稳定，否则每次渲染
  // 都换一个对象，Composer 那个 ref 就指向旧闭包里的旧列表）。
  const latest = useRef(attach);
  latest.current = attach;
  const has = attach.items.length > 0;
  useEffect(() => {
    onHasImages?.(has);
  }, [has, onHasImages]);
  useImperativeHandle(
    ref,
    () => ({
      ready: () => latest.current.ready,
      busy: () => latest.current.busy,
      clear: () => latest.current.clear(),
      add: (files) => void latest.current.addFiles(files),
    }),
    [],
  );

  if (attach.items.length === 0 && attach.rejects.length === 0) return null;

  return (
    <div className="px-3 pt-2.5">
      {attach.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attach.items.map((it) => (
            <div
              key={it.id}
              title={it.name}
              className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[7px] border border-border bg-muted/40"
            >
              {it.pending ? (
                <div className="flex h-full w-full items-center justify-center border border-dashed border-border">
                  <Icon
                    name="spinner"
                    size={12}
                    className="animate-spin text-muted-foreground"
                  />
                </div>
              ) : (
                <>
                  <img
                    src={it.thumb}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  {/* 体积压在图上：56px 的方块里再排版一行说明会让图只剩 30px。 */}
                  <span className="absolute inset-x-0 bottom-0 bg-foreground/55 text-center text-[10px] leading-[13px] text-background">
                    {it.image ? formatBytes(it.image.bytes) : ""}
                  </span>
                </>
              )}
              <button
                type="button"
                onClick={() => attach.remove(it.id)}
                aria-label="移除这张图"
                className="absolute right-0 top-0 flex h-3.5 w-3.5 items-center justify-center rounded-bl-[4px] bg-foreground/60 text-background transition-colors hover:bg-destructive"
              >
                <Icon name="close" size={8} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* 被拒的图**必须**留一条带原因的横条：toast 三秒就没了，用户还没看清
            是哪一张、为什么被拒。 */}
      {attach.rejects.map((r) => (
        <div
          key={r.id}
          className="mt-1.5 flex items-start gap-1.5 rounded-[7px] border-l-2 border-destructive bg-destructive/[0.06] px-2 py-[5px]"
        >
          <Icon
            name="alertTriangle"
            size={11}
            className="mt-[2px] shrink-0 text-destructive-ink"
          />
          <span className="min-w-0 flex-1 text-[11px] leading-[1.5] text-destructive-ink">
            {r.text}
          </span>
          <button
            type="button"
            onClick={() => attach.dismissReject(r.id)}
            aria-label="忽略这条提示"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
    </div>
  );
});
