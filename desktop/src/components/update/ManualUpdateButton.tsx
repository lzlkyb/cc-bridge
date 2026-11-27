import { openUrl } from "@tauri-apps/plugin-opener";
import { APP_INFO } from "../../lib/about";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";

export function officialUpdateUrl(portable?: boolean, version?: string): string {
  const stable = /^v?(\d+\.\d+\.\d+)$/.exec(version ?? "")?.[1];
  if (portable && stable) {
    return `${APP_INFO.repoUrl}/releases/download/v${stable}/cc-bridge_${stable}_x86_64-pc-windows-msvc.zip`;
  }
  return `${APP_INFO.repoUrl}/releases/latest`;
}

export function ManualUpdateButton({ portable, version }: { portable?: boolean; version?: string }) {
  const open = () => void openUrl(officialUpdateUrl(portable, version)).catch(() => {
    toast("无法打开浏览器，请从 GitHub 的 CC Bridge 发布页下载", "error");
  });
  return <Button size="sm" variant="ghost" onClick={open}>{portable ? "下载便携版 ZIP" : "手动下载"}</Button>;
}
