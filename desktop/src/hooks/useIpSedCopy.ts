import { useCallback } from "react";
import { invoke } from "../lib/tauri";
import { copyText } from "../lib/utils";
import { useToast } from "../components/ui/toast";

/**
 * 「复制 IP 替换命令」的全局入口（2026-10-17）。
 *
 * 背景：此前只有两处能拿到这条 sed——连接页的 IpChangedBanner（可被 × 关掉，
 * 关了无处可复制）和托盘菜单（发现性为零）。用户在终端页 SSH 到远端 AI 时，
 * 要复制命令还得切回连接页。生成逻辑已单一真源化到 Rust `network::ip_sed_for`
 * （`get_ip_sed_command` 命令），本 hook 是两个新入口（S3 全局横幅 / 命令面板）
 * 的共用消费侧：invoke 拿命令 → 写剪贴板 → toast 反馈。
 *
 * 成功走 toast（而非 useCopyFeedback 的按钮内联反馈）：这两个入口都是
 * 「点一下即走」的瞬时动作（横幅按钮无状态、面板执行后关闭），没有可驻留反馈的按钮面。
 */
export function useIpSedCopy(onCopied?: () => void) {
  const { toast } = useToast();
  return useCallback(async () => {
    try {
      const res = await invoke<{ cmd: string; scopeLabel: string }>("get_ip_sed_command");
      if (!res.cmd) {
        toast("通用 MCP 工具没有约定的配置文件，请手动把配置里的地址改成新 IP", "warning");
        return;
      }
      await copyText(
        res.cmd,
        () => {
          toast(`IP 替换命令已复制到剪贴板（${res.scopeLabel}）`, "success");
          // 🔴 必须回传「已复制」（审查 P2）：挂起胶囊与「待处理」横幅靠这个收口。
          // 只在 toast 里报喜的话，用户从全局横幅复制完，顶栏胶囊还挂在那儿，
          // 界面看起来像「命令还没处理」。
          onCopied?.();
        },
        (e) => toast(`复制失败：${e}`, "error"),
      );
    } catch (e) {
      toast(`生成替换命令失败：${String(e)}`, "error");
    }
  }, [toast, onCopied]);
}
