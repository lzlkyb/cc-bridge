import { useCallback, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { collectPastedImages } from "../components/ccgui/ComposerAttachments";

/** 这次拖拽是不是「拖文件」（而不是拖一段选中文字）。 */
function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * 把图片拖进输入区。
 *
 * 🔴 与「粘贴」是同一条通道（`collectPastedImages`），不加第二套解析 ——
 *    粘贴走 `clipboardData`、拖拽走 `dataTransfer`，两者都是 `DataTransfer`。
 *
 * 三个容易踩的点：
 * 1. 必须在 `dragover` 里 `preventDefault()`，否则浏览器不允许 drop（连事件都不给）；
 * 2. `dragenter` / `dragleave` 会在子元素之间反复触发，所以用深度计数，而不是
 *    「离开就熄灯」—— 后者会让高亮一路闪；
 * 3. 只接管带 `Files` 的拖拽：拖一段文字进输入框是正常的编辑动作，不能拦。
 *
 * 抽成 hook 而不是留在 `Composer` 里：那个组件已经贴着体量门禁（300 行），
 * 而这段逻辑与草稿、命令面板、@引用都没有交集。
 */
export function useCcDropImages(onAdd: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    // 不 preventDefault 的话浏览器会拒绝 drop（默认行为是「用这个文件打开新页面」）。
    if (isFileDrag(e)) e.preventDefault();
  }, []);

  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      depth.current = 0;
      setOver(false);
      const files = collectPastedImages(e.dataTransfer);
      if (files.length === 0) return;
      // 有图才接管：纯文本拖拽继续走浏览器默认（插到光标处）。
      e.preventDefault();
      onAdd(files);
    },
    [onAdd],
  );

  const handlers = useMemo(
    () => ({ onDragEnter, onDragOver, onDragLeave, onDrop }),
    [onDragEnter, onDragOver, onDragLeave, onDrop],
  );

  return { over, handlers };
}
