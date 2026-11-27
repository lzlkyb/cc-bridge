import { useRef } from "react";
import { useFileDrop } from "./useFileDrop";
import { zoneOf, type DropZone } from "../../lib/dropHit";

export function useFileBrowserDrop({ busy, uploadPaths }: {
  busy: boolean;
  uploadPaths: (paths: string[]) => Promise<void>;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const drop = useFileDrop({
    collectZones: () => {
      if (busy) return [];
      const zone = zoneOf("files", paneRef.current);
      return zone ? [zone] : ([] as DropZone[]);
    },
    onDrop: (_, paths) => { void uploadPaths(paths); },
  });
  return { paneRef, ...drop };
}
