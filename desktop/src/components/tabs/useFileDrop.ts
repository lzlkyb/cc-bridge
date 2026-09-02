import { useEffect, useRef, useState } from "react";
import { listen } from "../../lib/tauri";
import { hitZone, type DropZone, type Point } from "../../lib/dropHit";

interface DragPayload {
  paths?: string[];
  position: Point;
}

interface Params {
  /**
   * 当前可接收拖放的区域。**每次事件都重新取**：全屏/折叠侧栏/窗口缩放
   * 都会改变矩形，缓存下来就会拖到旧位置。返回空数组 = 本次不接拖放。
   */
  collectZones: () => DropZone[];
  onDrop: (zoneId: string, paths: string[]) => void;
}

/**
 * 监听 Tauri 的原生拖放事件，给出「当前悬停在哪个区域 + 拖了几个文件」。
 *
 * 🔴 不能用 React 的 `onDrop`：`tauri.conf.json` 未设 `dragDropEnabled`，Tauri 2 下
 * 默认**开启原生拖放处理**，开着时 webview 里的 HTML5 `dragover` / `drop` 不会触发。
 *
 * 🔴 `drag-over` 事件**不带 paths**（只有 `enter` 与 `drop` 带），所以文件数量
 * 必须在 `enter` 时就存下来，否则遮罩上的「上传 N 个文件」会在移动时变成 0。
 */
export function useFileDrop({ collectZones, onDrop }: Params) {
  const [zone, setZone] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const pathsRef = useRef<string[]>([]);
  // 回调用 ref 持住：监听器只注册一次，直接闭包会拿到陈旧的 props。
  const zonesRef = useRef(collectZones);
  zonesRef.current = collectZones;
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  useEffect(() => {
    const offs: Array<() => void> = [];
    let dead = false;
    const add = (p: Promise<() => void>) => {
      void p.then((f) => (dead ? f() : offs.push(f)));
    };

    const where = (pos: Point) =>
      hitZone(pos, window.devicePixelRatio, zonesRef.current());

    const reset = () => {
      pathsRef.current = [];
      setCount(0);
      setZone(null);
    };

    add(
      listen<DragPayload>("tauri://drag-enter", (e) => {
        pathsRef.current = e.paths ?? [];
        setCount(pathsRef.current.length);
        setZone(where(e.position));
      }),
    );
    add(
      listen<DragPayload>("tauri://drag-over", (e) => {
        setZone(where(e.position));
      }),
    );
    add(
      listen<DragPayload>("tauri://drag-drop", (e) => {
        const paths = e.paths?.length ? e.paths : pathsRef.current;
        const z = where(e.position);
        reset();
        if (z && paths.length) dropRef.current(z, paths);
      }),
    );
    add(listen("tauri://drag-leave", reset));

    return () => {
      dead = true;
      offs.forEach((f) => f());
    };
  }, []);

  return { zone, count };
}
