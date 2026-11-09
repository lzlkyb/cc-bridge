import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "./tauri";

/** 后端 `save_export_text` 允许的后缀（两边必须一致）。 */
export type ExportExt = "csv" | "json" | "md" | "log";

/**
 * 导出文本文件：弹「另存为」→ 后端写盘 → 返回实际路径（用户取消返回 null）。
 *
 * 🔴 不要再用 `<a download>`：WebView2 会把文件静默存进系统「下载」目录、不给路径，
 * 用户只看到「已导出」却找不到文件（2026-11-09 用户反馈）。所有导出都走这里（配置导出
 * 走 `export_config_to_file`），并用 {@link exportedToast} 把路径告诉用户。
 */
export async function saveTextExport(opts: {
  title: string;
  defaultName: string;
  ext: ExportExt;
  filterName: string;
  content: string;
}): Promise<string | null> {
  const target = await save({
    title: opts.title,
    defaultPath: opts.defaultName,
    filters: [{ name: opts.filterName, extensions: [opts.ext] }],
  });
  if (!target) return null;
  return invoke<string>("save_export_text", { path: target, content: opts.content });
}

/** 带路径的成功提示停留更久：用户要看清路径、或者点「在文件夹中显示」。 */
export const EXPORT_TOAST_MS = 10_000;

type ToastFn = (
  message: string,
  variant?: "success" | "error" | "info" | "warning",
  action?: { label: string; onClick: () => void },
  lifetime?: number,
) => void;

/**
 * 导出成功提示：`<message>：<完整路径>` + 「在文件夹中显示」按钮。
 * toast 由调用方传入（lib 不反向依赖 components）。
 */
export function exportedToast(toast: ToastFn, message: string, path: string): void {
  toast(`${message}：${path}`, "success", {
    label: "在文件夹中显示",
    onClick: () => {
      revealItemInDir(path).catch((e) => toast(`打开文件夹失败：${e}`, "error"));
    },
  }, EXPORT_TOAST_MS);
}
