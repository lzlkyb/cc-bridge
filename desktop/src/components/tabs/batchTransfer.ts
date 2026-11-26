import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import { isCancelled, isTargetExists } from "../../lib/sshErrors";
import { joinRemoteDir } from "../../lib/uploadDir";
import type { TransferCore } from "./useTransferCore";
import { queueSshTransfer } from "../../lib/sshTransferQueue";
import { copyUploadName } from "../../lib/sshFilePaths";

/**
 * 批量传输编排：**纯函数**（不持有 React 状态），传输态经 `core` 参数注入。
 *
 * 2026-11-17：批量下载/上传从「N 次单文件 scp」改为「按目录分组的几次多源 scp」
 * （后端 `ssh_batch_cmds.rs`）。批量上传原在 `useSshTransfer.uploadMany` 里，
 * 随本次改造搬来——`useSshTransfer` 已超体量基线，只许变小。
 *
 * 与单文件链路的差异只有三点：
 * 1. 一次 invoke 传全部条目（`items`），后端分组合并；
 * 2. 覆盖确认一次问完（下载由后端预检清单，上传由前端比对新名）；
 * 3. 进度是一个 id 管整批，`index/total` 让 UI 显示「第几个/共几个」。
 */

export interface BatchDownloadItem {
  /** 展示用的文件名。 */
  name: string;
  remote: string;
  /** 本机完整路径（调用方已定好目标目录）。 */
  local: string;
}

/** 「需要问覆盖」的内部信号：不进调用方视野（本模块自己消化确认流程）。 */
const NEED_OVERWRITE = -1;

/**
 * 批量下载。目标已存在且未授权覆盖时，后端返回 `CCB_TARGET_EXISTS`（附清单），
 * 这里弹一次「覆盖 N 个文件」确认，确认后带 `overwrite` 整批重跑。
 */
export async function downloadMany(
  core: TransferCore,
  a: { connectionId: string; dir: string; items: BatchDownloadItem[] },
): Promise<{ done: number; total: number }> {
  const total = a.items.length;
  if (total === 0) return { done: 0, total: 0 };

  const run = async (overwrite: boolean): Promise<{ done: number; total: number }> => {
    const id = core.begin("down", `批量下载 ${total} 个文件`, undefined, total);
    try {
      const done = await queueSshTransfer({ id, connectionId: a.connectionId, direction: "down", label: `批量下载 ${total} 个文件`, target: a.dir, confirmConflict: !overwrite }, () => invoke<number>("ssh_sftp_get_many", {
        connectionId: a.connectionId,
        items: a.items,
        transferId: id,
        overwrite,
      }));
      toast(`已下载 ${done} 个文件到 ${a.dir}`, "success");
      return { done, total };
    } catch (e) {
      if (!overwrite && isTargetExists(e)) {
        // 后端已把「哪些文件已存在」写进错误里；此处只做路由，文案走确认框。
        return { done: NEED_OVERWRITE, total };
      }
      if (!isCancelled(e)) core.report(e, "down", `批量下载 ${total} 个文件`);
      return { done: 0, total };
    } finally {
      core.end();
    }
  };

  const first = await run(false);
  if (first.done !== NEED_OVERWRITE) return first;
  const decision = await core.askOverwrite({
    kind: "down",
    path: a.dir,
    names: a.items.map((i) => i.name),
  });
  if (decision !== "overwrite") return { done: 0, total };
  return run(true);
}

/**
 * 批量上传（拖拽入口 + 文件面板批量）。
 *
 * `existing` 不传时会**先列一次目标目录**：终端拖拽时手里根本没有目标目录的列表，
 * 不补这一次列目录，拖拽上传就是**静默覆盖**远端同名文件；删除有二次确认、
 * 覆盖却悄无声息，两者丢数据的后果是一样的。列目录现在很便宜（helper 常驻会话）。
 */
export async function putMany(
  core: TransferCore,
  a: {
    connectionId: string;
    dir: string;
    files: { local: string; name: string }[];
    existing?: string[];
  },
): Promise<{ done: number; total: number }> {
  const total = a.files.length;
  if (total === 0) return { done: 0, total: 0 };

  let names = a.existing;
  if (names === undefined) {
    try {
      const entries = await invoke<{ name: string }[]>("ssh_sftp_list", {
        connectionId: a.connectionId,
        path: a.dir,
      });
      // 软链条目的 name 带 ` -> target` 后缀，比对前先截掉。
      names = entries.map((e) => e.name.split(" -> ")[0]);
    } catch (e) {
      toast(`目标目录无法访问：${cleanErr(e)}`, "error");
      return { done: 0, total };
    }
  }
  const existingSet = new Set(names);

  // 🔴 同名**一次问完**，不在循环里逐个弹。原来每个同名文件各弹一次，拖 5 个同名
  // 文件就要点 5 次——和「多行粘贴逐个确认」是同一类设计错误：用高频打断去换一个
  // 低频风险。这里给出一次全局选择，循环内不再问。
  //
  // 清单先去重：一次拖入 `a/x.txt` 与 `b/x.txt` 时 base name 相同，重复项会让
  // 对话框列出两个 "x.txt"（React key 冲突）并把数量报成 2。
  const conflicts = [...new Set(a.files.map((f) => f.name).filter((n) => existingSet.has(n)))];
  let skipSet: Set<string> | null = null;
  let keepNames: Set<string> | null = null;
  if (conflicts.length > 0) {
    const decision = await core.askOverwrite({
      kind: "up",
      path: a.dir,
      names: conflicts,
      skippable: true,
    });
    if (decision === "cancel") return { done: 0, total };
    if (decision === "keepBoth") keepNames = new Set(conflicts);
    if (decision === "skip") {
      skipSet = new Set(conflicts);
      // 全部同名且选了跳过 → 一次都不传、done 恒为 0，而调用方是「done>0 才提示」
      // （终端拖拽挂结果条、文件面板只刷新列表）→ 用户点了按钮却什么都没发生。
      // 这里明确交代一句，不让这个分支静默收场。
      if (conflicts.length === total) {
        toast(`已跳过全部 ${total} 个同名文件，未上传`, "info");
      }
    }
  }

  const reserved = new Set<string>();
  const files = a.files.filter(f => !skipSet?.has(f.name)).map(f => {
    const name = keepNames?.has(f.name) || reserved.has(f.name) ? copyUploadName(f.name) : f.name;
    reserved.add(name);
    const overwrite = name === f.name && existingSet.has(name);
    return { local: f.local, remote: joinRemoteDir(a.dir, name), ...(overwrite && { overwrite }) };
  });
  if (files.length === 0) return { done: 0, total };

  const id = core.begin("up", `批量上传 ${files.length} 个文件`, undefined, total);
  try {
    const done = await queueSshTransfer({ id, connectionId: a.connectionId, direction: "up", label: `批量上传 ${files.length} 个文件`, target: a.dir }, () => invoke<number>("ssh_sftp_put_many", {
      connectionId: a.connectionId,
      items: files,
      transferId: id,
    }));
    return { done, total };
  } catch (e) {
    if (!isCancelled(e)) core.report(e, "up", `批量上传 ${files.length} 个文件`);
    return { done: 0, total };
  } finally {
    core.end();
  }
}
