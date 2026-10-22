import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "../ui/toast";
import type { SshFileEntry } from "../../lib/types";
import type { useSshTransfer } from "./useSshTransfer";
import { useSshDownload } from "../../hooks/useSshDownload";

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
 * 与目录浏览和拖拽入口分开，避免在列表组件内混入传输状态。
 * 上传保留原有表单；下载委托原生另存为与可重试的结果状态。
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
  const download = useSshDownload(connectionId, path, xfer.download);

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
    download,
    handleDownload: (name: string) => { void download.start(name); },
    doUpload,
    pickUpload,
  };
}
