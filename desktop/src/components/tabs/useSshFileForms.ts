import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import { remoteFileName } from "../../lib/sshFilePaths";
import type { SshFileEntry } from "../../lib/types";
import type { useSshTransfer } from "./useSshTransfer";
import { useSshDownload } from "../../hooks/useSshDownload";

/** 下载目标目录的记忆键。与 `useSshDownload` 的单文件键同值：两个入口共享一个「上次下载到哪」。 */
const DOWNLOAD_DIR_KEY = "cc-bridge.download-directory";

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

  /**
   * 批量下载：**一次**目录选择 + 一次多源 scp（后端 `ssh_sftp_get_many`）。
   *
   * 为什么是一次目录选择而不是逐个另存为：多源 scp 的 target 是单一目录，
   * 逐个选路径就失去合并成一次握手的意义。目录记忆与单文件下载共用。
   */
  const handleDownloadMany = useCallback(
    async (names: string[]) => {
      if (names.length === 0) return;
      let dir: string | null;
      try {
        let def: string;
        try {
          def = await join(localStorage.getItem(DOWNLOAD_DIR_KEY) || (await downloadDir()), "");
        } catch {
          def = await downloadDir();
        }
        dir = await open({ directory: true, title: `下载 ${names.length} 个文件到`, defaultPath: def });
      } catch (e) {
        toast(`无法选择目录：${cleanErr(e)}`, "error");
        return;
      }
      if (!dir) return;
      try {
        localStorage.setItem(DOWNLOAD_DIR_KEY, dir);
      } catch {
        /* 记忆目录失败不影响本次下载 */
      }
      const items = [];
      for (const n of names) {
        const name = remoteFileName(n);
        items.push({
          name,
          remote: n.startsWith("/") ? n : `${path.replace(/\/$/, "")}/${n}`,
          local: await join(dir, name),
        });
      }
      await xfer.downloadMany({ connectionId, dir, items });
    },
    [connectionId, path, xfer],
  );

  return {
    uploadOpen,
    setUploadOpen,
    uploadLocal,
    setUploadLocal,
    download,
    handleDownload: (name: string) => download.start(name),
    handleDownloadMany,
    doUpload,
    pickUpload,
  };
}
