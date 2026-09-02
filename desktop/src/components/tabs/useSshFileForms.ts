import { useState } from "react";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "../ui/toast";
import type { SshFileEntry } from "../../lib/types";
import type { useSshTransfer } from "./useSshTransfer";

interface Params {
  connectionId: string;
  path: string;
  entries: SshFileEntry[];
  xfer: ReturnType<typeof useSshTransfer>;
  /** 拼接远程路径（与面板内部实现保持一致）。 */
  joinRemote: (dir: string, name: string) => string;
  /** 上传成功后刷新列表。 */
  onUploaded: () => void;
}

/**
 * 文件面板的「上传 / 下载表单」状态与动作。
 *
 * 从 `SshFileBrowser` 拆出来：那个文件加入拖拽上传后超过了 300 行硬上限（规则 7）。
 * 这四个函数 + 四个 state 本来就自成一个单元：它们是「表单式单文件传输」，
 * 与拖拽入口、目录浏览都无关。**纯搬运，行为未改。**
 */
export function useSshFileForms({
  connectionId,
  path,
  entries,
  xfer,
  joinRemote,
  onUploaded,
}: Params) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadLocal, setUploadLocal] = useState("");
  const [downloadFor, setDownloadFor] = useState<string | null>(null);
  const [downloadLocal, setDownloadLocal] = useState("");

  // 点击下载：展开下载表单并预填本机下载目录下的同名文件（用 path::join 而非
  // 字符串拼，避免 macOS 上 downloadDir() 末尾无分隔符拼成错路径）。
  const handleDownload = (name: string) => {
    setDownloadFor(name);
    void (async () => {
      try {
        setDownloadLocal(await join(await downloadDir(), name));
      } catch {
        setDownloadLocal(name);
      }
    })();
  };

  const doDownload = async (name: string) => {
    if (!downloadLocal.trim()) {
      toast("请填写本机保存路径", "error");
      return;
    }
    // 进度 / 取消 / 覆盖确认全在 useSshTransfer 里；目标已存在时它会先弹确认框，
    // 确认后重跑，整个流程走完才 resolve——所以这里 await 到的是最终结果。
    const ok = await xfer.download({
      connectionId,
      name,
      remote: joinRemote(path, name),
      local: downloadLocal.trim(),
    });
    if (ok) {
      setDownloadFor(null);
      setDownloadLocal("");
    }
  };

  const doUpload = async () => {
    if (!uploadLocal.trim()) {
      toast("请选择或填写本机文件路径", "error");
      return;
    }
    const base = uploadLocal.trim().replace(/\\/g, "/").split("/").pop() || "file";
    // 重名判定在前端：当前目录的 entries 手里已经有，在后端再查一次
    // 就多一次完整的 ssh 握手。
    const ok = await xfer.upload({
      connectionId,
      name: base,
      local: uploadLocal.trim(),
      remote: joinRemote(path, base),
      remoteExists: entries.some((e) => e.name === base),
    });
    if (ok) {
      setUploadOpen(false);
      setUploadLocal("");
      onUploaded();
    }
  };

  // 用系统文件选择器选本机文件（拿到真实绝对路径，scp 才能读取）。
  const pickUpload = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: "选择要上传的文件",
      });
      if (typeof selected === "string") {
        setUploadLocal(selected);
      }
    } catch {
      /* 用户取消或无选择器权限，忽略 */
    }
  };

  return {
    uploadOpen,
    setUploadOpen,
    uploadLocal,
    setUploadLocal,
    downloadFor,
    setDownloadFor,
    downloadLocal,
    setDownloadLocal,
    handleDownload,
    doDownload,
    doUpload,
    pickUpload,
  };
}
