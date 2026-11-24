import { useEffect, useState } from "react";
import { invoke } from "../lib/tauri";
import type { RemoteViewer } from "../lib/types";

/**
 * 拉一次远端登录身份（uid / gid / 组），供文件面板预判「你不可读」。
 *
 * 三条设计约束：
 * ① **一次会话只拉一次**：身份在会话中途不会变；并进每次列目录等于每翻一个
 *    目录白付一次 exec。
 * ② **失败静默**（置 null，整面板不预标）：预标是增强项，老主机 `id` 输出异常
 *    不该让文件面板本身打不开。漏判的代价只是多点一次双击，读失败有归属诊断。
 * ③ **切连接要清空**：先 `setViewer(null)` 再拉——否则 A 连接的身份会短暂套到
 *    B 连接的条目上，把能读的文件标成不可读（正是当年 SshFileBrowser 10 个
 *    状态复用的那个隐患形态）。
 */
export function useSshFileViewer(connectionId: string): RemoteViewer | null {
  const [viewer, setViewer] = useState<RemoteViewer | null>(null);
  useEffect(() => {
    let alive = true;
    setViewer(null);
    invoke<RemoteViewer>("ssh_file_viewer", { connectionId })
      .then((v) => {
        if (alive) setViewer(v);
      })
      .catch(() => {
        /* 静默降级：不预标 */
      });
    return () => {
      alive = false;
    };
  }, [connectionId]);
  return viewer;
}
