import { useRef } from "react";
import { useFileDrop } from "./useFileDrop";
import { zoneOf, type DropZone } from "../../lib/dropHit";
import { pickUploadableFiles } from "../../lib/localFiles";
import type { SshFileEntry } from "../../lib/types";

interface Params {
  connectionId: string;
  /** 当前目录（= 上传目标）。 */
  path: string;
  /** 当前目录的条目，用于重名检查。 */
  entries: SshFileEntry[];
  busy: boolean;
  uploadMany: (a: {
    connectionId: string;
    dir: string;
    files: { local: string; name: string }[];
    existing?: string[];
  }) => Promise<{ done: number; total: number }>;
  /** 传完后回调（刷新列表）。 */
  onDone: () => void;
}

/**
 * 文件面板的拖入上传。
 *
 * 与终端拖拽的关键区别：这里**不弹框**。目录就写在上面的路径条里，
 * 传完列表自动刷新，反馈闭环、零歧义——没什么可确认的。
 *
 * 重名检查直接用手里的 `entries`（传 `existing`），省掉一次列目录。
 */
export function useFileBrowserDrop({
  connectionId,
  path,
  entries,
  busy,
  uploadMany,
  onDone,
}: Params) {
  const paneRef = useRef<HTMLDivElement>(null);
  const drop = useFileDrop({
    collectZones: () => {
      if (busy) return [];
      const z = zoneOf("files", paneRef.current);
      return z ? [z] : ([] as DropZone[]);
    },
    onDrop: (_zone, paths) => {
      void (async () => {
        const files = await pickUploadableFiles(paths);
        if (!files.length) return;
        await uploadMany({
          connectionId,
          dir: path,
          files: files.map((f) => ({ local: f.path, name: f.name })),
          existing: entries.map((e) => e.name.split(" -> ")[0]),
        });
        onDone();
      })();
    },
  });
  return { paneRef, ...drop };
}
