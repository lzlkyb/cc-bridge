import { invoke } from "./tauri";
import { toast } from "../components/ui/toast";

/** 一个待上传的本机文件。 */
export interface LocalFile {
  path: string;
  name: string;
  size: number;
}

/** 后端 `local_path_info` 的返回。 */
interface LocalPathInfo extends LocalFile {
  isDir: boolean;
  exists: boolean;
}

/**
 * 读拖进来的本机路径，筛出**可上传的文件**；文件夹与不存在的路径当场 toast 拒掉。
 *
 * 🔴 为什么要分辨文件夹：`run_scp` 没带 `-r`，直接传目录只会招一句看不懂的
 * scp 错误——假装支持比直说不支持更坏。而 Tauri 的拖放事件只给路径字符串，
 * 前端又没装 `plugin-fs`，所以元数据得走后端的 `local_path_info`。
 *
 * 文件面板与终端两个拖放入口共用本函数，避免两处各写一遍判断。
 */
export async function pickUploadableFiles(paths: string[]): Promise<LocalFile[]> {
  let infos: LocalPathInfo[];
  try {
    infos = await invoke<LocalPathInfo[]>("local_path_info", { paths });
  } catch (e) {
    toast(`读取本机文件失败：${e}`, "error");
    return [];
  }
  const dirs = infos.filter((i) => i.exists && i.isDir);
  const missing = infos.filter((i) => !i.exists);
  if (dirs.length) {
    toast(
      `暂不支持上传文件夹（${dirs.map((d) => d.name).join("、")}），请先打包`,
      "warning",
    );
  }
  if (missing.length) {
    toast(`找不到：${missing.map((m) => m.name).join("、")}`, "error");
  }
  return infos
    .filter((i) => i.exists && !i.isDir)
    .map((f) => ({ path: f.path, name: f.name, size: f.size }));
}
